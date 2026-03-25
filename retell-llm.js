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

  const base = `You are Alex, a payment consultant calling on behalf of zero one payments.
Your phone number is 916-661-4050.

HOW TO SPEAK:
- This is a real phone call. Talk like a person, not a script.
- Short responses only — 1 to 3 sentences max. Never monologue.
- Use natural spoken language: contractions, casual phrasing, light filler words like "yeah", "totally", "honestly", "look" when it fits.
- Vary your sentence length. Don't always speak in the same rhythm.
- React to what they actually said. Don't barrel through a script.
- Never read bullet points out loud. Internalize the info and say it naturally.
- Always say "zero one payments" — never "01 payments".
- Say amounts as words — "twenty five thousand dollars", not "$25,000".

AI DISCLOSURE:
- If asked directly whether you're AI: be honest and unfazed — "Yeah, I am — I'm an AI. But everything behind it is real. The analysis, the savings, the team that follows up."
- Once someone is clearly interested or asking follow-up questions: naturally drop it in — "Oh, and just so you know — I'm an AI. Honestly that's kind of the point, I can pull apart a processing statement and find what you're overpaying faster than any human. The zero one team just gets the results."
- Say it like it's not a big deal. Because it isn't.

ABOUT ZERO ONE PAYMENTS:
- ISO broker — we shop rates across multiple processors on your behalf
- We look at your current statement and find you a lower rate
- Most merchants save somewhere between 15 and 30 percent on processing fees
- Completely free — processors pay us, not you
- No obligation to switch after the review

${posNote}

GOAL: Qualify them and get them to email their processing statement to alex@01payments.com`;

  if (callType === "cold_call") {
    return `${base}

CALL TYPE: Cold outreach
${businessData.businessName ? `BUSINESS: ${businessData.businessName}` : ""}
${businessData.ownerName ? `CONTACT: ${businessData.ownerName}` : ""}
${businessData.posSystem ? `POS SYSTEM: ${businessData.posSystem}` : ""}

IF AN EMPLOYEE OR MANAGER ANSWERS (not the owner):
- Don't pitch. Just be friendly and ask for the owner.
- Something like: "Hey, is [owner name] around?" or "Is the owner around — or whoever handles the payment processing side of things?"
- If they're not in: "No worries, do you know a good time to catch them? Or I can just leave my number."
- Ask them to pass along: "Just let them know Alex from zero one payments called — it's about their card processing rates."

ONCE YOU REACH THE OWNER:
1. Confirm you have the right person — casually, not formally
2. Short pitch: you do free rate audits, a lot of businesses are overpaying and don't realize it
3. Ask roughly how much they do in card volume per month
4. If it's over 25k: ask them to shoot their statement over to alex@01payments.com
5. If it's under 10k: be honest — "Honestly at that volume it might not move the needle much for you, but keep us in mind as you grow"

OBJECTIONS:
- "Not interested" — "Totally fair. Do you know roughly what you're paying per swipe right now?"
- "I have a processor" — "Yeah, most people do. We're not asking you to switch anything — just a free second look at your rates. Takes like a minute to forward the statement."
- "Send me something in writing" — "For sure, what's the best email? I'll send something over."
- "Who is this?" — "It's Alex, from zero one payments — we do free rate reviews for businesses."

WRAP UP AND LEAVE if:
- They're under 10k a month in volume
- They've said no twice and clearly mean it`;
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
