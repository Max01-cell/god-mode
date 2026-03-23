/**
 * In-memory leads store.
 * Each lead is keyed by a UUID and holds submission data + analysis results.
 */

export const leads = new Map();

export function createLead({ fullName, businessName, phone, email, fileName, fileSize, fileType }) {
  const id = crypto.randomUUID();
  const lead = {
    id,
    fullName,
    businessName,
    phone,
    email,
    fileName,
    fileSize,
    fileType,
    submittedAt: new Date().toISOString(),
    analysisStatus: 'pending', // 'pending' | 'complete' | 'failed'
    savingsData: null,
    analysisError: null,
  };
  leads.set(id, lead);
  return lead;
}

export function updateLead(id, patch) {
  const lead = leads.get(id);
  if (!lead) return null;
  Object.assign(lead, patch);
  return lead;
}
