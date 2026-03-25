import Anthropic from '@anthropic-ai/sdk';
import { compareRates } from './compare-rates.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });


const ANALYSIS_PROMPT = `You are a merchant services statement analyst. Analyze this processing statement and extract the following information.

Respond ONLY with valid JSON — no markdown, no explanation, just raw JSON matching this exact schema:

{
  "current_processor": "processor name (e.g. Square, Stripe, First Data, Heartland)",
  "business_type": "one of: restaurant, retail, ecommerce, services, moto, other",
  "monthly_volume": <number: total monthly card volume in dollars>,
  "total_fees": <number: total monthly fees in dollars — all fees combined>,
  "effective_rate": <number: percentage, e.g. 2.67 — calculate as (total_fees / monthly_volume) * 100>,
  "transaction_count": <number: total monthly transaction count>,
  "hidden_fees": [{ "name": "fee name", "amount": <monthly dollar amount> }],
  "card_mix": {
    "visa_percent": <number 0-100, only if explicitly shown on statement>,
    "mc_percent": <number 0-100, only if explicitly shown on statement>,
    "amex_percent": <number 0-100, only if explicitly shown on statement>,
    "discover_percent": <number 0-100, only if explicitly shown on statement>
  },
  "pos_system": "name of POS or terminal system if mentioned on the statement (e.g. Clover, Square, Pax, Toast, Dejavoo, Verifone, Ingenico, Heartland, SpotOn) — null if not mentioned",
  "notes": "brief analyst notes on pricing model, opportunities, unusual items"
}

Rules:
- hidden_fees: include PCI fees, statement fees, batch fees, monthly minimums, regulatory fees, network access fees — anything beyond core interchange/assessment. Empty array if none.
- card_mix: ONLY include if the statement explicitly breaks down volume or transactions by card network. Omit the card_mix key entirely if not shown.
- pos_system: extract only if explicitly mentioned on the statement (e.g. terminal type, gateway name, POS platform). null if not mentioned.
- Use null for any field you cannot determine with confidence.
- monthly_volume should be total card volume, not just one card type.`;

/**
 * Send a statement (PDF or image) to Claude for analysis, then run rate comparison.
 * @param {Buffer} fileBuffer
 * @param {string} mimeType
 * @param {object} [metadata] - optional overrides from the form submission (pos_system, best_time_to_call)
 */
export async function analyzeStatement(fileBuffer, mimeType, metadata = {}) {
  console.log('FILE RECEIVED:', fileBuffer.length, 'bytes,', mimeType);

  const fileBase64 = fileBuffer.toString('base64');
  console.log('BASE64 LENGTH:', fileBase64.length);

  const fileMimeType = mimeType === 'application/pdf' ? 'application/pdf'
    : mimeType === 'image/png' ? 'image/png'
    : 'image/jpeg';

  const contentBlock = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: fileMimeType, data: fileBase64 } }
    : { type: 'image',    source: { type: 'base64', media_type: fileMimeType, data: fileBase64 } };

  console.log('SENDING TO CLAUDE — model: claude-sonnet-4-20250514, content type:', contentBlock.type);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      { role: 'user', content: [contentBlock, { type: 'text', text: ANALYSIS_PROMPT }] },
    ],
  });

  let rawText = response.content[0]?.text;
  if (!rawText) throw new Error('Empty response from Claude');

  console.log('CLAUDE RAW RESPONSE:', rawText.substring(0, 500));

  let cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  console.log('CLAUDE CLEANED RESPONSE:', cleaned.substring(0, 500));

  let extracted;
  try {
    extracted = JSON.parse(cleaned);
    console.log('PARSE SUCCESS');
  } catch (e) {
    console.log('PARSE FAILED (direct):', e.message, '— trying regex extraction');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      extracted = JSON.parse(jsonMatch[0]);
      console.log('PARSE SUCCESS (regex)');
    } else {
      throw new Error('No valid JSON found in Claude response');
    }
  }

  const {
    current_processor = null,
    business_type     = null,
    monthly_volume    = null,
    total_fees        = null,
    effective_rate    = null,
    transaction_count = null,
    hidden_fees       = [],
    card_mix,
    pos_system: pos_from_statement = null,
    notes             = null,
  } = extracted;

  // Form-provided pos_system and best_time_to_call take priority over statement extraction
  const pos_system       = metadata.pos_system ?? pos_from_statement ?? null;
  const best_time_to_call = metadata.best_time_to_call ?? null;

  // Legacy field aliases for follow-up-call compatibility
  const current_fees = total_fees;
  const current_rate = effective_rate;

  // Run processor comparison with POS routing
  let processor_comparison = null;
  let recommendation       = null;
  let margin_strategy      = null;
  let proposed_fees        = null;
  let proposed_rate        = null;
  let monthly_savings      = null;
  let annual_savings       = null;
  let pos_compatible       = null;
  let pos_locked           = null;
  let pos_recommendation   = null;
  let equipment_action     = null;
  let volume_tier          = null;
  let deal_difficulty      = null;

  if (monthly_volume && monthly_volume > 0 && total_fees && total_fees > 0) {
    try {
      const result = compareRates({ current_processor, business_type, monthly_volume, total_fees, transaction_count, card_mix, pos_system });
      processor_comparison = result.processor_comparison;
      recommendation       = result.recommendation;
      margin_strategy      = result.margin_strategy;
      pos_compatible       = result.pos_compatible;
      pos_locked           = result.pos_locked;
      pos_recommendation   = result.pos_recommendation;
      equipment_action     = result.equipment_action;
      volume_tier          = result.volume_tier;
      deal_difficulty      = result.deal_difficulty;

      // Top-level convenience fields from recommended option
      const best = result.best;
      proposed_fees   = best.proposed_merchant_fees;
      proposed_rate   = best.proposed_effective_rate;
      monthly_savings = best.merchant_monthly_savings;
      annual_savings  = best.merchant_annual_savings;

      console.log('[compare-rates] complete — recommended:', recommendation.recommended,
        '| merchant saves:', monthly_savings, '/mo | deal difficulty:', deal_difficulty);
    } catch (err) {
      console.warn('[compare-rates] skipped:', err.message);
    }
  }

  return {
    current_processor,
    business_type,
    monthly_volume,
    total_fees,
    current_fees,
    effective_rate,
    current_rate,
    transaction_count,
    hidden_fees: Array.isArray(hidden_fees) ? hidden_fees : [],
    card_mix: card_mix ?? null,
    pos_system,
    best_time_to_call,
    proposed_fees,
    proposed_rate,
    monthly_savings,
    annual_savings,
    notes,
    // Routing fields
    pos_compatible,
    pos_locked,
    pos_recommendation,
    equipment_action,
    volume_tier,
    deal_difficulty,
    // Full comparison data
    processor_comparison,
    recommendation,
    margin_strategy,
    // Legacy alias
    comparison: processor_comparison,
  };
}
