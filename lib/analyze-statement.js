import Anthropic from '@anthropic-ai/sdk';
import { compareRates } from './compare-rates.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });


const ANALYSIS_PROMPT = `You are a merchant services statement analyst. Analyze this processing statement and extract the following information.

CRITICAL DISTINCTION — separate processing fees from platform fees before calculating totals:

PROCESSING FEES (card acceptance costs — what we can replace with lower rates):
- Discount rates / percentage fees on card volume
- Per-transaction fees: auth fees, batch fees, settlement fees
- Interchange pass-through costs
- Card network assessments (Visa, MC, Discover, AmEx)
- PCI compliance fees / PCI non-compliance fees
- Statement fees, postage fees
- Regulatory fees, network access fees
- Monthly minimum fees (processing-related)
- Any fee directly tied to running a card transaction

PLATFORM FEES (software/service costs — NOT replaced by switching processors):
- POS software subscriptions (Toast, Clover, Square, SpotOn monthly SaaS fees)
- Hardware lease or rental payments
- Kitchen display system (KDS) fees
- Online ordering platform fees or commissions
- Marketing, loyalty, or gift card program fees
- Payroll or HR service fees billed through the processor
- Merchant cash advance / capital repayment deductions
- Tableside ordering or guest management subscriptions
- Any fee that is a SaaS product unrelated to card transaction processing

KNOWN PLATFORM FEE EXAMPLES BY PROCESSOR — always classify these as platform_fees, never processing_fees:
- Toast: "Toast POS", "Toast Software", "Toast Go", "Toast Hardware", "Kitchen Display", "KDS", "Online Ordering", "Toast Marketing", "Toast Payroll", "Toast Capital", "Toast Tables", "Digital Storefront", "Toast Now"
- Square: "Square POS", "Square for Restaurants", "Square Online", "Square Payroll", "Square Capital", "Square Marketing", "Square Loyalty", "Hardware rental"
- Heartland: "Restaurant Management", "Payroll", "Online Ordering", "Gift Card Program", any SaaS line items
- SpotOn: "SpotOn Restaurant", "Marketing", "Loyalty", "Online Ordering", "Reserve", "Teamwork", any SaaS line items
- Shopify: "Shopify Plan", "Shopify Plus", "App subscription", any platform subscription
- Clover: "Clover Software", "Clover Security Plus", "Clover Go" (these are replaced not eliminated — list as platform_fees)

Respond ONLY with valid JSON — no markdown, no explanation, just raw JSON matching this exact schema:

{
  "current_processor": "processor name (e.g. Square, Stripe, First Data, Heartland, Toast)",
  "business_type": "one of: restaurant, retail, ecommerce, services, moto, other",
  "monthly_volume": <number: total monthly card volume in dollars>,
  "processing_fees": <number: PROCESSING FEES ONLY — discount rates, per-transaction fees, interchange, assessments, PCI fees, statement fees, regulatory fees. This is what we use to calculate savings.>,
  "platform_fees_total": <number: sum of all platform fees — POS software, hardware leases, online ordering, etc.>,
  "total_fees": <number: processing_fees + platform_fees_total — all fees combined>,
  "effective_rate": <number: percentage — calculate as (processing_fees / monthly_volume) * 100. Based on processing fees only, not platform fees.>,
  "transaction_count": <number: total monthly transaction count>,
  "hidden_fees": [{ "name": "fee name", "amount": <monthly dollar amount> }],
  "platform_fees": [{ "name": "fee name", "amount": <monthly dollar amount>, "type": "pos_software | hardware_lease | online_ordering | marketing | payroll | capital | other", "lease_months_remaining": <number or null>, "early_termination_fee": <number or null> }],
  "pricing_model": "flat_rate | tiered | interchange_plus | other — what pricing model the merchant is currently on",
  "cnp_volume_percent": <number 0-100 — estimated percentage of volume that is card-not-present (keyed, MOTO, e-commerce, CNP). Look for line items containing non-qualified, non-qual, keyed, MOTO, card not present, CNP, or e-commerce. 0 if not detected.>,
  "card_mix": {
    "visa_percent": <number 0-100, only if explicitly shown on statement>,
    "mc_percent": <number 0-100, only if explicitly shown on statement>,
    "amex_percent": <number 0-100, only if explicitly shown on statement>,
    "discover_percent": <number 0-100, only if explicitly shown on statement>,
    "debit_percent": <number 0-100 — percentage of volume that is debit card, only if shown on statement>
  },
  "pos_system": "name of POS or terminal system if mentioned on the statement (e.g. Clover, Square, Pax, Toast, Dejavoo, Verifone, Ingenico, Heartland, SpotOn) — null if not mentioned",
  "notes": "brief analyst notes on pricing model, opportunities, unusual items"
}

Rules:
- processing_fees: ONLY card-acceptance costs. Do NOT include POS software subscriptions, hardware leases, or any SaaS platform fees.
- platform_fees: ONLY non-processing SaaS/subscription/lease costs. Empty array if none. Include lease_months_remaining and early_termination_fee if visible on the statement — otherwise null.
- hidden_fees: processing fees beyond core discount rate/interchange — include PCI fees, statement fees, batch fees, monthly minimums, regulatory fees, network access fees. These are a subset of processing_fees. Empty array if none.
- effective_rate: calculate from processing_fees only, not total_fees.
- card_mix: ONLY include fields that are explicitly shown on the statement. Omit debit_percent if not shown.
- cnp_volume_percent: estimate based on non-qualified/keyed/MOTO/CNP line items. Set to 0 if none detected.
- pricing_model: "flat_rate" for Square/Stripe/PayPal style. "interchange_plus" if statement shows IC+ or pass-through. "tiered" if qualified/mid-qualified/non-qualified buckets. "other" if unclear.
- pos_system: extract only if explicitly mentioned on the statement. null if not mentioned.
- Use null for any field you cannot determine with confidence.
- monthly_volume: total CARD PROCESSING VOLUME — the gross dollar amount of card transactions processed. On Toast/Square/Heartland statements this is often labeled "Gross Sales", "Total Sales", "Card Sales", or "Processing Volume". Do NOT use net deposits or net payouts. Do NOT subtract refunds unless the statement only shows net volume. If the statement shows separate card brand totals (Visa, MC, AmEx, Discover), sum them.`;

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
    current_processor    = null,
    business_type        = null,
    monthly_volume       = null,
    processing_fees      = null,
    platform_fees_total  = null,
    total_fees           = null,
    effective_rate       = null,
    transaction_count    = null,
    hidden_fees          = [],
    platform_fees        = [],
    card_mix,
    pos_system: pos_from_statement = null,
    pricing_model        = null,
    cnp_volume_percent   = 0,
    notes                = null,
  } = extracted;

  // Use processing_fees for rate comparison if available; fall back to total_fees
  // This ensures savings calculations exclude platform costs (POS SaaS, hardware leases, etc.)
  const fees_for_comparison = processing_fees ?? total_fees;

  // Form-provided pos_system and best_time_to_call take priority over statement extraction
  const pos_system          = metadata.pos_system ?? pos_from_statement ?? null;
  const best_time_to_call   = metadata.best_time_to_call ?? null;
  const hardware_preference = metadata.hardware_preference ?? null;

  // Legacy field aliases for follow-up-call compatibility
  const current_fees = total_fees;
  const current_rate = effective_rate;

  // Run processor comparison with POS routing
  let processor_comparison    = null;
  let top5_for_owner          = null;
  let secondary_options       = null;
  let recommendation          = null;
  let margin_strategy         = null;
  let proposed_fees           = null;
  let proposed_rate           = null;
  let monthly_savings         = null;
  let annual_savings          = null;
  let pos_compatible          = null;
  let pos_locked              = null;
  let pos_lock_status         = null;
  let compatible_processors   = null;
  let pos_recommendation      = null;
  let equipment_action        = null;
  let volume_tier             = null;
  let deal_difficulty         = null;
  let cnp_note                = null;
  let debit_savings_highlight = null;
  let no_switch_recommended   = false;
  let best_option             = null;

  if (monthly_volume && monthly_volume > 0 && fees_for_comparison && fees_for_comparison > 0) {
    const platform_total = Array.isArray(platform_fees)
      ? platform_fees.reduce((s, f) => s + (f.amount ?? 0), 0)
      : 0;
    console.log(`[analyze-statement] fees breakdown — total_fees: $${total_fees} | processing_fees: $${fees_for_comparison} | platform_fees: $${platform_total} | monthly_volume: $${monthly_volume}`);
    try {
      const result = compareRates({
        current_processor, business_type, monthly_volume, total_fees: fees_for_comparison,
        transaction_count, card_mix, pos_system, cnp_volume_percent, pricing_model,
        hardware_preference,
      });
      processor_comparison    = result.processor_comparison;
      top5_for_owner          = result.top5_for_owner;
      secondary_options       = result.secondary_options;
      recommendation          = result.recommendation;
      margin_strategy         = result.margin_strategy;
      pos_compatible          = result.pos_compatible;
      pos_locked              = result.pos_locked;
      pos_lock_status         = result.pos_lock_status;
      compatible_processors   = result.compatible_processors;
      pos_recommendation      = result.pos_recommendation;
      equipment_action        = result.equipment_action;
      volume_tier             = result.volume_tier;
      deal_difficulty         = result.deal_difficulty;
      cnp_note                = result.cnp_note;
      debit_savings_highlight = result.debit_savings_highlight;
      no_switch_recommended   = result.no_switch_recommended ?? false;
      best_option             = result.best;

      // Top-level convenience fields from recommended option
      if (best_option) {
        proposed_fees   = best_option.proposed_merchant_fees;
        proposed_rate   = best_option.proposed_effective_rate;
        monthly_savings = best_option.merchant_monthly_savings;
        annual_savings  = best_option.merchant_annual_savings;
      }

      console.log('[compare-rates] complete — recommended:', recommendation.recommended,
        '| merchant saves:', monthly_savings, '/mo | deal difficulty:', deal_difficulty,
        '| CNP:', cnp_volume_percent + '%', '| debit savings:', debit_savings_highlight?.debit_savings);
    } catch (err) {
      console.warn('[compare-rates] skipped:', err.message);
    }
  }

  return {
    current_processor,
    business_type,
    monthly_volume,
    processing_fees: fees_for_comparison,   // processing costs only — used for savings comparison
    platform_fees: Array.isArray(platform_fees) ? platform_fees : [],
    platform_fees_total: platform_fees_total ?? (total_fees != null && fees_for_comparison != null ? total_fees - fees_for_comparison : null),
    total_fees,                             // full total including platform fees
    current_fees: fees_for_comparison,      // alias: processing fees for comparison
    effective_rate,
    current_rate: effective_rate,
    transaction_count,
    hidden_fees: Array.isArray(hidden_fees) ? hidden_fees : [],
    card_mix: card_mix ?? null,
    pos_system,
    pricing_model,
    cnp_volume_percent,
    best_time_to_call,
    hardware_preference,
    proposed_fees,
    proposed_rate,
    monthly_savings,
    annual_savings,
    notes,
    // Routing fields
    pos_compatible,
    pos_locked,
    pos_lock_status,
    compatible_processors,
    pos_recommendation,
    equipment_action,
    volume_tier,
    deal_difficulty,
    no_switch_recommended,
    cnp_note,
    debit_savings_highlight,
    // Full comparison data
    processor_comparison,
    top5_for_owner,
    secondary_options,
    recommendation,
    margin_strategy,
    // Recommended option for email/call consistency
    best: best_option,
    // Legacy alias
    comparison: processor_comparison,
  };
}
