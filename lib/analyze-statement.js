import Anthropic from '@anthropic-ai/sdk';
import { compareRates } from './compare-rates.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AGENT_MARGIN_BPS = parseFloat(process.env.AGENT_MARGIN_BPS ?? '30');

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

  // Legacy field aliases for follow-up-call / email compatibility
  const current_fees   = total_fees;
  const current_rate   = effective_rate;

  // Proposed rate from best processor (filled in after comparison)
  let proposed_fees    = null;
  let proposed_rate    = null;
  let monthly_savings  = null;
  let annual_savings   = null;

  // Run rate comparison
  let comparison = null;
  if (monthly_volume && monthly_volume > 0) {
    try {
      comparison = compareRates(
        { current_processor, business_type, monthly_volume, total_fees, transaction_count, card_mix },
        AGENT_MARGIN_BPS
      );

      // Use best-ranked processor for top-level savings fields
      const best = comparison[0];
      if (best) {
        proposed_fees   = best.estimated_monthly_fees;
        proposed_rate   = best.effective_rate;
        monthly_savings = best.monthly_savings;
        annual_savings  = best.annual_savings;
      }
    } catch (err) {
      console.warn('[compare-rates] skipped:', err.message);
      // Fallback: simple 2.1% estimate
      proposed_rate   = 2.1;
      proposed_fees   = monthly_volume != null ? parseFloat((monthly_volume * 0.021).toFixed(2)) : null;
      monthly_savings = (total_fees != null && proposed_fees != null) ? parseFloat((total_fees - proposed_fees).toFixed(2)) : null;
      annual_savings  = monthly_savings != null ? parseFloat((monthly_savings * 12).toFixed(2)) : null;
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
    comparison,
  };
}
