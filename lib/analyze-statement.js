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
  "notes": "brief analyst notes on pricing model, opportunities, unusual items"
}

Rules:
- hidden_fees: include PCI fees, statement fees, batch fees, monthly minimums, regulatory fees, network access fees — anything beyond core interchange/assessment. Empty array if none.
- card_mix: ONLY include if the statement explicitly breaks down volume or transactions by card network. Omit the card_mix key entirely if not shown.
- Use null for any field you cannot determine with confidence.
- monthly_volume should be total card volume, not just one card type.`;

/**
 * Send a statement (PDF or image) to Claude for analysis, then run rate comparison.
 */
export async function analyzeStatement(fileBuffer, mimeType) {
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
    notes             = null,
  } = extracted;

  // Legacy field aliases for follow-up-call compatibility
  const current_fees = total_fees;
  const current_rate = effective_rate;

  // Run dual-processor comparison
  let processor_comparison = null;
  let recommendation       = null;
  let margin_strategy      = null;
  let proposed_fees        = null;
  let proposed_rate        = null;
  let monthly_savings      = null;
  let annual_savings       = null;

  if (monthly_volume && monthly_volume > 0 && total_fees && total_fees > 0) {
    try {
      const result = compareRates({ current_processor, business_type, monthly_volume, total_fees, transaction_count, card_mix });
      processor_comparison = result.processor_comparison;
      recommendation       = result.recommendation;
      margin_strategy      = result.margin_strategy;

      // Top-level convenience fields from best-for-merchant option
      const best = result.best;
      proposed_fees   = best.proposed_merchant_fees;
      proposed_rate   = best.proposed_effective_rate;
      monthly_savings = best.merchant_monthly_savings;
      annual_savings  = best.merchant_annual_savings;

      console.log('[compare-rates] complete — best:', recommendation.recommended,
        '| merchant saves:', monthly_savings, '/mo | our residual:', best.our_monthly_residual, '/mo');
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
    proposed_fees,
    proposed_rate,
    monthly_savings,
    annual_savings,
    notes,
    // Full comparison data
    processor_comparison,
    recommendation,
    margin_strategy,
    // Legacy alias kept for old code that reads .comparison
    comparison: processor_comparison,
  };
}
