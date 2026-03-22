import 'dotenv/config';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import WebSocket from 'ws';
import twilio from 'twilio';
import { buildColdCallPrompt } from './prompts/cold-call.js';
import { buildFollowUpPrompt } from './prompts/follow-up.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import alawmulaw from 'alawmulaw';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load background ambiance (raw mulaw 8kHz mono) and keep a loop cursor per call
const bgRaw = readFileSync(join(__dirname, 'background.raw'));
const BACKGROUND_VOLUME = 0.0; // disabled — background audio echoes back through phone mic and triggers VAD false positives

function mixBackground(base64Chunk, bgCursor) {
  const signal = Buffer.from(base64Chunk, 'base64');
  const len = signal.length;

  // Decode both buffers to 16-bit PCM
  const signalPcm = alawmulaw.mulaw.decode(signal);
  const bgSlice = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    bgSlice[i] = bgRaw[(bgCursor + i) % bgRaw.length];
  }
  const bgPcm = alawmulaw.mulaw.decode(bgSlice);

  // Mix: full signal + attenuated background, clamp to int16 range
  const mixed = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    mixed[i] = Math.max(-32768, Math.min(32767,
      Math.round(signalPcm[i] + bgPcm[i] * BACKGROUND_VOLUME)
    ));
  }

  const mixedBuf = alawmulaw.mulaw.encode(mixed);
  return {
    payload: Buffer.from(mixedBuf).toString('base64'),
    nextCursor: (bgCursor + len) % bgRaw.length,
  };
}

const {
  OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PUBLIC_URL,
  PORT = '3000',
} = process.env;

if (!OPENAI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !PUBLIC_URL) {
  console.error('Missing required environment variables. Check your .env file.');
  process.exit(1);
}

const OPENAI_REALTIME_URL =
  'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const callLogs = [];

// Business data keyed by callSid — populated in /make-call, consumed on Twilio "start" event
const businessDataMap = new Map();

// ── Server ───────────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: true });
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

// ── TwiML helper ──────────────────────────────────────────────────────────────

function streamTwiML() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_URL}/media-stream"/>
  </Connect>
</Response>`;
}

// ── HTTP endpoints ────────────────────────────────────────────────────────────

fastify.post('/incoming-call', async (req, reply) => {
  const callSid = req.body?.CallSid ?? 'unknown';
  callLogs.push({ callSid, direction: 'inbound', timestamp: new Date().toISOString(), status: 'started' });
  reply.type('text/xml').send(streamTwiML());
});

fastify.post('/outbound-twiml', async (req, reply) => {
  reply.type('text/xml').send(streamTwiML());
});

fastify.post('/make-call', async (req, reply) => {
  const { to, business_data } = req.body ?? {};
  if (!to) return reply.status(400).send({ error: 'Missing "to" field' });

  console.log('[make-call] business_data received:', JSON.stringify(business_data, null, 2));

  const call = await twilioClient.calls.create({
    url: `https://${PUBLIC_URL}/outbound-twiml`,
    to,
    from: TWILIO_PHONE_NUMBER,
    statusCallback: `https://${PUBLIC_URL}/call-status`,
    statusCallbackMethod: 'POST',
  });

  console.log('[make-call] callSid:', call.sid);

  if (business_data && Object.keys(business_data).length > 0) {
    businessDataMap.set(call.sid, { callType: 'cold', businessData: business_data, savingsData: null });
    console.log('[make-call] stored business_data in map for callSid:', call.sid);
  }

  callLogs.push({
    callSid: call.sid,
    direction: 'outbound',
    to,
    business_name: business_data?.business_name ?? null,
    owner_name: business_data?.owner_name ?? null,
    timestamp: new Date().toISOString(),
    status: 'initiated',
  });

  reply.send({ callSid: call.sid, status: call.status });
});

fastify.post('/follow-up-call', async (req, reply) => {
  const { to, business_data, savings_data } = req.body ?? {};
  if (!to) return reply.status(400).send({ error: 'Missing "to" field' });
  if (!savings_data) return reply.status(400).send({ error: 'Missing "savings_data" field' });

  console.log('[follow-up-call] business_data:', JSON.stringify(business_data, null, 2));
  console.log('[follow-up-call] savings_data:', JSON.stringify(savings_data, null, 2));

  const call = await twilioClient.calls.create({
    url: `https://${PUBLIC_URL}/outbound-twiml`,
    to,
    from: TWILIO_PHONE_NUMBER,
    statusCallback: `https://${PUBLIC_URL}/call-status`,
    statusCallbackMethod: 'POST',
  });

  console.log('[follow-up-call] callSid:', call.sid);

  businessDataMap.set(call.sid, { callType: 'follow-up', businessData: business_data ?? {}, savingsData: savings_data });
  console.log('[follow-up-call] stored in map — callSid:', call.sid, '| callType: follow-up | map size now:', businessDataMap.size);
  console.log('[follow-up-call] map entry:', JSON.stringify(businessDataMap.get(call.sid), null, 2));

  callLogs.push({
    callSid: call.sid,
    direction: 'outbound',
    type: 'follow-up',
    to,
    business_name: business_data?.business_name ?? null,
    owner_name: business_data?.owner_name ?? null,
    timestamp: new Date().toISOString(),
    status: 'initiated',
  });

  reply.send({ callSid: call.sid, status: call.status });
});

fastify.post('/batch-call', async (req, reply) => {
  const { calls } = req.body ?? {};
  if (!Array.isArray(calls) || calls.length === 0) {
    return reply.status(400).send({ error: '"calls" must be a non-empty array' });
  }

  const results = [];
  for (const item of calls) {
    const { to, business_data } = item;
    if (!to) { results.push({ to, error: 'Missing "to" field' }); continue; }

    try {
      const call = await twilioClient.calls.create({
        url: `https://${PUBLIC_URL}/outbound-twiml`,
        to,
        from: TWILIO_PHONE_NUMBER,
        statusCallback: `https://${PUBLIC_URL}/call-status`,
        statusCallbackMethod: 'POST',
      });

      if (business_data && Object.keys(business_data).length > 0) {
        businessDataMap.set(call.sid, { callType: 'cold', businessData: business_data, savingsData: null });
      }

      callLogs.push({
        callSid: call.sid, direction: 'outbound', to,
        business_name: business_data?.business_name ?? null,
        owner_name: business_data?.owner_name ?? null,
        timestamp: new Date().toISOString(), status: 'initiated',
      });

      results.push({ to, callSid: call.sid, status: call.status });
    } catch (err) {
      results.push({ to, error: err.message });
    }
  }

  reply.send({ results });
});

fastify.post('/call-status', async (req, reply) => {
  const { CallSid, CallStatus } = req.body ?? {};
  const entry = callLogs.find((l) => l.callSid === CallSid);
  if (entry) entry.status = CallStatus;
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    businessDataMap.delete(CallSid);
  }
  reply.send({ ok: true });
});

fastify.get('/logs', async (_req, reply) => reply.send(callLogs));

// ── WebSocket media-stream handler ────────────────────────────────────────────

fastify.register(async (app) => {
  app.get('/media-stream', { websocket: true }, (connection) => {
    const twilioWs = connection.socket;

    let openAiWs         = null;
    let streamSid        = null;
    let callSid          = null;
    let sessionReady     = false; // true after session.update is sent to OpenAI
    let openAiCreated    = false; // true after session.created received from OpenAI
    let twilioStarted    = false; // true after "start" event received from Twilio
    let agentSpeaking    = false;
    let micEnabled       = false;
    let speechDetected   = false; // set true on first VAD speech_started event
    let lastAgentSpokeAt = 0;    // timestamp when mic was last re-enabled after agent speech
    let hangUpPending       = false; // true after hang_up_call fires; actual hang-up deferred until audio done
    let currentResponseItemId = null; // item_id of the assistant message currently being generated
    let responseAudioStartMs  = null; // when current response audio started, for truncation
    let bgCursor           = Math.floor(Math.random() * bgRaw.length); // random start so each call sounds different
    let silenceTimer     = null; // fires "hello?" after long mid-conversation silence

    const SILENCE_CHECK_MS = 20000; // 20s of no human speech → check in

    function resetSilenceWatcher() {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (!speechDetected) return; // only watch after conversation has started
      silenceTimer = setTimeout(() => {
        if (!agentSpeaking && openAiWs?.readyState === WebSocket.OPEN) {
          fastify.log.info('[silence] 20s of silence — checking in');
          openAiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              instructions: 'Say only "Hello?" or "You still there?" — one short phrase to check if they\'re still on the line. Nothing else.',
            },
          }));
        }
      }, SILENCE_CHECK_MS);
    }

    // Called once both OpenAI session.created AND Twilio start have fired.
    // Only then do we have the callSid to look up business data.
    function maybeSendSessionUpdate() {
      if (!openAiCreated || !twilioStarted) return;

      const callEntry = businessDataMap.get(callSid) ?? null;
      console.log('[session] maybeSendSessionUpdate — callSid:', callSid, '| entry found:', !!callEntry);
      if (callEntry) {
        businessDataMap.delete(callSid);
        console.log('[session] callType from map:', callEntry.callType);
        console.log('[session] businessData:', JSON.stringify(callEntry.businessData));
        console.log('[session] savingsData:', JSON.stringify(callEntry.savingsData));
      } else {
        console.log('[session] WARNING: no call data found for callSid', callSid, '— falling back to cold call prompt');
      }

      const { callType = 'cold', businessData = null, savingsData = null } = callEntry ?? {};
      console.log('[session] resolved callType:', callType);

      let instructions;
      try {
        if (callType === 'follow-up') {
          console.log('[session] LOADING: follow-up prompt');
          instructions = buildFollowUpPrompt(businessData, savingsData);
        } else {
          console.log('[session] LOADING: cold-call prompt');
          instructions = buildColdCallPrompt(businessData);
        }
      } catch (err) {
        console.error('[session] buildPrompt error, using cold-call default:', err.message);
        instructions = buildColdCallPrompt(null);
      }

      console.log('[session] instructions first 200 chars:', instructions.slice(0, 200));

      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          turn_detection: {
            type: 'server_vad',
            threshold: 0.75,
            prefix_padding_ms: 300,
            silence_duration_ms: 800,
          },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: 'cedar',
          instructions,
          modalities: ['text', 'audio'],
          temperature: 0.8,
          input_audio_transcription: null, // disable transcription to save tokens
          tools: [
            {
              type: 'function',
              name: 'hang_up_call',
              description: 'End the phone call. Call this when the conversation is complete — after a goodbye, after the prospect says not interested, or after getting their email.',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          ],
          tool_choice: 'auto',
        },
      }));

      sessionReady = true;

      // Clear any audio buffered before session was ready, then open mic after 500ms
      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      setTimeout(() => {
        micEnabled = true;
        fastify.log.info('[session] mic enabled — call ready');

        // If nobody has spoken after 5 seconds, agent says hello first
        setTimeout(() => {
          if (!speechDetected && !agentSpeaking && openAiWs?.readyState === WebSocket.OPEN) {
            fastify.log.info('[session] no speech after 5s — triggering greeting');
            openAiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                instructions: 'Say only a single casual greeting — "Hey." or "Hello." — nothing else. One word or two max. Then stop and wait for them to speak.',
              },
            }));
          }
        }, 5000);
      }, 500);
    }

    // ── OpenAI Realtime connection ───────────────────────────────────────────

    openAiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    openAiWs.on('open', () => {
      fastify.log.info('[OpenAI] connected — waiting for session.created and Twilio start');
    });

    openAiWs.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw); } catch { return; }

      // Log every VAD and response lifecycle event for debugging
      if ([
        'input_audio_buffer.speech_started',
        'input_audio_buffer.speech_stopped',
        'input_audio_buffer.committed',
        'response.created',
        'response.cancelled',
        'response.done',
        'response.audio.done',
      ].includes(event.type)) {
        console.log(`[OpenAI event] ${event.type} | agentSpeaking=${agentSpeaking} | streamSid=${streamSid}`);
      }

      if (event.type === 'session.created') {
        fastify.log.info('[OpenAI] session.created received');
        openAiCreated = true;
        maybeSendSessionUpdate();
        return;
      }

      if (event.type === 'response.output_item.added') {
        if (event.item?.type === 'function_call' && event.item?.name === 'hang_up_call') {
          fastify.log.info('[OpenAI] hang_up_call detected — will hang up after goodbye audio plays');
          hangUpPending = true;
        } else if (event.item?.type === 'message') {
          // Track item id so we can truncate it if the caller interrupts
          currentResponseItemId = event.item.id;
          responseAudioStartMs  = Date.now();
        }
        return;
      }

      if (event.type === 'response.done' && event.response?.usage) {
        const { input_tokens, output_tokens, total_tokens } = event.response.usage;
        console.log(`[tokens] input=${input_tokens} output=${output_tokens} total=${total_tokens}`);
        return;
      }

      if (event.type === 'response.audio.delta' && event.delta && streamSid) {
        agentSpeaking = true;
        const { payload, nextCursor } = mixBackground(event.delta, bgCursor);
        bgCursor = nextCursor;
        twilioWs.send(JSON.stringify({
          event: 'media', streamSid, media: { payload },
        }));
        return;
      }

      // Agent done generating — send mark; mic re-opens when Twilio echoes it back
      if (event.type === 'response.audio.done' && streamSid) {
        currentResponseItemId = null;
        responseAudioStartMs  = null;
        twilioWs.send(JSON.stringify({
          event: 'mark', streamSid, mark: { name: 'response_done' },
        }));
        return;
      }

      if (event.type === 'input_audio_buffer.speech_started') {
        const msSinceAgentSpoke = Date.now() - lastAgentSpokeAt;

        if (agentSpeaking) {
          // ── Real interruption: caller spoke while agent was talking ──────────
          console.log('INTERRUPTION: cleared audio and cancelled response');

          // 1. Clear Twilio playback queue immediately so caller hears silence
          if (streamSid) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
          }

          // 2. Cancel the in-progress OpenAI response
          if (openAiWs?.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));

            // 3. Truncate the last assistant item so the model knows it was cut off
            if (currentResponseItemId && responseAudioStartMs) {
              const audioEndMs = Date.now() - responseAudioStartMs;
              openAiWs.send(JSON.stringify({
                type: 'conversation.item.truncate',
                item_id: currentResponseItemId,
                content_index: 0,
                audio_end_ms: audioEndMs,
              }));
            }
          }

          agentSpeaking = false;
          currentResponseItemId = null;
          responseAudioStartMs  = null;
          speechDetected = true;
          resetSilenceWatcher();
          return;
        }

        if (msSinceAgentSpoke < 2500) {
          // Agent just finished — likely echo tail, not human speech
          fastify.log.info('[VAD] speech_started suppressed (%dms after agent finished)', msSinceAgentSpoke);
          if (openAiWs?.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
          }
          return;
        }

        speechDetected = true;
        resetSilenceWatcher(); // reset 20s timer on every real human utterance
        return;
      }

      if (event.type === 'error') {
        fastify.log.error('[OpenAI] error: %o', event.error);
      }
    });

    openAiWs.on('error', (err) => fastify.log.error('[OpenAI] WS error: %s', err.message));
    openAiWs.on('close', (code) => fastify.log.info('[OpenAI] WS closed (code %d)', code));

    // ── Twilio Media Stream messages ─────────────────────────────────────────

    twilioWs.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.event) {
        case 'connected':
          fastify.log.info('[Twilio] media stream connected');
          break;

        case 'start':
          streamSid = msg.start.streamSid;
          callSid   = msg.start.callSid;
          console.log('[Twilio] start — streamSid:', streamSid, '| callSid:', callSid);
          console.log('[Twilio] start — map lookup result:', JSON.stringify(businessDataMap.get(callSid)));
          twilioStarted = true;
          maybeSendSessionUpdate();
          break;

        case 'mark':
          if (msg.mark?.name === 'response_done') {
            setTimeout(() => {
              agentSpeaking = false;
              lastAgentSpokeAt = Date.now();
              if (openAiWs?.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
              }
              resetSilenceWatcher(); // start 20s countdown from when agent finished speaking
              fastify.log.info('[Twilio] mark ack — mic re-enabled');

              // Deferred hang-up: goodbye audio has now finished playing
              if (hangUpPending) {
                fastify.log.info('[hangup] goodbye audio done — ending call');
                if (callSid) {
                  twilioClient.calls(callSid).update({ status: 'completed' }).catch((err) => {
                    fastify.log.error('[Twilio] failed to hang up: %s', err.message);
                  });
                }
                if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
              }
            }, 300);
          }
          break;

        case 'media':
          // Always forward audio to OpenAI — server_vad needs it even while agent is speaking
          // so it can detect interruptions and fire speech_started
          if (!sessionReady || !micEnabled) break;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload,
            }));
          }
          break;

        case 'stop':
          fastify.log.info('[Twilio] stream stopped');
          if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
          break;
      }
    });

    twilioWs.on('close', () => {
      fastify.log.info('[Twilio] WS closed');
      if (silenceTimer) clearTimeout(silenceTimer);
      if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
    });

    twilioWs.on('error', (err) => fastify.log.error('[Twilio] WS error: %s', err.message));
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

await fastify.listen({ port: parseInt(PORT, 10), host: '0.0.0.0' });
