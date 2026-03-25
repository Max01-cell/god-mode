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

      // Call started — log only, response handled by response_required
      if (msg.interaction_type === "call_started") {
        console.log("[Retell] Call started:", msg.call?.call_id);
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
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: systemPrompt,
      messages: messages.length > 0 ? messages : [{ role: "user", content: "Hello?" }],
    });

    let buffer = "";
    let pending = "";

    for await (const chunk of stream) {
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta?.type === "text_delta"
      ) {
        const text = chunk.delta.text;
        buffer += text;
        pending += text;

        // Flush at sentence/clause boundaries so TTS gets complete phrases
        if (/[.!?,;]/.test(text)) {
          socket.send(JSON.stringify({
            response_type: "response",
            response_id: msg.response_id,
            content: pending,
            content_complete: false,
          }));
          pending = "";
        }
      }
    }

    // Flush any remaining text
    if (pending) {
      socket.send(JSON.stringify({
        response_type: "response",
        response_id: msg.response_id,
        content: pending,
        content_complete: false,
      }));
    }

    socket.send(JSON.stringify({
      response_type: "response",
      response_id: msg.response_id,
      content: "",
      content_complete: true,
    }));

    console.log(`[Retell] Response sent (${buffer.length} chars): ${buffer.slice(0, 80)}...`);
  } catch (err) {
    console.error("[Retell] Claude API error:", err);
    socket.send(JSON.stringify({
      response_type: "response",
      response_id: msg.response_id,
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

  const base = `You are Alex, calling on behalf of zero one payments. You're easygoing, direct, and good at reading people. You don't pitch — you have conversations.

Keep your responses short. One or two sentences, three at most. Never speak in lists. Never explain everything at once. Let the conversation breathe.

Say "zero one payments", never "01 payments". Say dollar amounts as words.

Zero one payments is a free rate audit service. You're an ISO broker — you look at a merchant's current processing statement and find them a lower rate by shopping across multiple processors. Most businesses save 15 to 30 percent. It costs the merchant nothing. Processors pay your side. No obligation to switch.

If someone asks if you're AI: be honest, keep it casual. Something like "Yeah, I am. But the analysis is real — I can go through a processing statement faster than any human and find exactly where they're overpaying. The zero one team handles the rest." Don't dwell on it. Move on.

Once someone's clearly interested, let them know naturally — "Oh, and heads up, I'm an AI — that's kind of why this works, I can crunch the numbers instantly. A real person from zero one will follow up with you."

${posNote}

Your goal is to qualify them and get them to send their processing statement to alex@01payments.com`;

  if (callType === "cold_call") {
    return `${base}

${businessData.businessName ? `Business: ${businessData.businessName}` : ""}
${businessData.ownerName ? `Owner: ${businessData.ownerName}` : ""}
${businessData.posSystem ? `POS: ${businessData.posSystem}` : ""}

If someone other than the owner picks up, don't pitch. Just ask if the owner's around. If not, ask when's a good time to reach them and leave your name and what it's about — "card processing rates". Be friendly, keep it short.

Once you're talking to the owner: confirm you have the right person, give them a one-line reason you called, ask roughly how much they do in card volume per month. If it's over 25k, ask them to forward their processing statement to alex@01payments.com. If it's under 10k, be straight with them — it probably won't move the needle enough to be worth their time, but to keep you in mind.

If they say they're not interested: ask if they know what they're currently paying per transaction. Most people don't.
If they say they already have a processor: you're not asking them to switch, just offering a free second opinion.
If they want something in writing: get their email and send it.`;
  }

  if (callType === "follow_up") {
    return `${base}

${businessData.businessName ? `Business: ${businessData.businessName}` : ""}
${businessData.ownerName ? `Owner: ${businessData.ownerName}` : ""}
${businessData.monthlySavings ? `Estimated monthly savings: ${businessData.monthlySavings} dollars` : ""}
${businessData.currentProcessor ? `Current processor: ${businessData.currentProcessor}` : ""}

Remind them who you are and that they sent their statement. Tell them what you found — how much they could save per month. Explain the switch is handled entirely by zero one, processing never goes down, usually done in about a week. Close by asking if they want you to send over the application.

If they're skeptical: offer a side-by-side comparison in writing before they commit to anything.
If they're in a contract: ask how long is left — sometimes the savings cover the cancellation fee, sometimes they don't. Run the math with them.
If they need to think: ask what's holding them back.`;
  }

  return base;
}
