import 'dotenv/config';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import WebSocket from 'ws';
import twilio from 'twilio';
import { buildPrompt } from './prompt.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import alawmulaw from 'alawmulaw';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load background ambiance (raw mulaw 8kHz mono) and keep a loop cursor per call
const bgRaw = readFileSync(join(__dirname, 'background.raw'));
const BACKGROUND_VOLUME = 0.04; // 4% — barely audible, just adds room tone

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
    businessDataMap.set(call.sid, business_data);
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
        businessDataMap.set(call.sid, business_data);
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
    let bgCursor         = Math.floor(Math.random() * bgRaw.length); // random start so each call sounds different

    // Called once both OpenAI session.created AND Twilio start have fired.
    // Only then do we have the callSid to look up business data.
    function maybeSendSessionUpdate() {
      if (!openAiCreated || !twilioStarted) return;

      const businessData = businessDataMap.get(callSid) ?? null;
      if (businessData) {
        businessDataMap.delete(callSid);
        console.log('[session] found business_data for callSid', callSid, ':', JSON.stringify(businessData, null, 2));
      } else {
        console.log('[session] no business_data found for callSid', callSid);
      }

      let instructions;
      try {
        instructions = buildPrompt(businessData);
      } catch (err) {
        console.error('[session] buildPrompt error, using default:', err.message);
        instructions = buildPrompt(null);
      }

      console.log('[session] sending session.update — first 500 chars:\n', instructions.slice(0, 500));

      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          turn_detection: {
            type: 'server_vad',
            threshold: 0.7,
            prefix_padding_ms: 300,
            silence_duration_ms: 1500,
          },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: 'cedar',
          instructions,
          modalities: ['text', 'audio'],
          temperature: 0.8,
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

      // Clear any audio buffered before session was ready, then open mic after 2s
      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      setTimeout(() => {
        micEnabled = true;
        fastify.log.info('[session] mic enabled — call ready');
      }, 2000);
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

      if (event.type === 'session.created') {
        fastify.log.info('[OpenAI] session.created received');
        openAiCreated = true;
        maybeSendSessionUpdate();
        return;
      }

      if (event.type === 'response.output_item.added' &&
          event.item?.type === 'function_call' &&
          event.item?.name === 'hang_up_call') {
        fastify.log.info('[OpenAI] hang_up_call triggered — ending call');
        if (callSid) {
          twilioClient.calls(callSid).update({ status: 'completed' }).catch((err) => {
            fastify.log.error('[Twilio] failed to hang up: %s', err.message);
          });
        }
        if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
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
        twilioWs.send(JSON.stringify({
          event: 'mark', streamSid, mark: { name: 'response_done' },
        }));
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
          console.log('[Twilio] start — streamSid:', streamSid, 'callSid:', callSid);
          twilioStarted = true;
          maybeSendSessionUpdate();
          break;

        case 'mark':
          if (msg.mark?.name === 'response_done') {
            setTimeout(() => {
              agentSpeaking = false;
              if (openAiWs?.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
              }
              fastify.log.info('[Twilio] mark ack — mic re-enabled');
            }, 300);
          }
          break;

        case 'media':
          if (!sessionReady || !micEnabled || agentSpeaking) break;
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
      if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
    });

    twilioWs.on('error', (err) => fastify.log.error('[Twilio] WS error: %s', err.message));
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

await fastify.listen({ port: parseInt(PORT, 10), host: '0.0.0.0' });
