import { buildEnrollmentView } from './enrollment-state.js';

const fields = ["reference", "eventId", "name", "slot", "requestedAt", "desiredStatus"];

function operationRows(records) {
  return records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  }));
}

/**
 * Business read entry. Source observations keep their existing shape in
 * `rows`. When the repository also holds enrollment state, the same call
 * exposes candidates, successes, waitlist order and the receipt ledger so
 * that source intake and portal-confirmed enrollment cannot be read as two
 * different truths.
 */
export async function readOperations(repository, options = {}) {
  const records = await repository.read();
  const base = { product: "社区活动报名台账", rows: operationRows(records) };
  if (typeof repository.readEnrollment !== 'function') return base;
  const state = await repository.readEnrollment();
  const view = buildEnrollmentView(state, { rows: base.rows, ...options });
  return { ...base, ...view };
}
