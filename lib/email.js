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

  const lines = [
    `New statement submission received.`,
    ``,
  ];

  if (lead.posSystem || lead.bestTimeToCall || lead.hardwarePreference) {
    const hwLabels = { keep_hardware: 'Keep current system', open_to_switch: 'Open to switching', wants_new: 'Wants new equipment' };
    lines.push(`── QUICK INFO ──────────────────────`);
    if (lead.posSystem)           lines.push(`POS System:          ${lead.posSystem}`);
    if (lead.hardwarePreference)  lines.push(`Hardware Preference: ${hwLabels[lead.hardwarePreference] ?? lead.hardwarePreference}`);
    if (lead.bestTimeToCall)      lines.push(`Best time to call:   ${lead.bestTimeToCall}`);
    lines.push(``);
  }

  lines.push(
    `Name:     ${lead.fullName}`,
    `Business: ${lead.businessName}`,
    `Phone:    ${lead.phone}`,
    `Email:    ${lead.email}`,
    `File:     ${lead.fileName} (${(lead.fileSize / 1024).toFixed(1)} KB, ${lead.fileType})`,
    `Time:     ${lead.submittedAt}`,
    `Lead ID:  ${lead.id}`,
  );
  if (fileUrl) lines.push(`View:     ${fileUrl}`);
  lines.push(``, `Statement is being analyzed now. You'll get another email with the full deal assessment.`);

  const text = lines.join('\n');

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
  'cb-', 'rr-',                          // chargeback (CB-) and retrieval request (RR-) line items
  'acquirer',                            // per-transaction acquirer fees — not junk, present on all processors
  'processing fee',                      // per-transaction processing fees tied to acquirer costs
  'clover',                              // Clover software/security fees get replaced on new processor, not eliminated
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
 * Handles three cases:
 *   1. Locked POS + processing savings < $500/mo → soft "negotiate with current processor" email
 *   2. Locked POS + savings ≥ $500/mo → standard email with POS-switch copy
 *   3. Standard (unlocked POS or open to switching) → normal email
 */
export async function sendSavingsReport(lead, savingsData) {
  const fmt     = (n) => n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : 'N/A';
  const fmtRate = (r) => r != null ? `${Number(r).toFixed(2)}%` : 'N/A';

  // Use the recommended processor (routing-aware) — same processor that was recommended in the owner report.
  // Falls back to max-savings pick if best is not set.
  // For Clover merchants, always use Beacon (EPI does not support Clover natively).
  const is_clover_merchant = /clover/.test((savingsData.pos_system ?? '').toLowerCase());

  let best = savingsData.best
    ?? savingsData.processor_comparison?.reduce((a, b) =>
        (b.merchant_monthly_savings ?? -Infinity) > (a.merchant_monthly_savings ?? -Infinity) ? b : a,
       savingsData.processor_comparison?.[0] ?? {});

  if (is_clover_merchant && savingsData.processor_comparison) {
    const beaconOpt = savingsData.processor_comparison.find(o => o.processor === 'Beacon Payments');
    if (beaconOpt) best = beaconOpt;
  }

  const proposed_rate   = best?.proposed_effective_rate ?? savingsData.proposed_rate;
  const proposed_fees   = best?.proposed_merchant_fees  ?? savingsData.proposed_fees;
  const monthly_savings = best?.merchant_monthly_savings ?? savingsData.monthly_savings;
  const annual_savings  = best?.merchant_annual_savings  ?? savingsData.annual_savings;

  // Locked POS detection — affects email copy
  const is_locked_pos = savingsData.pos_locked === true;
  const pos_name      = savingsData.pos_system ?? 'your current POS system';

  // ── SOFT EMAIL: locked POS + processing savings < $500/mo ─────────────────
  if (is_locked_pos && (monthly_savings ?? 0) < 500) {
    const softHtml = `<!DOCTYPE html>
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
            <p style="margin:0 0 20px;font-size:15px;color:#555;line-height:1.6;">
              We analyzed your processing statement for <strong>${lead.businessName}</strong>. While your processing rates could be lower, the savings may not justify switching your ${pos_name} system right now.
            </p>
            <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6;">
              <strong>Our recommendation:</strong> Call ${pos_name} directly and ask to be moved to their interchange-plus pricing. Many processors will reduce rates for merchants who ask — especially if you mention you've received a competitive quote.
            </p>

            <div style="background:#f9f9f9;border-radius:8px;padding:20px 24px;margin:0 0 24px;">
              <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.05em;">Your Current Numbers</p>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr>
                  <td style="padding:7px 0;color:#888;border-bottom:1px solid #eee;">Monthly Volume</td>
                  <td style="padding:7px 0;text-align:right;border-bottom:1px solid #eee;font-weight:600;">${fmt(savingsData.monthly_volume)}</td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#888;border-bottom:1px solid #eee;">Processing Fees</td>
                  <td style="padding:7px 0;text-align:right;border-bottom:1px solid #eee;font-weight:600;color:#c0392b;">${fmt(savingsData.processing_fees ?? savingsData.total_fees)}/mo</td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#888;border-bottom:1px solid #eee;">Effective Rate</td>
                  <td style="padding:7px 0;text-align:right;border-bottom:1px solid #eee;font-weight:600;color:#c0392b;">${fmtRate(savingsData.effective_rate)}</td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#888;">Potential Savings (processing only)</td>
                  <td style="padding:7px 0;text-align:right;font-weight:600;color:#888;">${fmt(monthly_savings)}/mo</td>
                </tr>
              </table>
            </div>

            <p style="margin:0 0 8px;font-size:13px;color:#555;line-height:1.6;">
              If your situation changes — or if ${pos_name} won't budge on rates — we're here. Sometimes a full switch makes sense once a lease expires or savings grow with volume.
            </p>
            <p style="margin:0 0 28px;font-size:13px;color:#888;">
              No pressure either way. We get paid by the processor, not by you — so we only recommend switching when the numbers truly justify it.
            </p>

            <a href="https://01payments.com/get-quote"
               style="display:inline-block;background:#555;color:#fff;text-decoration:none;padding:13px 28px;border-radius:7px;font-size:15px;font-weight:600;">
              Get a Full Quote Anyway
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 36px;border-top:1px solid #f0f0f0;">
            <p style="margin:0;font-size:12px;color:#aaa;">
              01 Payments · ISO Agent · Analysis based on your actual statement. Savings estimates are on processing fees only.
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
      subject: `Your processing analysis — ${lead.businessName}`,
      html: softHtml,
    });
    return;
  }

  // ── SHARED HELPERS for standard + locked-switch emails ────────────────────

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

  // Platform fees section — shown separately so merchant understands what's excluded from savings
  const platformFees = Array.isArray(savingsData.platform_fees) ? savingsData.platform_fees : [];
  const platformFeesTotal = savingsData.platform_fees_total ?? platformFees.reduce((s, f) => s + (f.amount ?? 0), 0);
  const platformFeesSection = platformFees.length > 0 ? `
    <div style="margin:20px 0 0;">
      <h3 style="margin:0 0 6px;font-size:14px;color:#888;">Platform Costs (not included in savings calculation)</h3>
      <p style="margin:0 0 10px;font-size:12px;color:#aaa;">These are software subscriptions and services tied to your POS system, not your processing rates.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        ${platformFees.map(f => `<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #f5f5f5;color:#888;">${f.name}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f5f5f5;text-align:right;color:#888;">${fmt(f.amount)}/mo</td>
        </tr>`).join('')}
        ${platformFeesTotal > 0 ? `<tr>
          <td style="padding:8px 12px;color:#888;font-weight:600;">Total Platform Costs</td>
          <td style="padding:8px 12px;text-align:right;color:#888;font-weight:600;">${fmt(platformFeesTotal)}/mo</td>
        </tr>` : ''}
      </table>
    </div>` : '';

  // ── CTA COPY: locked POS switch vs standard ───────────────────────────────
  let ctaSection;
  if (is_locked_pos) {
    // Find hardware lease info from platform_fees if available
    const lease = platformFees.find(f => f.type === 'hardware_lease');
    const etfMonths    = lease?.lease_months_remaining ?? null;
    const etfAmount    = lease?.early_termination_fee   ?? null;
    const monthsCover  = etfAmount != null && monthly_savings > 0
      ? Math.ceil(etfAmount / monthly_savings)
      : null;

    const etfLine = etfAmount != null
      ? `Your current ${pos_name} hardware lease has ${etfMonths != null ? `<strong>${etfMonths} months remaining</strong> with a ` : ''}early termination fee of <strong>${fmt(etfAmount)}</strong>.${monthsCover != null ? ` The processing savings alone cover this cost within <strong>${monthsCover} month${monthsCover !== 1 ? 's' : ''}</strong>.` : ''}`
      : `If you have an early termination fee on your current ${pos_name} hardware, the processing savings typically cover it within 1–3 months.`;

    ctaSection = `
            <div style="background:#fff8ed;border-left:4px solid #e67e22;border-radius:6px;padding:16px 20px;margin:0 0 20px;">
              <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#e67e22;text-transform:uppercase;letter-spacing:.05em;">Note: POS System Switch Required</p>
              <p style="margin:0 0 8px;font-size:14px;color:#333;line-height:1.6;">Switching from ${pos_name} requires changing your POS system. We provide a free replacement POS at no cost to you.</p>
              <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">${etfLine}</p>
            </div>
            <p style="margin:0 0 8px;font-size:13px;color:#555;line-height:1.6;">
              We'll also help you complete your PCI compliance questionnaire so you never pay a non-compliance fee.
            </p>
            <p style="margin:0 0 28px;font-size:13px;color:#888;">
              We get paid by the processor, not by you. You just get the lower rate.
            </p>
            <a href="https://01payments.com/get-started"
               style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:7px;font-size:15px;font-weight:600;">
              Get Started
            </a>`;
  } else {
    ctaSection = `
            <p style="margin:0 0 8px;font-size:14px;color:#555;line-height:1.6;">
              Ready to move forward? No contract, no setup fee, free terminal — we handle the entire switch.
            </p>
            <p style="margin:0 0 8px;font-size:13px;color:#555;line-height:1.6;">
              We'll also help you complete your PCI compliance questionnaire so you never pay a non-compliance fee.
            </p>
            <p style="margin:0 0 28px;font-size:13px;color:#888;">
              We get paid by the processor, not by you. You just get the lower rate.
            </p>
            <a href="https://01payments.com/get-started"
               style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:7px;font-size:15px;font-weight:600;">
              Get Started
            </a>`;
  }

  // Use processing_fees for the comparison display row (not total_fees)
  const display_current_fees = savingsData.processing_fees ?? savingsData.total_fees;

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
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#555;">Processing Fees</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#c0392b;">${fmt(display_current_fees)}</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#27ae60;">${fmt(proposed_fees)}</td>
                </tr>
                <tr>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#555;">Transactions</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;" colspan="2">${savingsData.transaction_count != null ? Number(savingsData.transaction_count).toLocaleString() : 'N/A'}</td>
                </tr>
              </tbody>
            </table>

            ${hiddenFeesSection}
            ${platformFeesSection}

            <div style="background:#f0faf4;border-left:4px solid #27ae60;border-radius:6px;padding:20px 24px;margin:28px 0;">
              <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#27ae60;text-transform:uppercase;letter-spacing:.05em;">Your Estimated Savings</p>
              <p style="margin:0;font-size:28px;font-weight:700;color:#1a1a1a;">${fmt(monthly_savings)}<span style="font-size:14px;font-weight:400;color:#888;">/month</span></p>
              <p style="margin:4px 0 0;font-size:15px;color:#555;">${fmt(annual_savings)} per year</p>
              ${(() => {
                const dh = savingsData.debit_savings_highlight;
                if (dh && dh.debit_savings > 0) {
                  return `<p style="margin:10px 0 0;font-size:13px;color:#555;">Includes <strong style="color:#27ae60;">${fmt(dh.debit_savings)}/month</strong> in debit card savings — you're currently paying credit card rates on low-cost debit transactions.</p>`;
                }
                return '';
              })()}
            </div>

            ${(() => {
              const dh = savingsData.debit_savings_highlight;
              if (dh && dh.debit_savings > 50) {
                return `<div style="background:#fff8ed;border-left:4px solid #e67e22;border-radius:6px;padding:16px 20px;margin:0 0 20px;">
                  <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#e67e22;text-transform:uppercase;letter-spacing:.05em;">Debit Card Savings</p>
                  <p style="margin:0 0 6px;font-size:15px;color:#333;">Your debit card transactions alone are costing you <strong>${fmt(dh.debit_savings)}/month</strong> more than they should.</p>
                  <p style="margin:0;font-size:13px;color:#666;line-height:1.5;">On interchange-plus pricing, debit transactions cost a fraction of the flat rate — roughly 0.05% + $0.21 per transaction versus the full rate applied to everything. You're paying credit card rates on what are essentially penny-cost transactions.</p>
                </div>`;
              }
              return '';
            })()}

            ${savingsData.cnp_note ? `<p style="margin:0 0 16px;font-size:13px;color:#888;font-style:italic;">${savingsData.cnp_note}</p>` : ''}

            ${ctaSection}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 36px;border-top:1px solid #f0f0f0;">
            <p style="margin:0;font-size:12px;color:#aaa;">
              01 Payments · ISO Agent · Savings based on your actual statement using interchange-plus pricing.
              ${platformFees.length > 0 ? 'Savings calculation is on processing fees only and excludes platform/software costs.' : 'Actual results may vary based on card mix and transaction types.'}
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
 * Send the prospect an email with a link to upload their processing statement.
 * Triggered by the AI agent when it captures an email during a cold call.
 */
export async function sendUploadLinkEmail({ to, ownerName }) {
  const firstName = ownerName ? ownerName.trim().split(/\s+/)[0] : null;
  const greeting  = firstName ? `Hi ${firstName},` : 'Hi,';

  const text = [
    greeting,
    '',
    "Thanks for chatting with me. As promised, here's the link to upload your processing statement:",
    '',
    'https://01payments.com/get-quote',
    '',
    "Just upload your most recent statement and we'll have your savings report back to you within minutes.",
    '',
    "If you don't have your statement handy, you can usually find it by:",
    '- Logging into your processor\'s online portal',
    '- Checking your email for last month\'s statement',
    '- Calling your processor and asking them to email you a copy',
    '',
    "Once we get your statement, we'll run it against every processor we work with and show you exactly where you can save.",
    '',
    'Talk soon,',
    'Alex',
    '01 Payments',
    '01payments.com',
  ].join('\n');

  await sendEmail({
    to,
    subject: 'Your free processing rate audit — 01 Payments',
    text,
  });
}

/**
 * Notify the owner (max@01payments.com) when the AI agent captures a lead on a cold call.
 */
export async function sendColdCallLeadNotification({ businessName, email, ownerName, phone }) {
  await sendEmail({
    to: 'max@01payments.com',
    subject: `New Lead Captured — ${businessName ?? 'Unknown Business'}`,
    text: [
      `New Lead Captured — ${businessName ?? 'Unknown Business'}`,
      '',
      `Email:  ${email}`,
      `Name:   ${ownerName ?? '—'}`,
      `Phone:  ${phone ?? '—'}`,
      '',
      'Upload link sent.',
      'Source: AI cold call.',
    ].join('\n'),
  });
}

/**
 * Notify the owner (max@01payments.com) that a new merchant application came in.
 * Includes all merchant fields, linked statement analysis, recommended processor, and action reminder.
 * @param {object} appData  — raw form body
 * @param {object} lead     — full lead record (may have savingsData from prior statement upload)
 */
export async function sendApplicationNotification(appData, lead) {
  const fmt = (n) => n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : '—';

  const businessName = appData.business_name ?? appData.businessName ?? 'Unknown Business';

  // All merchant fields (skip internal keys)
  const skipKeys = new Set(['leadId', 'fullName', 'businessName']);
  const merchantRows = Object.entries(appData)
    .filter(([k]) => !skipKeys.has(k))
    .map(([k, v]) => `${k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}: ${v ?? '—'}`)
    .join('\n');

  // Statement analysis section (if they uploaded a statement previously)
  const sd = lead?.savingsData;
  let analysisSection = '';
  if (sd?.monthly_volume) {
    const rec = sd.recommendation?.recommended ?? '—';
    analysisSection = [
      '',
      '── STATEMENT ANALYSIS ──────────────────────',
      `Current Processor: ${sd.current_processor ?? '—'}`,
      `Monthly Volume:    ${fmt(sd.monthly_volume)}`,
      `Processing Fees:   ${fmt(sd.processing_fees ?? sd.total_fees)}/mo (${sd.effective_rate != null ? sd.effective_rate.toFixed(2) + '%' : '—'} effective rate)`,
      ...(sd.platform_fees_total > 0 ? [`Platform Costs:    ${fmt(sd.platform_fees_total)}/mo (POS software, leases — excluded from savings calc)`] : []),
      `Recommended:       ${rec}`,
      `Merchant Saves:    ${fmt(sd.monthly_savings)}/mo (${fmt(sd.annual_savings)}/yr)`,
      `POS System:        ${sd.pos_system ?? lead?.posSystem ?? '—'}`,
      `Deal Difficulty:   ${sd.deal_difficulty ?? '—'}`,
    ].join('\n');
  }

  const fileUrl = lead?.uploadFilename
    ? `https://godmode.church/uploads/${lead.uploadFilename}?key=01payments`
    : null;

  const recommended = sd?.recommendation?.recommended;
  const processorName = recommended && recommended !== 'negotiate_existing'
    ? recommended.split(' — ')[0]
    : null;

  const actionLine = processorName
    ? `ACTION: Submit this application through the ${processorName} portal now.`
    : 'ACTION: Submit this application to the appropriate processor portal now.';

  const text = [
    `ACTION REQUIRED: New Application — ${businessName}`,
    '',
    '── MERCHANT INFO ───────────────────────────',
    merchantRows,
    analysisSection,
    '',
    fileUrl ? `Statement File: ${fileUrl}` : '',
    '',
    '────────────────────────────────────────────',
    actionLine,
  ].filter(l => l !== null && l !== undefined).join('\n');

  await sendEmail({
    to: 'max@01payments.com',
    subject: `ACTION REQUIRED: New Application — ${businessName}`,
    text,
  });
}

/**
 * Send the merchant a detailed step-by-step confirmation of their application.
 */
export async function sendApplicationConfirmation({ fullName, businessName, email }) {
  const name = (fullName ?? '').trim().split(/\s+/)[0] || 'there';
  await sendEmail({
    to: email,
    subject: `We received your application — ${businessName}`,
    text: [
      `Hi ${name},`,
      ``,
      `Thanks for choosing 01 Payments. We've received your application for ${businessName}.`,
      ``,
      `Here's what happens next:`,
      ``,
      `Step 1: We review your application and submit it to our processing partner (usually same day).`,
      ``,
      `Step 2: You'll receive an approval email, typically within 24 hours.`,
      ``,
      `Step 3: We ship your free terminal pre-programmed and ready to go. Most merchants receive it within 3-5 business days.`,
      ``,
      `Step 4: Plug it in and start processing. If you need help, our support team will walk you through setup over the phone.`,
      ``,
      `That's it. If you have any questions in the meantime, just reply to this email.`,
      ``,
      `Alex`,
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

  // Show top 5 options only in owner report (sorted by merchant savings, best first)
  const comparison = savingsData.top5_for_owner ?? savingsData.processor_comparison ?? [];
  const rec        = savingsData.recommendation ?? {};

  const difficultyColor = { easy: '#27ae60', medium: '#f39c12', hard: '#e74c3c' }[savingsData.deal_difficulty] ?? '#888';
  const difficultyLabel = savingsData.deal_difficulty ?? '—';

  const dealAssessment = `
    <div style="background:#f9f9f9;border:1px solid #e8e8e8;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.08em;">Deal Assessment</p>
      <table style="width:100%;font-size:13px;border-collapse:collapse;">
        <tr>
          <td style="padding:3px 0;color:#888;width:140px;">POS System</td>
          <td style="padding:3px 0;font-weight:600;">${savingsData.pos_system ?? '—'}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;color:#888;">Lock Status</td>
          <td style="padding:3px 0;">${
            savingsData.pos_lock_status === 'locked'
              ? '<span style="color:#e74c3c;font-weight:600;">Locked</span> — must switch hardware to change processors'
              : savingsData.pos_lock_status === 'reprogrammable'
                ? '<span style="color:#27ae60;font-weight:600;">Reprogrammable</span> — can change processors without new hardware'
                : savingsData.pos_compatible === true
                  ? '<span style="color:#27ae60;">Compatible</span>'
                  : '<span style="color:#888;">Unverified</span>'
          }</td>
        </tr>
        ${savingsData.compatible_processors?.length > 0 ? `<tr>
          <td style="padding:3px 0;color:#888;">Compatible With</td>
          <td style="padding:3px 0;">${savingsData.compatible_processors.map(p => p.toUpperCase()).join(', ')}</td>
        </tr>` : ''}
        <tr>
          <td style="padding:3px 0;color:#888;">Equipment Action</td>
          <td style="padding:3px 0;">${(() => {
            const ea = savingsData.best?.equipment_action ?? savingsData.equipment_action;
            const en = savingsData.best?.equipment_notes  ?? null;
            const labels = {
              reprogram_existing: '♻️ Reprogram existing terminal',
              keep_clover:        '✅ Keep existing Clover hardware',
              provide_free_pos:   '🆕 Provide free POS system',
              provide_free_terminal: '🆓 Provide free terminal',
              not_compatible:     '❌ Not compatible — hardware switch required',
              'negotiate existing': '🤝 Negotiate with current processor',
              replace:            '🔄 Replace hardware (free)',
              verify:             '🔍 Verify compatibility',
            };
            const label = labels[ea] ?? ea ?? '—';
            return en ? `${label}<br><span style="font-size:11px;color:#888;">${en}</span>` : label;
          })()}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;color:#888;">Volume Tier</td>
          <td style="padding:3px 0;">${savingsData.volume_tier ?? '—'}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;color:#888;">Deal Difficulty</td>
          <td style="padding:3px 0;font-weight:700;color:${difficultyColor};">${difficultyLabel.toUpperCase()}</td>
        </tr>
        ${lead.bestTimeToCall ? `<tr>
          <td style="padding:3px 0;color:#888;">Best Time to Call</td>
          <td style="padding:3px 0;">${lead.bestTimeToCall}</td>
        </tr>` : ''}
        ${(savingsData.hardware_preference ?? lead.hardwarePreference) ? (() => {
          const hwPref = savingsData.hardware_preference ?? lead.hardwarePreference;
          const hwLabels = { keep_hardware: 'Wants to keep current system', open_to_switch: 'Open to switching for better savings', wants_new: 'Actively wants new equipment' };
          const hwColor  = { keep_hardware: '#e67e22', open_to_switch: '#27ae60', wants_new: '#27ae60' };
          return `<tr>
            <td style="padding:3px 0;color:#888;">Hardware Preference</td>
            <td style="padding:3px 0;font-weight:600;color:${hwColor[hwPref] ?? '#333'};">${hwLabels[hwPref] ?? hwPref}</td>
          </tr>`;
        })() : ''}
        ${savingsData.margin_strategy ? `<tr>
          <td style="padding:3px 0;color:#888;">Margin Split</td>
          <td style="padding:3px 0;">Merchant ${savingsData.margin_strategy.merchant_gets_percent}% / Us ${savingsData.margin_strategy.we_keep_percent}% — <span style="color:#888;">${savingsData.margin_strategy.reason}</span></td>
        </tr>` : ''}
        ${savingsData.pricing_model ? `<tr>
          <td style="padding:3px 0;color:#888;">Pricing Model</td>
          <td style="padding:3px 0;">${savingsData.pricing_model}</td>
        </tr>` : ''}
        ${(savingsData.cnp_volume_percent ?? 0) > 0 ? `<tr>
          <td style="padding:3px 0;color:#888;">CNP Volume</td>
          <td style="padding:3px 0;color:#e67e22;">${savingsData.cnp_volume_percent}% card-not-present — interchange adjusted upward</td>
        </tr>` : ''}
      </table>
      ${savingsData.pos_recommendation ? `<p style="margin:10px 0 0;font-size:12px;color:#555;line-height:1.5;">${savingsData.pos_recommendation}</p>` : ''}
      ${rec.volume_note ? `<p style="margin:6px 0 0;font-size:12px;color:#555;line-height:1.5;">${rec.volume_note}</p>` : ''}
      ${(() => {
        const dh = savingsData.debit_savings_highlight;
        if (!dh) return '';
        return `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #eee;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#e67e22;text-transform:uppercase;letter-spacing:.06em;">Debit Savings Breakdown</p>
          <table style="width:100%;font-size:12px;color:#555;">
            <tr><td style="padding:2px 0;width:160px;">Debit Volume Est.</td><td>$${Number(dh.debit_volume).toFixed(0)}/mo (${dh.debit_percent_used}% of volume)</td></tr>
            <tr><td style="padding:2px 0;">Debit Transactions</td><td>${dh.debit_transactions}</td></tr>
            <tr><td style="padding:2px 0;">Current Debit Cost</td><td style="color:#c0392b;">$${Number(dh.current_debit_cost).toFixed(2)}/mo</td></tr>
            <tr><td style="padding:2px 0;">IC+ Debit Cost</td><td style="color:#27ae60;">$${Number(dh.interchange_plus_debit_cost).toFixed(2)}/mo</td></tr>
            <tr><td style="padding:2px 0;font-weight:600;">Debit Savings</td><td style="color:#27ae60;font-weight:600;">$${Number(dh.debit_savings).toFixed(2)}/mo</td></tr>
          </table>
          <p style="margin:6px 0 0;font-size:11px;color:#888;">${dh.debit_savings_note}</p>
        </div>`;
      })()}
    </div>`;

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

            ${dealAssessment}

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
                <td style="padding:4px 0;color:#888;">Processing Fees</td>
                <td style="padding:4px 0;color:#c0392b;">${fmt(savingsData.processing_fees ?? savingsData.total_fees)}/mo</td>
                <td style="padding:4px 0;color:#888;">Transactions</td>
                <td style="padding:4px 0;">${savingsData.transaction_count?.toLocaleString() ?? '—'}</td>
              </tr>
              ${(savingsData.platform_fees_total > 0 || (Array.isArray(savingsData.platform_fees) && savingsData.platform_fees.length > 0)) ? `<tr>
                <td style="padding:4px 0;color:#888;">Platform Costs</td>
                <td colspan="3" style="padding:4px 0;color:#888;font-size:12px;">${fmt(savingsData.platform_fees_total)}/mo — ${(savingsData.platform_fees ?? []).map(f => f.name).join(', ') || 'POS/SaaS fees'} <em>(excluded from savings calc)</em></td>
              </tr>` : ''}
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

            ${(savingsData.secondary_options ?? []).length > 0 ? `
            <!-- Secondary options -->
            <div style="background:#fffbf0;border-left:4px solid #f39c12;border-radius:6px;padding:14px 20px;margin:12px 0 0;">
              <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#f39c12;text-transform:uppercase;letter-spacing:.05em;">Secondary Options (Fallback Only)</p>
              ${(savingsData.secondary_options ?? []).map(p => `
                <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#333;">${p.processor} — ${p.tier}</p>
                <p style="margin:0 0 4px;font-size:12px;color:#555;">Floor: ${(p.floor_cost ?? 0).toFixed(2)} | Merchant pays: ${(p.proposed_merchant_fees ?? 0).toFixed(2)}/mo | Saves: ${(p.merchant_monthly_savings ?? 0).toFixed(2)}/mo | Our residual: ${(p.our_monthly_residual ?? 0).toFixed(2)}/mo | Yr1: ${(p.first_year_total_income ?? 0).toFixed(2)}</p>
                ${p.note ? `<p style="margin:0 0 2px;font-size:12px;color:#888;">${p.note}</p>` : ''}
                ${p.pci_risk_note ? `<p style="margin:0;font-size:11px;color:#e74c3c;">${p.pci_risk_note}</p>` : ''}
              `).join('')}
            </div>` : ''}

            ${(savingsData.manual_review_flags ?? []).length > 0 ? `
            <!-- Manual review flags -->
            <div style="background:#fff8f8;border-left:4px solid #e74c3c;border-radius:6px;padding:12px 20px;margin:12px 0 0;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#e74c3c;text-transform:uppercase;letter-spacing:.05em;">Manual Review Required</p>
              ${(savingsData.manual_review_flags ?? []).map(f => `<p style="margin:0 0 2px;font-size:12px;color:#555;">⚠ ${f}</p>`).join('')}
            </div>` : ''}

            <p style="margin:16px 0 0;font-size:12px;color:#aaa;">
              70/30 margin split — merchant gets 70% of savings gap, we keep 30%.
              BIN sponsorship is a pure pass-through cost and is not included in the split.
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
