const JOIN = 'join';
const CANCEL = 'cancel';

export const enrollmentProduct = '社区活动报名台账';

export function timestamp(clock = () => new Date()) {
  const value = typeof clock === 'function' ? clock() : clock;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function text(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function isDate(value) {
  return Number.isFinite(Date.parse(value));
}

/**
 * Accepts either a normalized source record (with attributes) or a raw
 * source item. Identity is the resident reference, not the source row id:
 * one reference describes one application and must never take two places.
 */
export function normalizeRequest(input) {
  const record = asObject(input);
  if (!record) throw new TypeError('resident request must be an object');
  const attributes = asObject(record.attributes) ?? record;
  const reference = text(attributes.reference ?? record.sourceId);
  if (!reference) throw new Error('resident request requires reference');
  const slot = text(attributes.slot ?? record.slot);
  if (!slot) throw new Error(`resident request ${reference} requires slot`);
  const observedAt = text(record.observedAt ?? attributes.observedAt ?? attributes.requestedAt);
  const requestedAt = text(attributes.requestedAt ?? observedAt);
  if (!isDate(requestedAt)) throw new Error(`resident request ${reference} has invalid requestedAt`);
  if (observedAt && !isDate(observedAt)) throw new Error(`resident request ${reference} has invalid observedAt`);
  const desiredStatus = text(attributes.desiredStatus ?? record.desiredStatus).toLowerCase() === CANCEL
    ? CANCEL : JOIN;
  return {
    reference,
    eventId: text(attributes.eventId ?? record.eventId),
    name: text(attributes.name ?? record.name ?? reference) || reference,
    slot,
    requestedAt: isDate(requestedAt) ? new Date(requestedAt).toISOString() : requestedAt,
    observedAt: observedAt || requestedAt,
    desiredStatus,
  };
}

export function createCandidate(request, { now = timestamp() } = {}) {
  return {
    reference: request.reference,
    eventId: request.eventId,
    name: request.name,
    slot: request.slot,
    requestedAt: request.requestedAt,
    desiredStatus: request.desiredStatus,
    // A request is only a candidate. It becomes confirmed only by joining to
    // a receipt obtained from the portal.
    status: request.desiredStatus === CANCEL ? 'cancelling' : 'pending',
    receipt: null,
    waitlist: null,
    sourceObservedAt: request.observedAt,
    // The last source observation actually applied, plus whether the current
    // desiredStatus came from the source or from a local operator action.
    sourceObservation: {
      observedAt: request.observedAt,
      desiredStatus: request.desiredStatus,
    },
    localIntent: false,
    observedAt: request.observedAt,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    lastError: null,
    resolvedAt: null,
  };
}

function compareTime(left, right) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return text(left).localeCompare(text(right));
}

/**
 * Applies one source observation. Older observations are ignored so that a
 * replayed "join" page cannot overwrite a newer resident cancellation.
 */
export function applyRequest(candidate, request, { now = timestamp() } = {}) {
  if (!candidate) return { candidate: createCandidate(request, { now }), applied: true, reason: 'created' };
  const previous = candidate.sourceObservation ?? {
    observedAt: candidate.sourceObservedAt,
    desiredStatus: candidate.desiredStatus,
  };
  const ordering = compareTime(request.observedAt, previous.observedAt);
  if (ordering < 0) {
    return { candidate, applied: false, reason: 'older-observation' };
  }
  if (ordering === 0) {
    if (candidate.desiredStatus !== previous.desiredStatus) {
      // An equal-time page describes the same source observation; never let it
      // overturn a newer local operator decision.
      return { candidate, applied: false, reason: 'unchanged-observation' };
    }
    if (request.desiredStatus === previous.desiredStatus) {
      // Replaying the same page is not a new application: keep every receipt,
      // waitlist position and failure already earned by it.
      return { candidate, applied: false, reason: 'unchanged-observation' };
    }
    // Equal timestamp but the source itself changed status: treat it as
    // authoritative.
  }
  const next = {
    ...candidate,
    eventId: request.eventId || candidate.eventId,
    name: request.name || candidate.name,
    slot: request.slot || candidate.slot,
    requestedAt: request.requestedAt || candidate.requestedAt,
    sourceObservedAt: request.observedAt || candidate.sourceObservedAt,
    sourceObservation: {
      observedAt: request.observedAt || previous.observedAt,
      desiredStatus: request.desiredStatus,
    },
    observedAt: request.observedAt || candidate.observedAt,
    localIntent: false,
    updatedAt: now,
  };
  if (request.desiredStatus === CANCEL && candidate.desiredStatus !== CANCEL) {
    next.desiredStatus = CANCEL;
    next.status = 'cancelling';
    next.waitlist = null;
    return { candidate: next, applied: true, reason: 'cancel-requested' };
  }
  if (request.desiredStatus === JOIN && candidate.desiredStatus === CANCEL) {
    // A newer join observation is a fresh application, not a revival of the
    // old receipt. Old receipts remain in the receipt ledger as cancelled.
    next.desiredStatus = JOIN;
    next.status = 'pending';
    next.receipt = null;
    next.waitlist = null;
    next.attempts = 0;
    next.lastError = null;
    next.resolvedAt = null;
    next.reappliedFrom = candidate.status;
    return { candidate: next, applied: true, reason: 'reapplied' };
  }
  if (request.desiredStatus === JOIN && candidate.status === 'cancelled') {
    // The resident cancelled and later asked to join again. The source has no
    // memory of our receipt, so this is a new application that must earn a new
    // receipt; the old one stays cancelled in the ledger.
    next.status = 'pending';
    next.receipt = null;
    next.waitlist = null;
    next.attempts = 0;
    next.lastError = null;
    next.resolvedAt = null;
    next.reappliedFrom = 'cancelled';
    return { candidate: next, applied: true, reason: 'reapplied' };
  }
  return { candidate: next, applied: true, reason: 'updated' };
}

function revisionOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeReceipt(booking, {
  reference, eventId = '', slot = '', now = timestamp(),
} = {}) {
  const value = asObject(booking);
  if (!value) return { ok: false, reason: 'invalid-booking' };
  const id = text(value.receipt);
  if (!id) return { ok: false, reason: 'missing-receipt' };
  const bookingReference = text(value.reference);
  if (reference && bookingReference && bookingReference !== reference) {
    return { ok: false, reason: 'reference-mismatch', receipt: id };
  }
  const rawStatus = text(value.status).toLowerCase();
  const status = rawStatus === 'cancelled' ? 'cancelled' : rawStatus === 'confirmed' ? 'confirmed' : null;
  if (!status) return { ok: false, reason: 'unknown-status', receipt: id };
  const receipt = {
    receipt: id,
    reference: bookingReference || reference,
    eventId,
    slot: text(value.slot ?? slot),
    name: value.name === undefined || value.name === null ? null : String(value.name),
    status,
    revision: revisionOf(value.revision),
    firstSeenAt: now,
    updatedAt: now,
    confirmedAt: status === 'confirmed' ? now : null,
    cancelledAt: status === 'cancelled' ? now : null,
    invalidReason: null,
  };
  return { ok: true, receipt };
}

/**
 * Portal revisions are global and increase on every confirmation and
 * cancellation. A lower revision is stale and can never turn a cancelled
 * receipt back into a success. At an equal revision cancellation wins.
 */
export function receiptSupersedes(existing, incoming) {
  if (!existing) return true;
  const before = revisionOf(existing.revision);
  const after = revisionOf(incoming.revision);
  const existingActive = existing.status === 'confirmed';
  const incomingActive = incoming.status === 'confirmed';
  if (before !== null && after !== null) {
    if (before !== after) return after > before;
    // Same revision: a cancellation is the safer interpretation and wins.
    return existingActive || !incomingActive;
  }
  // Without comparable revisions, never let a confirmation revive a receipt
  // that has already been cancelled or invalidated.
  if (existingActive && !incomingActive) return true;
  if (!existingActive && incomingActive) return false;
  return true;
}

/** Returns the merged receipt list plus whether the observation was applied. */
export function mergeReceipt(receipts, incoming, { now = timestamp() } = {}) {
  const index = receipts.findIndex((receipt) => receipt.receipt === incoming.receipt);
  if (index < 0) {
    return { receipts: [...receipts, incoming], applied: true, reason: 'added' };
  }
  const existing = receipts[index];
  if (!receiptSupersedes(existing, incoming)) {
    return { receipts, applied: false, reason: 'stale-revision' };
  }
  const merged = {
    ...existing,
    ...incoming,
    eventId: incoming.eventId || existing.eventId || '',
    slot: incoming.slot || existing.slot || '',
    name: incoming.name ?? existing.name ?? null,
    firstSeenAt: existing.firstSeenAt ?? incoming.firstSeenAt ?? now,
    confirmedAt: existing.confirmedAt ?? incoming.confirmedAt ?? null,
    cancelledAt: incoming.status === 'cancelled'
      ? (incoming.cancelledAt ?? existing.cancelledAt ?? now)
      : existing.cancelledAt ?? null,
    updatedAt: now,
  };
  const next = [...receipts];
  next[index] = merged;
  return { receipts: next, applied: true, reason: 'updated' };
}

export function invalidateReceipt(receipts, receiptId, { reason, now = timestamp() }) {
  const index = receipts.findIndex((receipt) => receipt.receipt === receiptId);
  if (index < 0) return { receipts, applied: false };
  const existing = receipts[index];
  if (existing.status !== 'confirmed') return { receipts, applied: false, reason: 'not-active' };
  const next = [...receipts];
  next[index] = {
    ...existing,
    status: 'invalid',
    invalidReason: reason,
    updatedAt: now,
  };
  return { receipts: next, applied: true };
}

function referenceMatches(receipt, candidate) {
  return receipt.reference === candidate.reference;
}

function slotMatches(receipt, candidate) {
  return !receipt.slot || !candidate.slot || receipt.slot === candidate.slot;
}

export function validReceiptFor(candidate, receipts) {
  if (!candidate.receipt) return null;
  const receipt = receipts.find((entry) => entry.receipt === candidate.receipt);
  if (!receipt || receipt.status !== 'confirmed') return null;
  if (!referenceMatches(receipt, candidate) || !slotMatches(receipt, candidate)) return null;
  return receipt;
}

export function activeReceiptsFor(candidate, receipts, { anySlot = false } = {}) {
  return receipts
    .filter((receipt) => receipt.status === 'confirmed'
      && referenceMatches(receipt, candidate)
      && (anySlot || slotMatches(receipt, candidate)))
    .sort((left, right) => (revisionOf(right.revision) ?? -1) - (revisionOf(left.revision) ?? -1));
}

export function waitlistKey(candidate) {
  return `${candidate.eventId ?? ''}\u0000${candidate.slot ?? ''}`;
}

function waitlistOrder(left, right) {
  const leftQueued = left.waitlist?.enqueuedAt ?? left.requestedAt;
  const rightQueued = right.waitlist?.enqueuedAt ?? right.requestedAt;
  const queued = compareTime(leftQueued, rightQueued);
  if (queued !== 0) return queued;
  const requested = compareTime(left.requestedAt, right.requestedAt);
  if (requested !== 0) return requested;
  return left.reference.localeCompare(right.reference);
}

/** Computes per-slot waitlist positions from the candidate ledger. */
export function waitlistPositions(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (candidate.desiredStatus !== JOIN || candidate.status !== 'waitlisted') continue;
    const key = waitlistKey(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const positions = new Map();
  for (const group of groups.values()) {
    group.sort(waitlistOrder);
    group.forEach((candidate, index) => {
      positions.set(candidate.reference, {
        position: index + 1,
        ahead: index,
        groupSize: group.length,
      });
    });
  }
  return positions;
}

function candidateStatus(candidate, validReceipt) {
  if (candidate.desiredStatus === CANCEL) {
    return candidate.status === 'cancelled' ? 'cancelled' : 'cancelling';
  }
  if (validReceipt) return 'confirmed';
  if (candidate.status === 'waitlisted') return 'waitlisted';
  if (candidate.status === 'failed') return 'failed';
  // A local "confirmed" marker without a currently confirmed receipt is not a
  // success. It goes back to pending until the portal is consulted again.
  return 'pending';
}

function sortCandidates(left, right) {
  const requested = compareTime(left.requestedAt, right.requestedAt);
  if (requested !== 0) return requested;
  return left.reference.localeCompare(right.reference);
}

export function buildEnrollmentView(state, { rows = [], now = timestamp() } = {}) {
  const candidates = Array.isArray(state?.candidates) ? state.candidates : [];
  const receipts = Array.isArray(state?.receipts) ? state.receipts : [];
  const positions = waitlistPositions(candidates);
  const projected = candidates.slice().sort(sortCandidates).map((candidate) => {
    const valid = validReceiptFor(candidate, receipts);
    const status = candidateStatus(candidate, valid);
    const position = positions.get(candidate.reference) ?? null;
    return {
      reference: candidate.reference,
      eventId: candidate.eventId,
      name: candidate.name,
      slot: candidate.slot,
      requestedAt: candidate.requestedAt,
      desiredStatus: candidate.desiredStatus,
      status,
      receipt: valid?.receipt ?? null,
      receiptStatus: candidate.receipt
        ? receipts.find((entry) => entry.receipt === candidate.receipt)?.status ?? 'missing'
        : null,
      receiptRevision: valid?.revision ?? null,
      attempts: candidate.attempts ?? 0,
      waitlist: position ? {
        position: position.position,
        ahead: position.ahead,
        enqueuedAt: candidate.waitlist?.enqueuedAt ?? null,
        explanation: `候补第 ${position.position} 位；按候补登记时间升序，登记时间相同按申请时间和申请编号；前方 ${position.ahead} 人。`,
      } : null,
      lastError: candidate.lastError ?? null,
      updatedAt: candidate.updatedAt ?? null,
    };
  });
  const successes = projected
    .filter((candidate) => candidate.status === 'confirmed')
    .map((candidate) => ({
      reference: candidate.reference,
      name: candidate.name,
      eventId: candidate.eventId,
      slot: candidate.slot,
      receipt: candidate.receipt,
      requestedAt: candidate.requestedAt,
      confirmedAt: receipts.find((entry) => entry.receipt === candidate.receipt)?.confirmedAt ?? null,
      revision: receipts.find((entry) => entry.receipt === candidate.receipt)?.revision ?? null,
      valid: true,
    }))
    .sort((left, right) => compareTime(left.confirmedAt ?? '', right.confirmedAt ?? '')
      || left.reference.localeCompare(right.reference));
  const waitlist = projected
    .filter((candidate) => candidate.status === 'waitlisted' && candidate.waitlist)
    .sort((left, right) => {
      const slot = `${left.eventId ?? ''}\u0000${left.slot ?? ''}`
        .localeCompare(`${right.eventId ?? ''}\u0000${right.slot ?? ''}`);
      return slot || left.waitlist.position - right.waitlist.position;
    })
    .map((candidate) => ({
      reference: candidate.reference,
      name: candidate.name,
      eventId: candidate.eventId,
      slot: candidate.slot,
      position: candidate.waitlist.position,
      ahead: candidate.waitlist.ahead,
      enqueuedAt: candidate.waitlist.enqueuedAt,
      requestedAt: candidate.requestedAt,
      explanation: candidate.waitlist.explanation,
    }));
  return {
    product: enrollmentProduct,
    rows,
    candidates: projected,
    successes,
    // Alias kept for callers that read a singular "success" list.
    success: successes,
    waitlist,
    receipts: receipts
      .slice()
      .sort((left, right) => compareTime(left.updatedAt ?? '', right.updatedAt ?? '')
        || left.receipt.localeCompare(right.receipt))
      .map((receipt) => ({
        receipt: receipt.receipt,
        reference: receipt.reference,
        eventId: receipt.eventId,
        slot: receipt.slot,
        status: receipt.status,
        revision: receipt.revision,
        valid: receipt.status === 'confirmed',
        firstSeenAt: receipt.firstSeenAt ?? null,
        confirmedAt: receipt.confirmedAt ?? null,
        cancelledAt: receipt.cancelledAt ?? null,
        updatedAt: receipt.updatedAt ?? null,
      })),
    readAt: now,
  };
}
