// retell-llm.js
// Retell Custom LLM WebSocket endpoint
// Retell connects here, we call Claude API and stream responses back

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Retell interaction types ─────────────────────────────────────────────────
const RESPONSE_REQUIRED = "response_required";
const REMINDER_REQUIRED = "reminder_required";
const CALL_STARTED = "call_started";
const CALL_ENDED = "call_ended";
const PING_PONG = "ping_pong";

// ─── Register route on your Fastify instance ─────────────────────────────────
// Call this in your main server file:
//   import { registerRetellLLM } from './retell-llm.js'
//   registerRetellLLM(fastify)

export function registerRetellLLM(fastify) {
  fastify.get("/retell-llm/*", { websocket: true }, (socket, req) => {
    console.log("[Retell] Custom LLM connection opened — url:", req.url);

    socket.on("message", async (raw) => {
      console.log("[Retell] Raw message:", raw.toString().substring(0, 300));
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.error("[Retell] Failed to parse message");
        return;
      }

      // ── Ping / pong keepalive ───────────────────────────────────────────
      if (msg.interaction_type === PING_PONG) {
        socket.send(JSON.stringify({ response_type: "ping_pong", timestamp: msg.timestamp }));
        return;
      }

      // ── Call started — optional hook for setup logic ────────────────────
      if (msg.interaction_type === CALL_STARTED) {
        console.log("[Retell] Call started:", msg.call?.call_id);
        return;
      }

      // ── Call ended — cleanup if needed ─────────────────────────────────
      if (msg.interaction_type === CALL_ENDED) {
        console.log("[Retell] Call ended:", msg.call?.call_id);
        return;
      }

      // ── LLM response required ──────────────────────────────────────────
      if (
        msg.interaction_type === RESPONSE_REQUIRED ||
        msg.interaction_type === REMINDER_REQUIRED
      ) {
        await handleLLMResponse(socket, msg);
      }
    });

    socket.on("close", (code, reason) => console.log("[Retell] Connection closed — code:", code, "reason:", reason?.toString()));
    socket.on("error", (err) => console.error("[Retell] WebSocket error:", err));
  });
}

// ─── Core LLM handler ─────────────────────────────────────────────────────────
async function handleLLMResponse(socket, msg) {
  console.log("LLM handler called, interaction type: " + msg.interaction_type);
  const { transcript, call } = msg;
  const metadata = call?.metadata || {};

  // Determine call type from metadata (set when you trigger outbound call)
  const callType = metadata.callType || "cold_call";
  const businessData = metadata.businessData || {};

  // Build system prompt based on call type
  const systemPrompt = buildSystemPrompt(callType, businessData);

  // Convert Retell transcript format → Anthropic messages format
  // Retell: [{ role: "agent"|"user", content: "..." }]
  // Anthropic: [{ role: "assistant"|"user", content: "..." }]
  const responseId = msg.response_id;

  const messages = convertTranscript(transcript);

  // If it's a reminder (agent needs to fill silence), append a nudge
  if (msg.interaction_type === REMINDER_REQUIRED) {
    messages.push({
      role: "user",
      content: "[The prospect has been silent. Continue naturally — ask a gentle follow-up or briefly reiterate your last point.]",
    });
  }

  // Claude requires at least one message — seed first turn with an open prompt
  if (messages.length === 0) {
    messages.push({
      role: "user",
      content: "[Start the call — introduce yourself as Alex from 01 Payments and state your reason for calling.]",
    });
  }

  try {
    console.log("Calling Claude API with " + messages.length + " messages");
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 300,         // Keep responses tight for phone conversation
      system: systemPrompt,
      messages,
    });

    const text = response.content.find(b => b.type === "text")?.text ?? "";

    socket.send(
      JSON.stringify({
        response_id: responseId,
        content: text,
        content_complete: true,
      })
    );

    console.log(`[Retell] Response sent (${text.length} chars)`);
  } catch (err) {
    console.error("[Retell] Claude API error:", err);

    // Graceful fallback — agent stays in character
    socket.send(
      JSON.stringify({
        response_id: responseId,
        content: "Sorry, can you give me just one second?",
        content_complete: true,
      })
    );
  }
}

// ─── Transcript converter ─────────────────────────────────────────────────────
function convertTranscript(transcript = []) {
  return transcript
    .filter((t) => t.content?.trim())
    .map((t) => ({
      role: t.role === "agent" ? "assistant" : "user",
      content: t.content.trim(),
    }));
}

// ─── System prompt builder ────────────────────────────────────────────────────
function buildSystemPrompt(callType, businessData) {
  const base = `You are Alex, a payment consultant calling on behalf of 01 Payments.
Your number is (916) 661-4050.

CORE RULES:
- You are on a LIVE PHONE CALL. Be natural, concise, conversational.
- Max 2-3 sentences per response unless directly asked a question.
- Never read from a script. React to what the prospect says.
- Never mention AI, robot, automated system, or recording.
- If they ask if you're AI: "No, I'm Alex — just calling from 01 Payments."
- Your goal: qualify them and get them to email their processing statement.
- We get paid by processors, not the merchant. Free service for the business.
- Lead with trust, not savings numbers. The pitch is: zero downtime, no contract risk, only stay if you save, we handle everything.
- Do NOT oversell. If they're not a fit, end gracefully.

ABOUT 01 PAYMENTS:
- ISO broker — we shop rates across multiple processors
- We do a free analysis of their current statement and find the best rate available
- Zero downtime switching — they never lose a day of processing
- No contract risk — they only stay if they're actually saving money
- We handle all the paperwork and setup
- No cost, no obligation, no pressure`;

  if (callType === "cold_call") {
    return `${base}

CALL TYPE: Cold outreach
${businessData.businessName ? `BUSINESS: ${businessData.businessName}` : ""}
${businessData.ownerName ? `CONTACT: ${businessData.ownerName}` : ""}
${businessData.posSystem ? `POS SYSTEM: ${businessData.posSystem}` : ""}

OPENER STRATEGY:
- Open by stating your reason for calling IMMEDIATELY on the first response — do not wait to be asked.
- Lead with trust, not savings numbers: "Hey [name], calling from 01 Payments — we help businesses switch processors with zero downtime, no contract risk, and you only stay if you're actually saving money. We handle everything. I just wanted to see if you'd be open to a free review."
- If you know their POS: "A lot of [POS] users we work with didn't realize they could switch without any disruption to their setup."
- Do NOT mention specific savings percentages on the opener — lead with the risk-free process instead
- After the opener, qualify: ask roughly how much they process per month in cards
- Then pivot: offer a free statement review — just email it to alex@01payments.com

QUALIFICATION CRITERIA (good fit):
- $25k+ per month card volume
- On flat rate (Square/Stripe) OR tiered pricing
- Open to a quick review — no commitment

EXIT GRACEFULLY if:
- Under $10k/month ("Honestly might not be worth the paperwork for you")
- Locked into a long-term contract with heavy cancellation fees
- Chain or franchise with centralized payment decisions`;
  }

  if (callType === "follow_up") {
    return `${base}

CALL TYPE: Follow-up — prospect already submitted a statement or showed interest
${businessData.businessName ? `BUSINESS: ${businessData.businessName}` : ""}
${businessData.ownerName ? `CONTACT: ${businessData.ownerName}` : ""}
${businessData.monthlySavings ? `ESTIMATED MONTHLY SAVINGS: ${businessData.monthlySavings}` : ""}
${businessData.currentProcessor ? `CURRENT PROCESSOR: ${businessData.currentProcessor}` : ""}

GOAL: Walk them through the savings, answer objections, move toward signing.

KEY POINTS TO HIT:
- Confirm the savings figure you identified
- Address the switching process (we handle the paperwork)
- Confirm no interruption to their business
- If they're on Clover: reassure them Beacon supports Clover natively
- Close: "Want me to send over the application so we can get you locked in?"`;
  }

  return base;
}
