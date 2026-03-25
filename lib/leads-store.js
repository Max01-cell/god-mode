import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEADS_FILE = join(__dirname, '../leads.json');

export const leads = new Map();

// Load persisted leads from disk on startup
if (existsSync(LEADS_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(LEADS_FILE, 'utf8'));
    for (const lead of saved) {
      leads.set(lead.id, lead);
    }
    console.log(`[leads-store] loaded ${leads.size} leads from disk`);
  } catch (err) {
    console.warn('[leads-store] could not load leads.json:', err.message);
  }
}

function persist() {
  try {
    writeFileSync(LEADS_FILE, JSON.stringify([...leads.values()], null, 2));
  } catch (err) {
    console.warn('[leads-store] could not write leads.json:', err.message);
  }
}

export const LEAD_STATUSES = [
  'link_sent',
  'statement_received',
  'report_sent',
  'application_received',
  'submitted_to_processor',
  'approved',
  'live',
];

export function createLead({ fullName, businessName, phone, email, fileName, fileSize, fileType, uploadFilename, source, status }) {
  const id = globalThis.crypto?.randomUUID() ?? Math.random().toString(36).slice(2);
  const lead = {
    id,
    fullName,
    businessName,
    phone,
    email,
    fileName:       fileName       ?? null,
    fileSize:       fileSize       ?? null,
    fileType:       fileType       ?? null,
    uploadFilename: uploadFilename ?? null,
    source:         source         ?? null,
    status:         status         ?? null,
    submittedAt: new Date().toISOString(),
    analysisStatus: 'pending',
    savingsData: null,
    analysisError: null,
  };
  leads.set(id, lead);
  persist();
  return lead;
}

export function updateLead(id, patch) {
  const lead = leads.get(id);
  if (!lead) return null;
  Object.assign(lead, patch);
  persist();
  return lead;
}
