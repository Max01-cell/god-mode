import 'dotenv/config';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import WebSocket from 'ws';
import twilio from 'twilio';
import { SYSTEM_PROMPT } from './prompt.js';

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
  'wss://api.openai.com/v1/realtime?model=gpt-realtime';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const callLogs = [];

// ── Server ──────────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: true });
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

// ── TwiML helper ─────────────────────────────────────────────────────────────

function streamTwiML() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_URL}/media-stream"/>
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
  reply.type('text/xml').send(streamTwiML());
});

fastify.post('/make-call', async (req, reply) => {
  const { to } = req.body ?? {};
  if (!to) return reply.status(400).send({ error: 'Missing "to" field' });

  const call = await twilioClient.calls.create({
    url: `https://${PUBLIC_URL}/outbound-twiml`,
    to,
    from: TWILIO_PHONE_NUMBER,
    statusCallback: `https://${PUBLIC_URL}/call-status`,
    statusCallbackMethod: 'POST',
  });

  callLogs.push({
    callSid: call.sid,
    direction: 'outbound',
    to,
    timestamp: new Date().toISOString(),
    status: 'initiated',
  });

  reply.send({ callSid: call.sid, status: call.status });
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
  app.get('/media-stream', { websocket: true }, (connection) => {
    const twilioWs = connection.socket;

    let openAiWs = null;
    let streamSid = null;
    let sessionReady = false; // true after session.created + session.update sent

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
              turn_detection: { type: 'server_vad' },
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              voice: 'cedar',
              instructions: SYSTEM_PROMPT,
              modalities: ['text', 'audio'],
              temperature: 0.8,
            },
          }),
        );
        sessionReady = true;
        fastify.log.info('[OpenAI] session.created → session.update sent');
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

      // Optional: send a mark when the AI finishes speaking
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
          fastify.log.info('[Twilio] stream started — streamSid: %s', streamSid);
          break;

        case 'media': {
          // Discard audio that arrives before the OpenAI session is ready;
          // do NOT buffer — just drop so we never replay stale chunks.
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
