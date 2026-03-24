import { Resend } from 'resend';

const FROM = process.env.FROM_EMAIL ?? 'alex@01payments.com';

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

async function sendEmail({ to, subject, text, html }) {
  const resend = getResend();

  if (!resend) {
    console.log('[email] RESEND_API_KEY not set — would have sent:');
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:    ${(text ?? '').slice(0, 300)}`);
    return;
  }

  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject,
    text,
    html,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
}

/**
 * Notify the owner that a new statement came in.
 */
export async function sendOwnerNotification(lead) {
  const fileUrl = lead.uploadFilename
    ? `https://godmode.church/uploads/${lead.uploadFilename}?key=01payments`
    : null;

  const text = [
    `New statement submission received.`,
    ``,
    `Name:     ${lead.fullName}`,
    `Business: ${lead.businessName}`,
    `Phone:    ${lead.phone}`,
    `Email:    ${lead.email}`,
    `File:     ${lead.fileName} (${(lead.fileSize / 1024).toFixed(1)} KB, ${lead.fileType})`,
    `Time:     ${lead.submittedAt}`,
    `Lead ID:  ${lead.id}`,
    fileUrl ? `View:     ${fileUrl}` : '',
    ``,
    `Statement is being analyzed now. You'll get another email if it fails.`,
  ].filter(l => l !== '').join('\n');

  await sendEmail({
    to: 'max@01payments.com',
    subject: `New Statement Upload — ${lead.businessName}`,
    text,
  });
}

/**
 * Notify the owner that analysis failed so they can handle it manually.
 */
export async function sendOwnerAnalysisFailure(lead, error) {
  const text = [
    `Statement analysis FAILED. Manual review needed.`,
    ``,
    `Name:     ${lead.fullName}`,
    `Business: ${lead.businessName}`,
    `Phone:    ${lead.phone}`,
    `Email:    ${lead.email}`,
    `Lead ID:  ${lead.id}`,
    ``,
    `Error: ${error}`,
  ].join('\n');

  await sendEmail({
    to: 'max@01payments.com',
    subject: `ANALYSIS FAILED — manual review needed — ${lead.businessName}`,
    text,
  });
}

// ── Fee classification ────────────────────────────────────────────────────────

const JUNK_FEE_KEYWORDS = [
  'pci', 'compliance', 'non-compliance', 'noncompliance',
  'rental', 'lease', 'equipment rental',
  'statement', 'postage',
  'regulatory',
  'annual',
  'minimum',
  'network access',
];

const LEGITIMATE_FEE_KEYWORDS = [
  'transaction', 'auth', 'authorization',
  'batch', 'settlement',
  'discount rate', 'discount fee',
  'assessment', 'interchange',
  'chargeback', 'dispute', 'retrieval',  // incident-based, not recurring — happen on any processor
];

/**
 * Split hidden fees into junk (eliminated entirely) vs legitimate (just get lower).
 * Monthly service fees are junk only if > $10 since our platform fee is much lower.
 */
function classifyHiddenFees(fees = []) {
  const junk = [];
  const legitimate = [];

  for (const fee of fees) {
    const name = fee.name.toLowerCase();

    if (LEGITIMATE_FEE_KEYWORDS.some(k => name.includes(k))) {
      legitimate.push(fee);
      continue;
    }

    // Monthly service fee: junk only if > $10
    if ((name.includes('service fee') || name.includes('monthly service') || name.includes('monthly fee')) && fee.amount <= 10) {
      legitimate.push(fee);
      continue;
    }

    if (JUNK_FEE_KEYWORDS.some(k => name.includes(k)) ||
        name.includes('service fee') || name.includes('monthly service') || name.includes('monthly fee')) {
      junk.push(fee);
      continue;
    }

    // Default: treat as junk (Claude was specifically asked to find unnecessary fees)
    junk.push(fee);
  }

  return { junk, legitimate };
}

/**
 * Send the prospect their savings report — shows ONLY the best-for-merchant option.
 */
export async function sendSavingsReport(lead, savingsData) {
  const fmt     = (n) => n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : 'N/A';
  const fmtRate = (r) => r != null ? `${Number(r).toFixed(2)}%` : 'N/A';

  // Use best-for-merchant processor numbers
  const best = savingsData.processor_comparison?.reduce((a, b) =>
    (b.merchant_monthly_savings ?? -Infinity) > (a.merchant_monthly_savings ?? -Infinity) ? b : a
  , savingsData.processor_comparison?.[0] ?? {});

  const proposed_rate   = best?.proposed_effective_rate ?? savingsData.proposed_rate;
  const proposed_fees   = best?.proposed_merchant_fees  ?? savingsData.proposed_fees;
  const monthly_savings = best?.merchant_monthly_savings ?? savingsData.monthly_savings;
  const annual_savings  = best?.merchant_annual_savings  ?? savingsData.annual_savings;

  // Only show junk fees to the merchant — not legitimate processing costs
  const { junk: junkFees } = classifyHiddenFees(savingsData.hidden_fees);
  const junkTotal = junkFees.reduce((sum, f) => sum + (f.amount ?? 0), 0);

  const junkFeeRows = junkFees.map(f => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${f.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#c0392b;">${fmt(f.amount)}/mo</td>
    </tr>`).join('');

  const hiddenFeesSection = `
    <div style="margin:28px 0 0;">
      <h3 style="margin:0 0 10px;font-size:15px;color:#333;">Hidden Fees We Found — These Go Away When You Switch</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead><tr style="background:#fff8f8;">
          <th style="padding:8px 12px;text-align:left;color:#999;font-weight:600;font-size:11px;text-transform:uppercase;">Fee</th>
          <th style="padding:8px 12px;text-align:right;color:#999;font-weight:600;font-size:11px;text-transform:uppercase;">Monthly Cost</th>
        </tr></thead>
        <tbody>${junkFeeRows || `<tr><td colspan="2" style="padding:10px 12px;color:#888;font-size:13px;">No hidden fees identified on this statement.</td></tr>`}</tbody>
      </table>
      ${junkTotal > 0 ? `<p style="margin:10px 0 0;font-size:14px;font-weight:600;color:#c0392b;">You're paying ${fmt(junkTotal)}/month in unnecessary fees.</p>` : ''}
    </div>`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#0a0a0a;padding:28px 36px;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#fff;letter-spacing:-.3px;">01 Payments</p>
            <p style="margin:4px 0 0;font-size:13px;color:#888;">Free Savings Report</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 36px;">
            <p style="margin:0 0 20px;font-size:15px;color:#333;">Hi ${lead.fullName},</p>
            <p style="margin:0 0 28px;font-size:15px;color:#555;line-height:1.6;">
              We've finished analyzing your processing statement for <strong>${lead.businessName}</strong>.
              Here's what we found:
            </p>

            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <thead><tr style="background:#f9f9f9;">
                <th style="padding:10px 12px;text-align:left;color:#999;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;"></th>
                <th style="padding:10px 12px;text-align:right;color:#999;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Current</th>
                <th style="padding:10px 12px;text-align:right;color:#999;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">With 01 Payments</th>
              </tr></thead>
              <tbody>
                <tr>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#555;">Monthly Volume</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;" colspan="2">${fmt(savingsData.monthly_volume)}</td>
                </tr>
                <tr>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#555;">Effective Rate</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#c0392b;">${fmtRate(savingsData.effective_rate)}</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#27ae60;">${fmtRate(proposed_rate)}</td>
                </tr>
                <tr>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#555;">Monthly Fees</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#c0392b;">${fmt(savingsData.total_fees)}</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#27ae60;">${fmt(proposed_fees)}</td>
                </tr>
                <tr>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#555;">Transactions</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;" colspan="2">${savingsData.transaction_count != null ? Number(savingsData.transaction_count).toLocaleString() : 'N/A'}</td>
                </tr>
              </tbody>
            </table>

            ${hiddenFeesSection}

            <div style="background:#f0faf4;border-left:4px solid #27ae60;border-radius:6px;padding:20px 24px;margin:28px 0;">
              <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#27ae60;text-transform:uppercase;letter-spacing:.05em;">Your Estimated Savings</p>
              <p style="margin:0;font-size:28px;font-weight:700;color:#1a1a1a;">${fmt(monthly_savings)}<span style="font-size:14px;font-weight:400;color:#888;">/month</span></p>
              <p style="margin:4px 0 0;font-size:15px;color:#555;">${fmt(annual_savings)} per year</p>
            </div>

            <p style="margin:0 0 8px;font-size:14px;color:#555;line-height:1.6;">
              Ready to move forward? No contract, no setup fee, free terminal — we handle the entire switch.
            </p>
            <p style="margin:0 0 28px;font-size:13px;color:#888;">
              We get paid by the processor, not by you. You just get the lower rate.
            </p>

            <a href="mailto:max@01payments.com?subject=Ready%20to%20switch%20%E2%80%94%20${encodeURIComponent(lead.businessName)}"
               style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:7px;font-size:15px;font-weight:600;">
              Get Started
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 36px;border-top:1px solid #f0f0f0;">
            <p style="margin:0;font-size:12px;color:#aaa;">
              01 Payments · ISO Agent · Savings based on your actual statement using interchange-plus pricing.
              Actual results may vary based on card mix and transaction types.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await sendEmail({
    to: lead.email,
    subject: `Your free savings report — ${lead.businessName}`,
    html,
  });
}

/**
 * Notify the owner that a new merchant application came in.
 */
export async function sendApplicationNotification(appData) {
  const rows = Object.entries(appData)
    .filter(([k]) => k !== 'leadId')
    .map(([k, v]) => `${k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}: ${v ?? '—'}`)
    .join('\n');

  await sendEmail({
    to: 'max@01payments.com',
    subject: `New Application — ${appData.business_name ?? appData.businessName ?? 'Unknown Business'}`,
    text: `New merchant application received.\n\n${rows}`,
  });
}

/**
 * Send the merchant a confirmation that their application was received.
 */
export async function sendApplicationConfirmation({ fullName, businessName, email }) {
  const name = (fullName ?? '').split(' ')[0] || fullName;
  await sendEmail({
    to: email,
    subject: `Application received — ${businessName}`,
    text: [
      `Hi ${name},`,
      ``,
      `We've received your application for ${businessName}. Most businesses are approved within 24 hours.`,
      ``,
      `We'll email you as soon as you're approved and ready to start processing. If you have any questions, reply to this email.`,
      ``,
      `— Alex`,
      `01 Payments`,
    ].join('\n'),
  });
}

/**
 * Send the owner a full internal analysis email showing all processor options side by side.
 * Called after analysis completes successfully.
 */
export async function sendOwnerAnalysisReport(lead, savingsData) {
  const fmt     = (n) => n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : '—';
  const fmtRate = (r) => r != null ? `${Number(r).toFixed(2)}%` : '—';
  const fileUrl = lead.uploadFilename
    ? `https://godmode.church/uploads/${lead.uploadFilename}?key=01payments`
    : null;

  const comparison = savingsData.processor_comparison ?? [];
  const rec        = savingsData.recommendation ?? {};

  const processorRows = comparison.map(p => `
    <tr style="background:${p === comparison[0] ? '#f6fff9' : '#fff'};">
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-weight:600;">${p.processor}<br><span style="font-weight:400;font-size:12px;color:#888;">${p.tier}</span></td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;text-align:right;">${fmt(p.floor_cost)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;text-align:right;color:#27ae60;">${fmt(p.proposed_merchant_fees)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;text-align:right;color:#27ae60;">${fmt(p.merchant_monthly_savings)}/mo<br><span style="font-size:11px;color:#888;">${fmt(p.merchant_annual_savings)}/yr</span></td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;text-align:right;">${fmt(p.our_gross_margin)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;color:#0a0a0a;">${fmt(p.our_monthly_residual)}/mo</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;text-align:right;">${fmt(p.upfront_bonus)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">${fmt(p.first_year_total_income)}</td>
    </tr>`).join('');

  const hiddenFeesList = (savingsData.hidden_fees ?? []).map(f => `${f.name}: ${fmt(f.amount)}/mo`).join(', ') || 'None found';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:32px 0;">
    <tr><td align="center">
      <table width="700" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 8px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#0a0a0a;padding:20px 28px;">
            <p style="margin:0;font-size:16px;font-weight:700;color:#fff;">New Lead — Analysis Complete</p>
            <p style="margin:4px 0 0;font-size:12px;color:#888;">${new Date(lead.submittedAt).toLocaleString()}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 28px;">

            <!-- Lead info -->
            <table style="width:100%;font-size:13px;margin-bottom:24px;">
              <tr>
                <td style="padding:4px 0;color:#888;width:100px;">Name</td>
                <td style="padding:4px 0;font-weight:600;">${lead.fullName}</td>
                <td style="padding:4px 0;color:#888;width:100px;">Business</td>
                <td style="padding:4px 0;font-weight:600;">${lead.businessName}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#888;">Phone</td>
                <td style="padding:4px 0;">${lead.phone}</td>
                <td style="padding:4px 0;color:#888;">Email</td>
                <td style="padding:4px 0;">${lead.email}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#888;">Processor</td>
                <td style="padding:4px 0;">${savingsData.current_processor ?? '—'}</td>
                <td style="padding:4px 0;color:#888;">Business Type</td>
                <td style="padding:4px 0;">${savingsData.business_type ?? '—'}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#888;">Volume</td>
                <td style="padding:4px 0;">${fmt(savingsData.monthly_volume)}/mo</td>
                <td style="padding:4px 0;color:#888;">Current Rate</td>
                <td style="padding:4px 0;color:#c0392b;">${fmtRate(savingsData.effective_rate)}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#888;">Current Fees</td>
                <td style="padding:4px 0;color:#c0392b;">${fmt(savingsData.total_fees)}/mo</td>
                <td style="padding:4px 0;color:#888;">Transactions</td>
                <td style="padding:4px 0;">${savingsData.transaction_count?.toLocaleString() ?? '—'}</td>
              </tr>
              <tr>
                <td style="padding:4px 0;color:#888;">Hidden Fees</td>
                <td colspan="3" style="padding:4px 0;color:#c0392b;">${hiddenFeesList}</td>
              </tr>
              ${fileUrl ? `<tr>
                <td style="padding:8px 0 4px;color:#888;">Statement</td>
                <td colspan="3" style="padding:8px 0 4px;"><a href="${fileUrl}" style="color:#0a0a0a;">View uploaded file →</a></td>
              </tr>` : ''}
            </table>

            <!-- Processor comparison table -->
            <h3 style="margin:0 0 12px;font-size:14px;color:#333;text-transform:uppercase;letter-spacing:.05em;">Processor Comparison</h3>
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
              <thead>
                <tr style="background:#f9f9f9;">
                  <th style="padding:8px 14px;text-align:left;color:#999;font-weight:600;">Processor / Tier</th>
                  <th style="padding:8px 14px;text-align:right;color:#999;font-weight:600;">Floor Cost</th>
                  <th style="padding:8px 14px;text-align:right;color:#999;font-weight:600;">Proposed Fees</th>
                  <th style="padding:8px 14px;text-align:right;color:#999;font-weight:600;">Merchant Saves</th>
                  <th style="padding:8px 14px;text-align:right;color:#999;font-weight:600;">Gross Margin</th>
                  <th style="padding:8px 14px;text-align:right;color:#999;font-weight:600;">Our Residual</th>
                  <th style="padding:8px 14px;text-align:right;color:#999;font-weight:600;">Upfront Bonus</th>
                  <th style="padding:8px 14px;text-align:right;color:#999;font-weight:600;">Yr 1 Income</th>
                </tr>
              </thead>
              <tbody>${processorRows}</tbody>
            </table>

            <!-- Recommendation -->
            <div style="background:#f0faf4;border-left:4px solid #27ae60;border-radius:6px;padding:16px 20px;margin:20px 0 0;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#27ae60;text-transform:uppercase;letter-spacing:.05em;">Recommendation</p>
              <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1a1a1a;">Best for merchant: ${rec.best_for_merchant ?? '—'}</p>
              <p style="margin:0 0 4px;font-size:13px;color:#555;">Best long-term residual: ${rec.best_for_agent_long_term ?? '—'}</p>
              <p style="margin:0 0 8px;font-size:13px;color:#555;">Best upfront income: ${rec.best_for_agent_upfront ?? '—'}</p>
              <p style="margin:0;font-size:13px;color:#333;">${rec.reason ?? ''}</p>
            </div>

            <p style="margin:16px 0 0;font-size:12px;color:#aaa;">
              70/30 margin split — merchant gets 70% of savings gap, we keep 30%.
              Lead ID: ${lead.id}
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await sendEmail({
    to: 'max@01payments.com',
    subject: `Analysis Ready — ${lead.businessName} (${fmt(savingsData.monthly_volume)}/mo)`,
    html,
  });
}
