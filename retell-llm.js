// retell-llm.js
// Retell Custom LLM WebSocket endpoint
// Retell connects here, we call Claude API and stream responses back

import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function registerRetellLLM(fastify) {
  // Register on base path AND with callId param — Retell appends call ID to URL
  const handler = (connection, req) => {
    const socket = connection.socket ?? connection;
    console.log("[Retell] Custom LLM connection opened — url:", req.url);

    socket.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.error("[Retell] Failed to parse message");
        return;
      }

      console.log("[Retell] Raw message type:", msg.interaction_type);

      // Ping / pong keepalive
      if (msg.interaction_type === "ping_pong") {
        socket.send(JSON.stringify({ response_type: "ping_pong", timestamp: msg.timestamp }));
        return;
      }

      // Call started — Alex speaks first
      if (msg.interaction_type === "call_started") {
        console.log("[Retell] Call started:", msg.call?.call_id);
        const metadata = msg.call?.metadata || {};
        const businessData = metadata.businessData || {};
        const ownerName = businessData.ownerName || "";

        const opener = ownerName
          ? `Hi, is this ${ownerName}? This is Alex calling from zero one payments — do you have about sixty seconds?`
          : `Hi there, this is Alex calling from zero one payments — do you have about sixty seconds?`;

        socket.send(JSON.stringify({
          response_type: "response",
          content: opener,
          content_complete: true,
        }));
        return;
      }

      // Call ended
      if (msg.interaction_type === "call_ended") {
        console.log("[Retell] Call ended:", msg.call?.call_id);
        return;
      }

      // LLM response required or reminder
      if (
        msg.interaction_type === "response_required" ||
        msg.interaction_type === "reminder_required"
      ) {
        await handleLLMResponse(socket, msg);
      }
    });

    socket.on("close", () => console.log("[Retell] Connection closed"));
    socket.on("error", (err) => console.error("[Retell] WebSocket error:", err));
  };

  fastify.get("/retell-llm", { websocket: true }, handler);
  fastify.get("/retell-llm/:callId", { websocket: true }, handler);
}

// ─── Core LLM handler ─────────────────────────────────────────────────────────
async function handleLLMResponse(socket, msg) {
  const { transcript, call } = msg;
  const metadata = call?.metadata || {};
  const callType = metadata.callType || "cold_call";
  const businessData = metadata.businessData || {};

  console.log(`[Retell] LLM handler called — type: ${msg.interaction_type} | callType: ${callType}`);

  const systemPrompt = buildSystemPrompt(callType, businessData);
  const messages = convertTranscript(transcript);

  if (msg.interaction_type === "reminder_required") {
    messages.push({
      role: "user",
      content: "[Silence on the line. Continue naturally — ask a gentle follow-up or briefly reiterate your last point in one sentence.]",
    });
  }

  console.log(`[Retell] Calling Claude with ${messages.length} messages`);

  try {
    const stream = await anthropic.messages.stream({
      model: "claude-sonnet-4-5",
      max_tokens: 300,
      system: systemPrompt,
      messages: messages.length > 0 ? messages : [{ role: "user", content: "Hello?" }],
    });

    let buffer = "";

    for await (const chunk of stream) {
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta?.type === "text_delta"
      ) {
        const text = chunk.delta.text;
        buffer += text;
        socket.send(JSON.stringify({
          response_type: "response",
          content: text,
          content_complete: false,
        }));
      }
    }

    socket.send(JSON.stringify({
      response_type: "response",
      content: "",
      content_complete: true,
    }));

    console.log(`[Retell] Response sent (${buffer.length} chars): ${buffer.slice(0, 80)}...`);
  } catch (err) {
    console.error("[Retell] Claude API error:", err);
    socket.send(JSON.stringify({
      response_type: "response",
      content: "Sorry, give me just one second.",
      content_complete: true,
    }));
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
  const posSystem = businessData.posSystem || "";

  // Determine POS compatibility
  const lockedPOS = ["Toast", "Shopify", "Square", "SpotOn", "Lightspeed", "NCR", "Micros", "Heartland", "Revel"];
  const cloverPOS = ["Clover"];
  const reprogrammablePOS = ["Pax", "Dejavoo", "Verifone", "Ingenico"];

  const isLocked = lockedPOS.some(p => posSystem.toLowerCase().includes(p.toLowerCase()));
  const isClover = cloverPOS.some(p => posSystem.toLowerCase().includes(p.toLowerCase()));
  const isReprogrammable = reprogrammablePOS.some(p => posSystem.toLowerCase().includes(p.toLowerCase()));

  let posNote = "";
  if (isClover) {
    posNote = `They use Clover — reassure them we work with Clover natively through our Beacon processor, no hardware change needed.`;
  } else if (isLocked) {
    posNote = `They use ${posSystem} which is a locked system. Focus only on processing fee savings, not hardware. Do not promise they can keep their exact setup without switching hardware.`;
  } else if (isReprogrammable) {
    posNote = `They use ${posSystem} which can be reprogrammed — no hardware purchase needed, we just reprogram their existing terminal.`;
  } else if (posSystem) {
    posNote = `They use ${posSystem}. Focus on processing fee savings. Hardware compatibility will be confirmed during the statement review.`;
  }

  const base = `You are Alex, a payment consultant calling on behalf of zero one payments.
Your phone number is 916-661-4050.

CRITICAL RULES — PHONE CALL:
- You are on a LIVE PHONE CALL. Be natural, conversational, human.
- Max 2-3 short sentences per response. Never monologue.
- Never read from a script. React to what the prospect says.
- Never mention AI, bot, automated, or recording.
- If asked if you're AI or a robot: say "No, I'm Alex — just calling from zero one payments."
- Always say "zero one payments" never "01 payments".
- Never say dollar signs — say "dollars" out loud.

ABOUT ZERO ONE PAYMENTS:
- We are an ISO broker — we shop rates across multiple processors
- We audit the merchant's current processing statement and find them a lower rate
- Merchants typically save 15 to 30 percent on processing fees
- Completely free service for the merchant — processors pay us, not you
- No obligation to switch after the audit

${posNote}

GOAL: Qualify them and get them to email their processing statement to alex@01payments.com`;

  if (callType === "cold_call") {
    return `${base}

CALL TYPE: Cold outreach
${businessData.businessName ? `BUSINESS: ${businessData.businessName}` : ""}
${businessData.ownerName ? `CONTACT: ${businessData.ownerName}` : ""}
${businessData.posSystem ? `POS SYSTEM: ${businessData.posSystem}` : ""}

FLOW:
1. Confirm you have the right person
2. One sentence pitch: free audit, find out if they're overpaying on card processing
3. Qualify: roughly how much do they process per month in cards?
4. If over 25k/month: ask them to email their statement to alex@01payments.com
5. If under 10k/month: politely exit — "Honestly at that volume it might not be worth the paperwork for you, but keep us in mind as you grow"

OBJECTION HANDLING:
- "Not interested": "Totally fair — can I ask, do you know roughly what you're paying per transaction right now?"
- "I already have a processor": "That's great — we're not asking you to switch, just a free second opinion on your rates. Takes about 60 seconds to send the statement."
- "Send me something in writing": "Absolutely — what's the best email? I'll send our one-pager over."
- "Who are you again?": "Alex from zero one payments — we do free rate audits for businesses to make sure they're not overpaying on card processing."

EXIT GRACEFULLY if:
- Under 10k/month volume
- Hostile or clearly not interested after two attempts`;
  }

  if (callType === "follow_up") {
    return `${base}

CALL TYPE: Follow-up — prospect submitted a statement or showed prior interest
${businessData.businessName ? `BUSINESS: ${businessData.businessName}` : ""}
${businessData.ownerName ? `CONTACT: ${businessData.ownerName}` : ""}
${businessData.monthlySavings ? `ESTIMATED MONTHLY SAVINGS: ${businessData.monthlySavings} dollars` : ""}
${businessData.currentProcessor ? `CURRENT PROCESSOR: ${businessData.currentProcessor}` : ""}

FLOW:
1. Remind them who you are and that they sent their statement
2. Share the savings finding: "Based on your current rates, we found you could save around [savings] dollars per month"
3. Explain the switch: "We handle all the paperwork, your processing never goes down, usually takes about a week"
4. Handle objections
5. Close: "Want me to send over the application so we can lock in those savings?"

OBJECTION HANDLING:
- "How do I know this is real?": "Totally fair — we can do a side-by-side comparison in writing before you commit to anything."
- "I'm in a contract": "How long is left on it? Sometimes the savings are worth the cancellation fee, sometimes they're not — let's run the math."
- "I need to think about it": "Of course — what's the main thing holding you back? I want to make sure I answer any questions."`;
  }

  return base;
}
