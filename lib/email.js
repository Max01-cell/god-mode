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

/**
 * Send the prospect their savings report HTML email.
 */
export async function sendSavingsReport(lead, savingsData) {
  const fmt = (n) => n != null
    ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
    : 'N/A';

  const fmtRate = (r) => r != null ? `${Number(r).toFixed(2)}%` : 'N/A';

  const hiddenFeesRows = (savingsData.hidden_fees ?? []).length > 0
    ? savingsData.hidden_fees.map(f => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${f.name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#c0392b;">${fmt(f.amount)}/mo</td>
        </tr>`).join('')
    : '';

  const hiddenFeesSection = hiddenFeesRows ? `
    <div style="margin:28px 0 0;">
      <h3 style="margin:0 0 12px;font-size:15px;color:#333;">Hidden Fees We Found</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="background:#fff8f8;">
            <th style="padding:8px 12px;text-align:left;color:#999;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Fee</th>
            <th style="padding:8px 12px;text-align:right;color:#999;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Monthly Cost</th>
          </tr>
        </thead>
        <tbody>${hiddenFeesRows}</tbody>
      </table>
      <p style="margin:10px 0 0;font-size:13px;color:#888;">These fees go away entirely with our processor.</p>
    </div>` : '';

  // Use best processor numbers if comparison available
  const best = Array.isArray(savingsData.comparison) && savingsData.comparison.length > 0
    ? savingsData.comparison[0] : null;

  const proposed_rate   = best?.effective_rate   ?? savingsData.proposed_rate;
  const proposed_fees   = best?.estimated_monthly_fees ?? savingsData.proposed_fees;
  const monthly_savings = best?.monthly_savings   ?? savingsData.monthly_savings;
  const annual_savings  = best?.annual_savings    ?? savingsData.annual_savings;

  // Processor comparison table (only if 2+ options)
  const comparisonRows = (savingsData.comparison ?? []).slice(0, 4).map(p => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-weight:${p.rank === 1 ? '600' : '400'};color:${p.rank === 1 ? '#1a1a1a' : '#555'};">
        ${p.rank === 1 ? '★ ' : ''}${p.processor_name}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#27ae60;">${fmtRate(p.effective_rate)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${fmt(p.estimated_monthly_fees)}/mo</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#27ae60;">${p.monthly_savings != null ? `Save ${fmt(p.monthly_savings)}/mo` : '—'}</td>
    </tr>`).join('');

  const comparisonSection = comparisonRows ? `
    <div style="margin:28px 0 0;">
      <h3 style="margin:0 0 12px;font-size:15px;color:#333;">Rate Comparison Across Processors</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f9f9f9;">
            <th style="padding:8px 12px;text-align:left;color:#999;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;">Processor</th>
            <th style="padding:8px 12px;text-align:right;color:#999;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;">Rate</th>
            <th style="padding:8px 12px;text-align:right;color:#999;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;">Monthly Cost</th>
            <th style="padding:8px 12px;text-align:right;color:#999;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;">vs. Current</th>
          </tr>
        </thead>
        <tbody>${comparisonRows}</tbody>
      </table>
      <p style="margin:10px 0 0;font-size:12px;color:#aaa;">★ Best match for your business</p>
    </div>` : '';

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

            <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:8px;">
              <thead>
                <tr style="background:#f9f9f9;">
                  <th style="padding:10px 12px;text-align:left;color:#999;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;"></th>
                  <th style="padding:10px 12px;text-align:right;color:#999;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Current</th>
                  <th style="padding:10px 12px;text-align:right;color:#999;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">With 01 Payments</th>
                </tr>
              </thead>
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
                ${savingsData.transaction_count != null ? `
                <tr>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#555;">Transactions</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;" colspan="2">${Number(savingsData.transaction_count).toLocaleString()}</td>
                </tr>` : ''}
              </tbody>
            </table>

            ${hiddenFeesSection}
            ${comparisonSection}

            <div style="background:#f0faf4;border-left:4px solid #27ae60;border-radius:6px;padding:20px 24px;margin:28px 0;">
              <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#27ae60;text-transform:uppercase;letter-spacing:.05em;">Your Estimated Savings</p>
              <p style="margin:0;font-size:28px;font-weight:700;color:#1a1a1a;">${fmt(monthly_savings)}<span style="font-size:14px;font-weight:400;color:#888;">/month</span></p>
              <p style="margin:4px 0 0;font-size:15px;color:#555;">${fmt(annual_savings)} per year</p>
            </div>

            <p style="margin:0 0 12px;font-size:14px;color:#555;line-height:1.6;">
              Ready to move forward? No contract, no setup fee — we handle the entire switch.
              Reply to this email or just hit the button below.
            </p>
            <p style="margin:0 0 28px;font-size:13px;color:#888;">
              We get paid by the processor, not by you. You just get the lower rate.
            </p>

            <a href="mailto:maxh707@gmail.com?subject=Ready%20to%20switch%20%E2%80%94%20${encodeURIComponent(lead.businessName)}"
               style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:7px;font-size:15px;font-weight:600;">
              Get Started
            </a>

          </td>
        </tr>

        <tr>
          <td style="padding:20px 36px;border-top:1px solid #f0f0f0;">
            <p style="margin:0;font-size:12px;color:#aaa;">
              01 Payments · ISO Agent · Savings estimates are based on your submitted statement and
              interchange-plus pricing across 4 processors. Actual savings may vary based on card mix and transaction types.
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
