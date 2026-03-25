import 'dotenv/config';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import fastifyCors from '@fastify/cors';
import { registerRetellLLM } from './retell-llm.js';
import { registerRetellCalls } from './retell-calls.js';
import { existsSync } from 'fs';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { createLead, updateLead, leads, LEAD_STATUSES } from './lib/leads-store.js';
import { analyzeStatement } from './lib/analyze-statement.js';
import { sendOwnerNotification, sendOwnerAnalysisFailure, sendSavingsReport, sendOwnerAnalysisReport, sendApplicationNotification, sendApplicationConfirmation, sendUploadLinkEmail, sendColdCallLeadNotification } from './lib/email.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const UPLOADS_DIR = join(__dirname, 'uploads');
await mkdir(UPLOADS_DIR, { recursive: true });

const DASHBOARD_KEY = process.env.DASHBOARD_KEY ?? '01payments';

const {
  TWILIO_PHONE_NUMBER,
  PUBLIC_URL,
  PORT = '3000',
} = process.env;

if (!PUBLIC_URL) {
  console.error('Missing required environment variables. Check your .env file.');
  process.exit(1);
}

const callLogs = [];

// ── Server ───────────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: true });
await fastify.register(fastifyCors, {
  origin: ['https://01payments.com', 'https://www.01payments.com'],
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  preflightContinue: false,   // fastify-cors handles OPTIONS and returns 204 automatically
  optionsSuccessStatus: 204,
});
await fastify.register(fastifyFormBody);
await fastify.register(fastifyMultipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
    files: 1,
  },
});
await fastify.register(fastifyWs);

registerRetellLLM(fastify);
registerRetellCalls(fastify);

// ── HTTP endpoints ────────────────────────────────────────────────────────────

fastify.post('/batch-call', async (req, reply) => {
  const { calls } = req.body ?? {};
  if (!Array.isArray(calls) || calls.length === 0) {
    return reply.status(400).send({ error: '"calls" must be a non-empty array' });
  }

  const results = [];
  for (const item of calls) {
    const { to, business_data } = item;
    if (!to) { results.push({ to, error: 'Missing "to" field' }); continue; }

    try {
      const digits = to.replace(/\D/g, '');
      const toNumber = digits.length === 10 ? `+1${digits}` : `+${digits}`;

      const res = await fetch('https://api.retellai.com/v2/create-phone-call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
        },
        body: JSON.stringify({
          agent_id: process.env.RETELL_AGENT_ID,
          from_number: TWILIO_PHONE_NUMBER,
          to_number: toNumber,
          metadata: { callType: 'cold_call', businessData: business_data ?? {} },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Retell API ${res.status}: ${body}`);
      }

      const call = await res.json();
      results.push({ to, callId: call.call_id, status: call.call_status });
    } catch (err) {
      results.push({ to, error: err.message });
    }
  }

  reply.send({ results });
});

fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

fastify.get('/logs', async (_req, reply) => reply.send(callLogs));

fastify.get('/leads', async (_req, reply) => reply.send([...leads.values()]));

fastify.get('/analyze-rates/:leadId', async (req, reply) => {
  const lead = leads.get(req.params.leadId);
  if (!lead) return reply.status(404).send({ error: 'Lead not found' });
  if (lead.analysisStatus === 'pending') {
    return reply.status(202).send({ status: 'pending', message: 'Analysis still in progress' });
  }
  if (lead.analysisStatus === 'failed') {
    return reply.status(422).send({ status: 'failed', error: lead.analysisError });
  }
  const { comparison, monthly_volume, total_fees, current_processor, effective_rate } = lead.savingsData ?? {};
  return reply.send({
    leadId: lead.id,
    businessName: lead.businessName,
    current_processor,
    monthly_volume,
    current_fees: total_fees,
    effective_rate,
    comparison: comparison ?? [],
  });
});

// ── File serving ─────────────────────────────────────────────────────────────

const MIME_MAP = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

fastify.get('/uploads/:filename', async (req, reply) => {
  if (req.query.key !== DASHBOARD_KEY) return reply.status(401).send('Unauthorized');
  const filename = req.params.filename.replace(/\.\./g, ''); // prevent path traversal
  const filePath = join(UPLOADS_DIR, filename);
  if (!existsSync(filePath)) return reply.status(404).send('Not found');
  const ext = extname(filename).toLowerCase();
  const contentType = MIME_MAP[ext] ?? 'application/octet-stream';
  const data = await readFile(filePath);
  reply.type(contentType).send(data);
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  link_sent:              '#8e44ad',
  statement_received:     '#2980b9',
  report_sent:            '#16a085',
  application_received:   '#d35400',
  submitted_to_processor: '#f39c12',
  approved:               '#27ae60',
  live:                   '#1abc9c',
};

const STATUS_LABELS = {
  link_sent:              'Link Sent',
  statement_received:     'Statement Received',
  report_sent:            'Report Sent',
  application_received:   'Application Received',
  submitted_to_processor: 'Submitted to Processor',
  approved:               'Approved',
  live:                   'Live',
};

fastify.get('/dashboard', async (req, reply) => {
  if (req.query.key !== DASHBOARD_KEY) return reply.status(401).send('Unauthorized');

  const fmt = (n) => n != null ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : '—';
  const allLeads = [...leads.values()].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

  const statusOptions = LEAD_STATUSES.map(s =>
    `<option value="${s}">${STATUS_LABELS[s] ?? s}</option>`
  ).join('');

  const rows = allLeads.map(lead => {
    const sd = lead.savingsData;
    const fileLink = lead.uploadFilename
      ? `<a href="/uploads/${lead.uploadFilename}?key=${DASHBOARD_KEY}" target="_blank">View File</a>`
      : '—';

    const analysisBadge = {
      pending:  '<span style="color:#f39c12;font-size:11px;">⏳ analyzing</span>',
      complete: '<span style="color:#27ae60;font-size:11px;">✓ done</span>',
      failed:   '<span style="color:#e74c3c;font-size:11px;">✗ failed</span>',
    }[lead.analysisStatus] ?? '';

    const savingsLine = sd?.monthly_savings != null
      ? `<small style="color:#27ae60;">Save ${fmt(sd.monthly_savings)}/mo · ${sd.recommendation?.recommended ?? ''}</small>`
      : lead.analysisError ? `<small style="color:#e74c3c;">${lead.analysisError}</small>` : '';

    const currentStatus = lead.status ?? '';
    const statusColor   = STATUS_COLORS[currentStatus] ?? '#aaa';
    const statusLabel   = STATUS_LABELS[currentStatus] ?? (currentStatus || 'Unknown');

    const selectOpts = LEAD_STATUSES.map(s =>
      `<option value="${s}"${s === currentStatus ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`
    ).join('');

    return `<tr id="row-${lead.id}">
      <td style="white-space:nowrap;font-size:12px;color:#888;">${new Date(lead.submittedAt).toLocaleString()}</td>
      <td><strong>${lead.fullName}</strong><br><span style="font-size:11px;color:#888;">${lead.source ?? ''}</span></td>
      <td>${lead.businessName}</td>
      <td style="white-space:nowrap;">${lead.phone || '—'}</td>
      <td><a href="mailto:${lead.email}" style="font-size:13px;">${lead.email}</a></td>
      <td style="font-size:12px;">
        ${fileLink}
        ${analysisBadge}
        ${savingsLine}
        ${sd?.pos_system ? `<small style="color:#888;">POS: ${sd.pos_system}</small>` : lead.posSystem ? `<small style="color:#888;">POS: ${lead.posSystem}</small>` : ''}
        ${sd?.deal_difficulty ? `<small style="color:${STATUS_COLORS[sd.deal_difficulty] ?? '#888'};">Difficulty: ${sd.deal_difficulty}</small>` : ''}
      </td>
      <td>
        <span class="status-badge" style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;color:#fff;background:${statusColor};margin-bottom:6px;">${statusLabel}</span><br>
        <select class="status-select" data-lead="${lead.id}" style="font-size:12px;padding:3px 6px;border:1px solid #ddd;border-radius:4px;margin-right:4px;">
          ${selectOpts}
        </select>
        <button onclick="saveStatus('${lead.id}', this)" style="font-size:12px;padding:3px 10px;background:#0a0a0a;color:#fff;border:none;border-radius:4px;cursor:pointer;">Save</button>
      </td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>01 Payments — Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 24px; background: #f6f7fb; color: #1a1a1a; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: #888; font-size: 13px; margin: 0 0 20px; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
    .legend span { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; color: #fff; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 6px rgba(0,0,0,.08); font-size: 13px; }
    th { padding: 10px 14px; text-align: left; background: #f9f9f9; color: #999; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #f0f0f0; white-space: nowrap; }
    td { padding: 10px 14px; border-bottom: 1px solid #f5f5f5; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }
    a { color: #0a0a0a; }
    small { display: block; margin-top: 3px; }
    .toast { position: fixed; bottom: 24px; right: 24px; background: #1a1a1a; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
    .toast.show { opacity: 1; }
  </style>
</head>
<body>
  <h1>01 Payments — Dashboard</h1>
  <p class="sub">${allLeads.length} lead${allLeads.length !== 1 ? 's' : ''} total</p>

  <div class="legend">
    ${LEAD_STATUSES.map(s => `<span style="background:${STATUS_COLORS[s] ?? '#aaa'};">${STATUS_LABELS[s]}</span>`).join('')}
  </div>

  <table>
    <thead>
      <tr>
        <th>Submitted</th>
        <th>Name</th>
        <th>Business</th>
        <th>Phone</th>
        <th>Email</th>
        <th>Statement / Analysis</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#aaa;padding:40px;">No leads yet</td></tr>'}</tbody>
  </table>

  <div class="toast" id="toast"></div>

  <script>
    const KEY = '${DASHBOARD_KEY}';
    const STATUS_COLORS = ${JSON.stringify(STATUS_COLORS)};
    const STATUS_LABELS = ${JSON.stringify(STATUS_LABELS)};

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }

    async function saveStatus(leadId, btn) {
      const row = document.getElementById('row-' + leadId);
      const select = row.querySelector('.status-select');
      const status = select.value;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const res = await fetch('/leads/' + leadId + '/status?key=' + KEY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error(await res.text());
        const badge = row.querySelector('.status-badge');
        badge.textContent = STATUS_LABELS[status] ?? status;
        badge.style.background = STATUS_COLORS[status] ?? '#aaa';
        showToast('Status updated → ' + (STATUS_LABELS[status] ?? status));
      } catch (e) {
        showToast('Error: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    }
  </script>
</body>
</html>`;

  reply.type('text/html').send(html);
});

// ── Statement upload + analysis ───────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

fastify.post('/submit-statement', async (req, reply) => {
  // Parse multipart fields and file
  const parts = req.parts();

  const fields = {};
  let fileBuffer = null;
  let fileName = null;
  let fileType = null;

  for await (const part of parts) {
    if (part.type === 'file') {
      if (part.fieldname !== 'statement' && part.fieldname !== 'file') continue;

      fileType = part.mimetype;
      fileName = part.filename;

      const chunks = [];
      for await (const chunk of part.file) {
        chunks.push(chunk);
      }
      fileBuffer = Buffer.concat(chunks);
    } else {
      fields[part.fieldname] = part.value;
    }
  }

  // Accept both naming conventions (server-style and form-style)
  const fullName           = fields.fullName           ?? fields.name;
  const businessName       = fields.businessName       ?? fields.business_name;
  const posSystem          = fields.posSystem          ?? fields.pos_system          ?? null;
  const bestTimeToCall     = fields.bestTimeToCall     ?? fields.best_time_to_call   ?? null;
  const hardwarePreference = fields.hardwarePreference ?? fields.hardware_preference ?? null;
  const { phone, email } = fields;

  if (!fullName || !businessName || !phone || !email) {
    return reply.status(400).send({ error: 'Missing required fields' });
  }

  if (!fileBuffer || !fileBuffer.length) {
    return reply.status(400).send({ error: 'Missing file upload (field name: statement)' });
  }

  if (!ALLOWED_MIME_TYPES.has(fileType)) {
    return reply.status(400).send({ error: 'Unsupported file type. Upload a PDF, PNG, or JPG.' });
  }

  // 1. Save lead
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const lead = createLead({ fullName, businessName, phone, email, fileName, fileSize: fileBuffer.length, fileType });
  const uploadFilename = `${lead.id}-${safeFileName}`;
  await writeFile(join(UPLOADS_DIR, uploadFilename), fileBuffer);
  updateLead(lead.id, { uploadFilename, posSystem, bestTimeToCall, hardwarePreference });
  fastify.log.info('[submit-statement] new lead %s — %s (%s) — saved as %s', lead.id, businessName, email, uploadFilename);

  // 2. Notify owner immediately (don't await — don't block the response)
  sendOwnerNotification({ ...lead, uploadFilename }).catch((err) =>
    fastify.log.error('[email] owner notification failed: %s', err.message)
  );

  // 3. Run analysis + send prospect email in background
  setImmediate(async () => {
    try {
      fastify.log.info('[analysis] starting for lead %s', lead.id);
      const savingsData = await analyzeStatement(fileBuffer, fileType, { pos_system: posSystem, best_time_to_call: bestTimeToCall, hardware_preference: hardwarePreference });

      const updatedLead = updateLead(lead.id, { analysisStatus: 'complete', savingsData });
      fastify.log.info('[analysis] complete for lead %s — monthly savings: %s', lead.id, savingsData.monthly_savings);

      // Send savings report to prospect (best-for-merchant only)
      await sendSavingsReport({ ...lead, uploadFilename }, savingsData);
      updateLead(lead.id, { status: 'report_sent' });
      fastify.log.info('[email] savings report sent to %s', email);

      // Send internal analysis report to owner (all processor options)
      await sendOwnerAnalysisReport({ ...lead, uploadFilename }, savingsData);
      fastify.log.info('[email] owner analysis report sent');
    } catch (err) {
      fastify.log.error('[analysis] failed for lead %s: %s', lead.id, err.message);
      updateLead(lead.id, { analysisStatus: 'failed', analysisError: err.message });

      // Notify owner so they can handle manually
      sendOwnerAnalysisFailure(lead, err.message).catch((e) =>
        fastify.log.error('[email] failure notification failed: %s', e.message)
      );
    }
  });

  // Mark status as statement_received now that file is saved
  updateLead(lead.id, { status: 'statement_received' });

  // 4. Return immediately — analysis runs in background
  reply.send({ ok: true, leadId: lead.id, message: 'Statement received. Your savings report will be emailed to you shortly.' });
});

// ── Lead status update ────────────────────────────────────────────────────────

fastify.post('/leads/:leadId/status', async (req, reply) => {
  if (req.query.key !== DASHBOARD_KEY) return reply.status(401).send({ error: 'Unauthorized' });
  const { status } = req.body ?? {};
  if (!LEAD_STATUSES.includes(status)) {
    return reply.status(400).send({ error: `Invalid status. Must be one of: ${LEAD_STATUSES.join(', ')}` });
  }
  const lead = updateLead(req.params.leadId, { status });
  if (!lead) return reply.status(404).send({ error: 'Lead not found' });
  reply.send({ ok: true, leadId: lead.id, status: lead.status });
});

// ── Merchant application ───────────────────────────────────────────────────────

fastify.post('/submit-application', async (req, reply) => {
  const body = req.body ?? {};

  // Normalize name fields
  const fullName     = body.fullName     ?? body.full_name ?? body.name;
  const businessName = body.businessName ?? body.business_name;
  const email        = body.email;
  const phone        = body.phone;

  if (!fullName || !businessName || !email) {
    return reply.status(400).send({ error: 'Missing required fields: name, business name, and email are required.' });
  }

  // Link to existing lead if email matches, otherwise create a new one
  const existingLead = [...leads.values()].find(l => l.email?.toLowerCase() === email.toLowerCase());

  let lead;
  if (existingLead) {
    lead = updateLead(existingLead.id, {
      applicationData: body,
      applicationSubmittedAt: new Date().toISOString(),
      status: 'application_received',
      // Fill in any missing contact info from the application
      fullName:     existingLead.fullName     || fullName,
      businessName: existingLead.businessName || businessName,
      phone:        existingLead.phone        || phone,
    });
    fastify.log.info('[submit-application] linked to existing lead %s — %s', lead.id, businessName);
  } else {
    lead = createLead({ fullName, businessName, phone: phone ?? '', email, source: 'application', status: 'application_received' });
    updateLead(lead.id, { applicationData: body, applicationSubmittedAt: new Date().toISOString() });
    fastify.log.info('[submit-application] new lead %s — %s', lead.id, businessName);
  }

  // Fire both emails (non-blocking)
  sendApplicationNotification({ ...body, fullName, businessName, email }, lead).catch(err =>
    fastify.log.error('[email] application notification failed: %s', err.message)
  );
  sendApplicationConfirmation({ fullName, businessName, email }).catch(err =>
    fastify.log.error('[email] application confirmation failed: %s', err.message)
  );

  reply.send({
    ok: true,
    leadId: lead.id,
    message: 'Application submitted! Check your email for confirmation. We\'ll be in touch within 24 hours.',
  });
});


// ── Start ─────────────────────────────────────────────────────────────────────

await fastify.listen({ port: parseInt(PORT, 10), host: '0.0.0.0' });
