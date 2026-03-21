import 'dotenv/config';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import WebSocket from 'ws';
import twilio from 'twilio';
import { buildPrompt } from './prompt.js';

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

// Most recent business data — set by /make-call, consumed by the next WebSocket connection.
let latestBusinessData = null;

// ── Server ──────────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: true });
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

// ── TwiML helper ─────────────────────────────────────────────────────────────

function streamTwiML(callSid) {
  const url = callSid
    ? `wss://${PUBLIC_URL}/media-stream?callSid=${callSid}`
    : `wss://${PUBLIC_URL}/media-stream`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${url}"/>
  </Connect>
</Response>`;
}

// ── HTTP endpoints ───────────────────────────────────────────────────────────

fastify.post('/incoming-call', async (req, reply) => {
  const callSid = req.body?.CallSid ?? 'unknown';
  callLogs.push({
    callSid,
    direction: 'inbound',
    timestamp: new Date().toISOString(),
    status: 'started',
  });
  reply.type('text/xml').send(streamTwiML());
});

fastify.post('/outbound-twiml', async (req, reply) => {
  const callSid = req.body?.CallSid;
  reply.type('text/xml').send(streamTwiML(callSid));
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

  console.log('[make-call] callSid assigned:', call.sid);

  latestBusinessData = (business_data && Object.keys(business_data).length > 0) ? business_data : null;
  console.log('[make-call] latestBusinessData set:', JSON.stringify(latestBusinessData, null, 2));

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
    if (!to) {
      results.push({ to, error: 'Missing "to" field' });
      continue;
    }

    try {
      const call = await twilioClient.calls.create({
        url: `https://${PUBLIC_URL}/outbound-twiml`,
        to,
        from: TWILIO_PHONE_NUMBER,
        statusCallback: `https://${PUBLIC_URL}/call-status`,
        statusCallbackMethod: 'POST',
      });

      latestBusinessData = (business_data && Object.keys(business_data).length > 0) ? business_data : null;

      callLogs.push({
        callSid: call.sid,
        direction: 'outbound',
        to,
        business_name: business_data?.business_name ?? null,
        owner_name: business_data?.owner_name ?? null,
        timestamp: new Date().toISOString(),
        status: 'initiated',
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
  reply.send({ ok: true });
});

fastify.get('/logs', async (_req, reply) => {
  reply.send(callLogs);
});

// ── WebSocket media-stream handler ───────────────────────────────────────────

fastify.register(async (app) => {
  app.get('/media-stream', { websocket: true }, (connection, req) => {
    const twilioWs = connection.socket;

    // Consume the latest business data and immediately clear it
    const businessData = latestBusinessData;
    latestBusinessData = null;
    console.log('[media-stream] businessData consumed:', JSON.stringify(businessData, null, 2));

    let sessionInstructions;
    try {
      sessionInstructions = buildPrompt(businessData);
      console.log('[media-stream] first 500 chars of instructions:\n', sessionInstructions.slice(0, 500));
    } catch (err) {
      console.error('[media-stream] buildPrompt failed, falling back to default prompt:', err.message);
      sessionInstructions = buildPrompt(null);
    }

    let openAiWs = null;
    let streamSid = null;
    let callSid = null;
    let sessionReady = false;

    // ── OpenAI Realtime connection ──────────────────────────────────────────

    openAiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    openAiWs.on('open', () => {
      fastify.log.info('[OpenAI] WebSocket connected — waiting for session.created');
      // Do NOT send session.update here; wait for session.created event.
    });

    openAiWs.on('message', (raw) => {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }

      // Configure session only after server confirms it was created
      if (event.type === 'session.created') {
        openAiWs.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              turn_detection: {
                type: 'server_vad',
                threshold: 0.6,           // higher = less sensitive, fewer false triggers
                prefix_padding_ms: 300,
                silence_duration_ms: 1000, // wait 1s of silence before ending a turn
              },
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              voice: 'cedar',
              instructions: sessionInstructions,
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
          }),
        );
        sessionReady = true;
        fastify.log.info('[OpenAI] session.created → session.update sent');
        return;
      }

      // Handle hang_up_call tool invocation
      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call' && event.item?.name === 'hang_up_call') {
        fastify.log.info('[OpenAI] hang_up_call triggered — ending call');
        if (callSid) {
          twilioClient.calls(callSid).update({ status: 'completed' }).catch((err) => {
            fastify.log.error('[Twilio] failed to hang up call: %s', err.message);
          });
        }
        if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
        return;
      }

      // Log token usage after each response
      if (event.type === 'response.done' && event.response?.usage) {
        const { input_tokens, output_tokens, total_tokens } = event.response.usage;
        console.log(`[tokens] input=${input_tokens} output=${output_tokens} total=${total_tokens}`);
        return;
      }

      // Forward audio deltas back to Twilio
      if (event.type === 'response.audio.delta' && event.delta && streamSid) {
        twilioWs.send(
          JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: event.delta },
          }),
        );
        return;
      }

      // Send a mark when the AI finishes speaking
      if (event.type === 'response.audio.done' && streamSid) {
        twilioWs.send(
          JSON.stringify({ event: 'mark', streamSid, mark: { name: 'response_done' } }),
        );
        return;
      }

      if (event.type === 'error') {
        fastify.log.error('[OpenAI] error event: %o', event.error);
      }
    });

    openAiWs.on('error', (err) => {
      fastify.log.error('[OpenAI] WebSocket error: %s', err.message);
    });

    openAiWs.on('close', (code) => {
      fastify.log.info('[OpenAI] WebSocket closed (code %d)', code);
    });

    // ── Twilio Media Stream messages ────────────────────────────────────────

    twilioWs.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.event) {
        case 'connected':
          fastify.log.info('[Twilio] media stream connected');
          break;

        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          fastify.log.info('[Twilio] stream started — streamSid: %s callSid: %s', streamSid, callSid);
          break;

        case 'media': {
          // Discard audio before the OpenAI session is ready — do NOT buffer.
          if (!sessionReady) break;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: msg.media.payload,
              }),
            );
          }
          break;
        }

        case 'stop':
          fastify.log.info('[Twilio] stream stopped');
          if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
          break;

        default:
          break;
      }
    });

    twilioWs.on('close', () => {
      fastify.log.info('[Twilio] WebSocket closed');
      if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.close();
    });

    twilioWs.on('error', (err) => {
      fastify.log.error('[Twilio] WebSocket error: %s', err.message);
    });
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

await fastify.listen({ port: parseInt(PORT, 10), host: '0.0.0.0' });
