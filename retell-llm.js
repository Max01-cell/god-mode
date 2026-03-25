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

      // Call started — send opener immediately so Alex speaks first
      if (msg.interaction_type === "call_started") {
        console.log("[Retell] Call started:", msg.call?.call_id);
        const ownerName = msg.call?.metadata?.businessData?.ownerName || "";
        const opener = ownerName
          ? `Hey, is this ${ownerName}?`
          : `Hey, how's it going?`;
        socket.send(JSON.stringify({
          response_type: "response",
          response_id: msg.response_id,
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

  // If transcript is empty and this isn't a reminder, opener was already sent on call_started — skip
  if (messages.length === 0 && msg.interaction_type !== "reminder_required") {
    console.log("[Retell] Empty transcript on response_required — opener already sent, skipping");
    return;
  }

  if (msg.interaction_type === "reminder_required") {
    messages.push({
      role: "user",
      content: "[Silence on the line. Say something brief to keep the conversation going.]",
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

        // Flush at sentence endings only — avoids choppy TTS on commas
        if (/[.!?]/.test(text)) {
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

  const coldCallContext = callType === "cold_call" ? `
You're making a cold call${businessData.businessName ? ` to ${businessData.businessName}` : ""}${businessData.ownerName ? ` — you're trying to reach ${businessData.ownerName}` : ""}. If someone else answers, just ask for the owner or whoever handles the finances. Don't pitch to employees. If the owner isn't available, get a good callback time and leave your name. Once you're with the owner, find out roughly how much they do in card volume per month. If it's over 25 thousand, ask them to email their processing statement to alex at 01 payments dot com. If it's under 10 thousand, be straight with them — it probably won't be worth it at that volume, but keep you in mind.${posNote ? " " + posNote : ""}` : "";

  const followUpContext = callType === "follow_up" ? `
You're following up${businessData.businessName ? ` with ${businessData.businessName}` : ""}${businessData.ownerName ? ` — ${businessData.ownerName}` : ""} who already sent in their processing statement.${businessData.monthlySavings ? ` Your analysis found they could save around ${businessData.monthlySavings} dollars per month.` : ""}${businessData.currentProcessor ? ` They're currently with ${businessData.currentProcessor}.` : ""} Remind them who you are, share what you found, explain that zero one handles all the paperwork and their processing never goes down during the switch. Close by asking if they want you to send the application over.` : "";

  return `You are Alex, a payment consultant calling on behalf of zero one payments. You're relaxed, warm, and you don't over-explain things. You respond to what the person actually says — you don't follow a script.

Respond in one or two short sentences. That's it. Don't summarize, don't list things, don't explain more than what was asked. If there's a natural pause, let it be there.

Always say "zero one payments" — never "01 payments". Say numbers as words, not symbols.

Here's what you do: zero one payments is a free service that audits a merchant's card processing statement and finds them a lower rate. You shop across multiple processors. Most businesses save somewhere between 15 and 30 percent. The merchant pays nothing — processors pay your side. There's no obligation to switch.

If someone asks whether you're AI, be honest about it — something like "Yeah I am, but the analysis is real. I can go through a statement and find exactly what someone's overpaying faster than any person could. The zero one team handles everything after that." Say it once, don't bring it up again unless asked. Once someone's clearly interested, you can mention it naturally as a reason the service works so well.
${coldCallContext}${followUpContext}`;
}
