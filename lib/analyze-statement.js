import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ANALYSIS_PROMPT = `You are a merchant services statement analyst. Analyze this processing statement and extract: business name, current processor, total monthly volume, total fees, effective rate, transaction count, average transaction size, and any hidden fees (PCI fees, statement fees, batch fees, monthly minimums). Then calculate estimated savings using interchange-plus pricing at approximately 2.1% effective rate for card-present and 2.45% for card-not-present. Respond ONLY with valid JSON: { current_processor, monthly_volume, total_fees, effective_rate, transaction_count, hidden_fees: [{name, amount}], proposed_fees, proposed_rate, monthly_savings, annual_savings, notes }`;

/**
 * Send a statement (PDF or image) to Claude for analysis.
 * Returns parsed savings data object ready for /follow-up-call.
 */
export async function analyzeStatement(fileBuffer, mimeType) {
  let contentBlock;

  if (mimeType === 'application/pdf') {
    contentBlock = {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: fileBuffer.toString('base64'),
      },
    };
  } else {
    // image/png or image/jpeg
    contentBlock = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: fileBuffer.toString('base64'),
      },
    };
  }

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          contentBlock,
          { type: 'text', text: ANALYSIS_PROMPT },
        ],
      },
    ],
  });

  const raw = response.content[0]?.text?.trim();
  if (!raw) throw new Error('Empty response from Claude');

  let extracted;
  try {
    extracted = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Could not parse JSON from Claude response: ${raw.slice(0, 200)}`);
    extracted = JSON.parse(match[0]);
  }

  // Normalize field names — Claude returns the exact prompt schema but
  // the follow-up-call endpoint uses current_fees/current_rate aliases too.
  const {
    current_processor = null,
    monthly_volume = null,
    total_fees = null,
    effective_rate = null,
    transaction_count = null,
    hidden_fees = [],
    proposed_fees = null,
    proposed_rate = null,
    monthly_savings = null,
    annual_savings = null,
    notes = null,
  } = extracted;

  // If Claude calculated proposed_fees itself, use those; otherwise fall back to 2.1%
  const resolvedProposedRate  = proposed_rate  ?? 2.1;
  const resolvedProposedFees  = proposed_fees  ?? (monthly_volume != null ? parseFloat((monthly_volume * (resolvedProposedRate / 100)).toFixed(2)) : null);
  const resolvedMonthlySavings = monthly_savings ?? ((total_fees != null && resolvedProposedFees != null) ? parseFloat((total_fees - resolvedProposedFees).toFixed(2)) : null);
  const resolvedAnnualSavings  = annual_savings  ?? (resolvedMonthlySavings != null ? parseFloat((resolvedMonthlySavings * 12).toFixed(2)) : null);

  return {
    current_processor,
    monthly_volume,
    // expose under both naming conventions so /follow-up-call is happy
    current_fees:  total_fees,
    total_fees,
    current_rate:  effective_rate,
    effective_rate,
    transaction_count,
    hidden_fees: Array.isArray(hidden_fees) ? hidden_fees : [],
    proposed_fees:    resolvedProposedFees,
    proposed_rate:    resolvedProposedRate,
    monthly_savings:  resolvedMonthlySavings,
    annual_savings:   resolvedAnnualSavings,
    notes,
  };
}
