// retell-calls.js
// Outbound call triggers via Retell REST API
// Replaces your old /make-call and /follow-up-call Twilio routes

const RETELL_API_BASE = "https://api.retellai.com";
const RETELL_API_KEY = process.env.RETELL_API_KEY;

// Your Retell agent ID — set after creating agent in Retell dashboard
// or via createRetellAgent() below
const AGENT_ID = process.env.RETELL_AGENT_ID;

// ─── Register routes on Fastify instance ─────────────────────────────────────
export function registerRetellCalls(fastify) {

  // ── Cold call ──────────────────────────────────────────────────────────────
  // Body: { toNumber, businessName?, ownerName?, posSystem? }
  fastify.post("/make-call", async (req, reply) => {
    const { toNumber, businessName, ownerName, posSystem } = req.body;

    if (!toNumber) {
      return reply.status(400).send({ error: "toNumber required" });
    }

    try {
      const call = await triggerOutboundCall({
        toNumber: normalizePhone(toNumber),
        callType: "cold_call",
        businessData: { businessName, ownerName, posSystem },
      });

      console.log(`[Retell] Cold call triggered → ${toNumber} | call_id: ${call.call_id}`);
      return reply.send({ success: true, callId: call.call_id });
    } catch (err) {
      console.error("[Retell] Cold call error:", err.message);
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Follow-up call ─────────────────────────────────────────────────────────
  // Body: { toNumber, businessName?, ownerName?, monthlySavings?, currentProcessor? }
  fastify.post("/follow-up-call", async (req, reply) => {
    const { toNumber, businessName, ownerName, monthlySavings, currentProcessor } = req.body;

    if (!toNumber) {
      return reply.status(400).send({ error: "toNumber required" });
    }

    try {
      const call = await triggerOutboundCall({
        toNumber: normalizePhone(toNumber),
        callType: "follow_up",
        businessData: { businessName, ownerName, monthlySavings, currentProcessor },
      });

      console.log(`[Retell] Follow-up call triggered → ${toNumber} | call_id: ${call.call_id}`);
      return reply.send({ success: true, callId: call.call_id });
    } catch (err) {
      console.error("[Retell] Follow-up call error:", err.message);
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── Call status webhook (optional — Retell POSTs here on call events) ──────
  // Configure this URL in Retell dashboard under Webhook settings
  fastify.post("/retell-webhook", async (req, reply) => {
    const event = req.body;
    console.log(`[Retell Webhook] event: ${event.event} | call_id: ${event.data?.call_id}`);

    if (event.event === "call_ended") {
      const { call_id, transcript, call_analysis, metadata } = event.data || event;
      // TODO: save transcript + analysis to your lead record
      // transcript is full text, call_analysis has sentiment/summary
      console.log(`[Retell] Call ended — transcript length: ${transcript?.length || 0} chars`);
    }

    return reply.send({ received: true });
  });
}

// ─── Core outbound call trigger ───────────────────────────────────────────────
async function triggerOutboundCall({ toNumber, callType, businessData }) {
  const res = await fetch(`${RETELL_API_BASE}/v2/create-phone-call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RETELL_API_KEY}`,
    },
    body: JSON.stringify({
      agent_id: AGENT_ID,
      from_number: process.env.TWILIO_PHONE_NUMBER, // +19166614050
      to_number: toNumber,
      // metadata is injected into every Retell WS message → your LLM reads it
      metadata: {
        callType,
        businessData,
      },
      // Optional: override agent settings per call
      // retell_llm_dynamic_variables: {}  // only for Retell-hosted LLM
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Retell API ${res.status}: ${body}`);
  }

  return res.json();
}

// ─── Phone number normalizer ──────────────────────────────────────────────────
// Retell requires E.164 format: +15551234567
function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

// ─── One-time setup: Create the Retell agent via API ─────────────────────────
// Run this once to get your RETELL_AGENT_ID, then store it in Railway env vars
// Usage: node -e "import('./retell-calls.js').then(m => m.createRetellAgent())"
export async function createRetellAgent() {
  const res = await fetch(`${RETELL_API_BASE}/create-agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RETELL_API_KEY}`,
    },
    body: JSON.stringify({
      agent_name: "Alex - 01 Payments",
      voice_id: "11labs-Adrian",        // swap to your preferred ElevenLabs or built-in voice
      response_engine: {
        type: "retell-llm",             // we override this to custom_llm in dashboard
      },
      // These are set in dashboard for custom LLM — just need the agent created
      ambient_sound: "coffee-shop",
      language: "en-US",
      interruption_sensitivity: 0.8,   // slightly tolerant of interruptions
      normalize_for_speech: true,
      end_call_after_silence_ms: 30000, // hang up after 30s silence
      max_call_duration_ms: 600000,     // 10 min max
    }),
  });

  const agent = await res.json();
  console.log("Agent created. Set this as RETELL_AGENT_ID:", agent.agent_id);
  return agent;
}
