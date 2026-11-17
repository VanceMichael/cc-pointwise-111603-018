import {
  activeReceiptsFor, applyRequest, buildEnrollmentView, createCandidate,
  invalidateReceipt, mergeReceipt, normalizeReceipt, normalizeRequest,
  receiptSupersedes, timestamp, validReceiptFor, waitlistPositions,
} from './enrollment-state.js';

const JOIN = 'join';
const MAX_ATTEMPTS = 3;
const MAX_PROMOTIONS_PER_PASS = 25;

// The local business store is a single JSON ledger per repository. Concurrent
// todos in one process must not interleave read/modify/write or two portal
// confirmations, so every enrollment operation is serialized per repository
// (and, for repositories that support it, across processes with a file lock).
const locks = new WeakMap();

async function withLock(repository, operation) {
  if (typeof repository.transaction === 'function') {
    // transaction() supplies the state and persists it after the operation;
    // the operation must mutate that object rather than re-reading it.
    return repository.transaction((state) => operation(state));
  }
  const run = async () => {
    const state = await repository.readEnrollment();
    const value = await operation(state);
    await repository.writeEnrollment(state);
    return value;
  };
  const previous = locks.get(repository) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  locks.set(repository, tail);
  return previous.then(async () => {
    try { return await run(); } finally {
      release();
      if (locks.get(repository) === tail) locks.delete(repository);
    }
  });
}

const defaultWait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function byRequestOrder(left, right) {
  const leftTime = Date.parse(left.requestedAt);
  const rightTime = Date.parse(right.requestedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.reference.localeCompare(right.reference);
}

function samePlace(left, right) {
  return `${left.eventId ?? ''}\u0000${left.slot ?? ''}` === `${right.eventId ?? ''}\u0000${right.slot ?? ''}`;
}

function toMaps(state) {
  return {
    candidates: new Map((state.candidates ?? []).map((candidate) => [candidate.reference, candidate])),
    receipts: new Map((state.receipts ?? []).map((receipt) => [receipt.receipt, receipt])),
  };
}

function fromMaps({ candidates, receipts }) {
  return {
    candidates: [...candidates.values()].sort((left, right) => left.reference.localeCompare(right.reference)),
    receipts: [...receipts.values()].sort((left, right) => left.receipt.localeCompare(right.receipt)),
  };
}

/**
 * Coordinates resident applications with the portal. Candidate allocation and
 * portal receipts live in separate collections; success is always derived by
 * joining a candidate to a *currently confirmed* receipt, never from the fact
 * that a form or confirmation attempt happened.
 */
export class EnrollmentService {
  constructor(repository, options = {}) {
    if (!repository || typeof repository.readCandidates !== 'function') {
      throw new TypeError('an EnrollmentRepository is required');
    }
    this.repository = repository;
    this.portal = options.portal ?? null;
    this.now = options.now ?? (() => new Date());
    this.waitFor = options.waitFor ?? defaultWait;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  }

  _clock() { return timestamp(this.now); }

  _requirePortal() {
    if (!this.portal) throw new Error('portal client is required');
    return this.portal;
  }

  async _readState() {
    return fromMaps(toMaps(await this.repository.readEnrollment()));
  }

  async _view(state = null) {
    const current = state ?? await this._readState();
    const view = buildEnrollmentView({
      candidates: current.candidates ?? [],
      receipts: current.receipts ?? [],
    }, {
      rows: await this.repository.read(),
      now: this._clock(),
    });
    if (Array.isArray(current.failures) && current.failures.length) {
      view.failures = current.failures;
    }
    return view;
  }

  /** Reads candidates, receipts, waitlist order and successes. */
  async view() { return this._view(); }

  async status() { return this._view(); }

  /**
   * Records resident requests from the source page. Requests only create or
   * update candidates; a candidate becomes a success only after the portal
   * returns a valid receipt during processing.
   */
  async applyRequests(inputs, { process = true, retry = false, documentType } = {}) {
    if (!Array.isArray(inputs)) throw new TypeError('applyRequests input must be an array');
    const requests = inputs.map(normalizeRequest);
    if (process) await this._requirePortal();
    return withLock(this.repository, async (state) => {
      const maps = toMaps(state);
      const touched = new Set();
      for (const request of requests) {
        const before = maps.candidates.get(request.reference);
        const { candidate } = applyRequest(before, request, { now: this._clock() });
        maps.candidates.set(candidate.reference, candidate);
        touched.add(candidate.reference);
      }
      const working = fromMaps(maps);
      const result = process
        ? await this._processReferences(working, [...touched], { retry, documentType })
        : working;
      state.candidates = result.candidates;
      state.receipts = result.receipts;
      return this._view(result);
    });
  }

  /** Applies one resident request and returns its candidate view row. */
  async enroll(input, options = {}) {
    const view = await this.applyRequests([input], options);
    const request = normalizeRequest(input);
    return {
      candidate: view.candidates.find((candidate) => candidate.reference === request.reference) ?? null,
      view,
    };
  }

  /** Retries pending work. Existing applications are re-checked first. */
  async runQueue({ references = null, retry = true, documentType } = {}) {
    await this._requirePortal();
    return withLock(this.repository, async (source) => {
      const maps = toMaps(source);
      let names = references;
      if (!names) {
        // A sweep covers unsettled work, waitlist positions that may have
        // become free outside our own cancellation path, and confirmed
        // candidates whose receipt the portal may no longer honour.
        names = [...maps.candidates.values()]
          .filter((candidate) => ['pending', 'cancelling', 'waitlisted', 'confirmed'].includes(candidate.status)
            || (retry && candidate.status === 'failed'))
          .map((candidate) => candidate.reference);
      }
      const result = await this._processReferences(fromMaps(maps), [...new Set(names)], {
        retry, documentType,
      });
      source.candidates = result.candidates;
      source.receipts = result.receipts;
      return this._view(result);
    });
  }

  /** Queries the portal for an application, then reconciles local state. */
  async lookup(reference) {
    if (!reference) throw new TypeError('lookup requires reference');
    await this._requirePortal();
    return withLock(this.repository, async (state) => {
      const maps = toMaps(state);
      const candidate = maps.candidates.get(String(reference)) ?? null;
      const lookup = await this._lookup(maps, String(reference));
      if (candidate) this._reconcile(candidate, maps, lookup.error);
      const result = fromMaps(maps);
      state.candidates = result.candidates;
      state.receipts = result.receipts;
      return this._view(result);
    });
  }

  /** Looks up a portal booking receipt for a reference. */
  async receipt(reference) {
    const view = await this.lookup(reference);
    return {
      reference,
      receipts: view.receipts.filter((entry) => entry.reference === reference),
      success: view.successes.filter((entry) => entry.reference === reference),
      waitlist: view.waitlist.filter((entry) => entry.reference === reference),
    };
  }

  /**
   * Cancels a resident's place. The receipt is always the one the portal
   * knows; success is never inferred from local candidate state.
   */
  async cancel(reference, { receipt = null, documentType } = {}) {
    if (!reference) throw new TypeError('cancel requires reference');
    await this._requirePortal();
    return withLock(this.repository, async (state) => {
      const maps = toMaps(state);
      let candidate = maps.candidates.get(String(reference));
      if (!candidate) throw new Error(`unknown reference: ${reference}`);
      const now = this._clock();
      candidate.desiredStatus = 'cancel';
      candidate.localIntent = true;
      candidate.status = 'cancelling';
      candidate.updatedAt = now;
      maps.candidates.set(candidate.reference, candidate);

      if (!candidate.receipt && receipt) candidate.receipt = String(receipt);
      // Reconcile first so a lost confirmation response still yields a
      // receipt that can be cancelled instead of leaking a held place.
      await this._lookup(maps, candidate.reference);
      await this._cancelCandidate(maps, candidate, { documentType });
      const freed = candidate.status === 'cancelled'
        && maps.receipts.get(candidate.receipt)?.status === 'cancelled';
      if (freed) {
        // Let the receipt list be the only source of truth for released
        // capacity, then retry the queue in explained order.
        await this._promote(maps, candidate, { documentType });
      }
      const final = fromMaps(maps);
      state.candidates = final.candidates;
      state.receipts = final.receipts;
      return this._view(final);
    });
  }

  async _lookup(maps, reference) {
    let response;
    try {
      response = await this._requirePortal().bookings(reference);
    } catch (error) {
      return {
        ok: false, bookings: [],
        error: error.uncertain ? `portal lookup uncertain: ${error.message}` : `portal lookup failed: ${error.message}`,
        uncertain: Boolean(error.uncertain),
      };
    }
    if (response.status !== 200) {
      return { ok: false, bookings: [], error: `portal lookup ${response.status}` };
    }
    const bookings = Array.isArray(response.body?.bookings) ? response.body.bookings : [];
    const merged = [];
    for (const booking of bookings) {
      const normalized = normalizeReceipt(booking, {
        reference, now: this._clock(),
      });
      if (!normalized.ok) continue;
      // A lookup returns every booking for the reference, including cancelled
      // ones. Revisions decide which observation is newest.
      const outcome = mergeReceipt([...maps.receipts.values()], normalized.receipt, { now: this._clock() });
      maps.receipts = new Map(outcome.receipts.map((entry) => [entry.receipt, entry]));
      merged.push(normalized.receipt.receipt);
    }
    return { ok: true, bookings, merged, revision: response.body?.revision ?? response.revision };
  }

  /**
   * Aligns a candidate with the receipt ledger after a lookup. A cancelled or
   * invalid receipt never leaves the candidate in the success list.
   */
  _reconcile(candidate, maps, lookupError = null) {
    const now = this._clock();
    if (!candidate) return;
    const receipts = [...maps.receipts.values()];
    const valid = validReceiptFor(candidate, receipts);
    if (candidate.desiredStatus !== 'cancel') {
      if (valid) {
        candidate.receipt = valid.receipt;
        candidate.status = 'confirmed';
        candidate.waitlist = null;
        candidate.lastError = null;
        candidate.resolvedAt = candidate.resolvedAt ?? now;
      } else if (candidate.status === 'confirmed') {
        // Local success without a valid receipt is not success.
        candidate.status = 'pending';
        candidate.lastError = 'receipt not confirmed by portal';
        candidate.waitlist = null;
        candidate.resolvedAt = null;
      }
    }
    if (lookupError) candidate.lastError = lookupError;
    candidate.updatedAt = now;
  }

  async _processReferences(state, references, { retry = false, documentType } = {}) {
    const maps = toMaps(state);
    const ordered = references
      .map((reference) => maps.candidates.get(reference))
      .filter(Boolean)
      .sort(byRequestOrder);
    const failures = [];
    const freed = new Set();
    for (const candidate of ordered) {
      if (candidate.desiredStatus === JOIN && candidate.status === 'confirmed'
        && validReceiptFor(candidate, [...maps.receipts.values()])) {
        // Still re-checked: a sweep must notice a receipt the portal has since
        // cancelled, otherwise success would outlive the portal record.
        const lookup = await this._lookup(maps, candidate.reference);
        this._reconcile(candidate, maps, lookup.ok ? null : lookup.error);
        continue;
      }
      if (candidate.status === 'failed' && !retry) continue;
      try {
        const result = await this._processCandidate(maps, candidate, { retry, documentType });
        if (result?.freed) freed.add(candidate.reference);
      } catch (error) {
        candidate.status = 'failed';
        candidate.lastError = error.message;
        candidate.updatedAt = this._clock();
        failures.push({ reference: candidate.reference, error: error.message });
      }
    }
    for (const reference of freed) {
      const cancelled = maps.candidates.get(reference);
      // A cancellation seen through the source releases a place exactly like
      // an operator cancellation; the explained queue order decides who gets it.
      if (cancelled) await this._promote(maps, cancelled, { documentType });
    }
    return { ...fromMaps(maps), failures };
  }

  /**
   * New applications must not jump ahead of residents already waiting for the
   * same session. Before trying to confirm a fresh candidate, attempt the
   * earlier waitlisted candidates first.
   */
  async _promoteAhead(maps, candidate, { documentType } = {}) {
    const waiting = [...maps.candidates.values()]
      .filter((entry) => entry.reference !== candidate.reference
        && entry.desiredStatus === JOIN
        && entry.status === 'waitlisted'
        && samePlace(entry, candidate));
    if (!waiting.length) return;
    await this._promote(maps, candidate, { documentType });
  }

  async _processCandidate(maps, candidate, { promote = false, retry = false, documentType } = {}) {
    const now = this._clock();
    candidate.attempts = candidate.attempts ?? 0;
    const lookup = await this._lookup(maps, candidate.reference);
    this._reconcile(candidate, maps, lookup.ok ? null : lookup.error);

    if (candidate.desiredStatus === 'cancel') {
      const freed = candidate.status === 'confirmed' || Boolean(candidate.receipt);
      await this._cancelCandidate(maps, candidate, { documentType });
      return {
        outcome: candidate.status,
        freed: freed && candidate.status === 'cancelled'
          && maps.receipts.get(candidate.receipt)?.status === 'cancelled',
      };
    }

    const receipts = [...maps.receipts.values()];
    let active = activeReceiptsFor(candidate, receipts)[0] ?? null;
    if (active) {
      candidate.receipt = active.receipt;
      candidate.status = 'confirmed';
      candidate.waitlist = null;
      candidate.lastError = null;
      candidate.localIntent = false;
      candidate.resolvedAt = candidate.resolvedAt ?? now;
      candidate.updatedAt = now;
      return { outcome: 'confirmed' };
    }

    // Another slot may still be held for this application (for example the
    // resident moved slots). It must be released before a new confirmation so
    // one application cannot occupy two places.
    const other = activeReceiptsFor(candidate, receipts, { anySlot: true })[0] ?? null;
    if (other) {
      const cancelled = await this._cancelReceipt(maps, other, { documentType });
      if (!cancelled.ok) {
        candidate.status = 'pending';
        candidate.lastError = cancelled.error ?? 'could not release previous place';
        candidate.updatedAt = this._clock();
        return { outcome: 'blocked' };
      }
    }

    if (candidate.status === 'waitlisted' && !promote && !retry) {
      candidate.updatedAt = now;
      return { outcome: 'waitlisted' };
    }

    // Do not let a new application take a place that an earlier waitlisted
    // resident should receive: try the queue first, then re-check our own
    // status against the receipts that promotion may have produced.
    if (!promote) await this._promoteAhead(maps, candidate, { documentType });
    const afterPromotion = activeReceiptsFor(candidate, [...maps.receipts.values()])[0] ?? null;
    if (afterPromotion) {
      candidate.receipt = afterPromotion.receipt;
      candidate.status = 'confirmed';
      candidate.waitlist = null;
      candidate.lastError = null;
      candidate.updatedAt = this._clock();
      return { outcome: 'confirmed' };
    }

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (candidate.attempts > 0) {
        // Before retrying, verify whether an earlier attempt already holds a
        // place. This is what prevents one application from taking two slots
        // after a lost response.
        await this._lookup(maps, candidate.reference);
        const found = activeReceiptsFor(candidate, [...maps.receipts.values()])[0] ?? null;
        if (found) {
          candidate.receipt = found.receipt;
          candidate.status = 'confirmed';
          candidate.waitlist = null;
          candidate.lastError = null;
          candidate.updatedAt = this._clock();
          return { outcome: 'confirmed' };
        }
      }
      candidate.attempts += 1;
      candidate.updatedAt = this._clock();
      let outcome;
      try {
        outcome = await this._requirePortal().submit({
          reference: candidate.reference,
          name: candidate.name,
          slot: candidate.slot,
        }, { documentType });
      } catch (error) {
        candidate.lastError = `confirm uncertain: ${error.message}`;
        candidate.status = 'pending';
        await this.waitFor(10 * (attempt + 1));
        continue;
      }
      const confirm = outcome.confirm;
      if (!confirm) {
        candidate.lastError = `draft failed: ${outcome.draft?.status ?? 'no response'}`;
        if ((outcome.draft?.status ?? 0) >= 400 && (outcome.draft?.status ?? 0) < 500) {
          candidate.status = 'failed';
          candidate.updatedAt = this._clock();
          return { outcome: 'failed' };
        }
        if (outcome.draft?.status === 403) {
          // Expired session: submit() opens a new one on the next attempt.
          await this.waitFor(10 * (attempt + 1));
          continue;
        }
        await this.waitFor(10 * (attempt + 1));
        continue;
      }
      if (confirm.status === 201) {
        const normalized = normalizeReceipt(confirm.body, {
          reference: candidate.reference, eventId: candidate.eventId, slot: candidate.slot,
          now: this._clock(),
        });
        if (!normalized.ok) {
          candidate.lastError = `portal receipt rejected: ${normalized.reason}`;
          await this.waitFor(10 * (attempt + 1));
          continue;
        }
        const merge = mergeReceipt([...maps.receipts.values()], normalized.receipt, { now: this._clock() });
        maps.receipts = new Map(merge.receipts.map((entry) => [entry.receipt, entry]));
        const stored = maps.receipts.get(normalized.receipt.receipt);
        if (!stored || stored.status !== 'confirmed') {
          // A later cancellation already superseded this confirmation: the
          // old success response must not overwrite it. Do not silently book
          // again either; the resident or an operator must reapply.
          candidate.status = 'failed';
          candidate.lastError = 'confirmation superseded by newer portal revision';
          candidate.updatedAt = this._clock();
          return { outcome: 'superseded' };
        }
        // Read back from the portal before declaring success; a receipt only
        // counts once the portal itself reports it as confirmed.
        await this._lookup(maps, candidate.reference);
        const latest = maps.receipts.get(normalized.receipt.receipt);
        if (!latest || latest.status !== 'confirmed') {
          candidate.status = 'failed';
          candidate.lastError = 'confirmation superseded by cancellation';
          candidate.updatedAt = this._clock();
          return { outcome: 'superseded' };
        }
        candidate.receipt = latest.receipt;
        candidate.status = 'confirmed';
        candidate.waitlist = null;
        candidate.lastError = null;
        candidate.resolvedAt = candidate.resolvedAt ?? this._clock();
        candidate.updatedAt = candidate.resolvedAt;
        return { outcome: 'confirmed' };
      }
      if (confirm.status === 409) {
        const error = String(confirm.body?.error ?? '');
        if (error.includes('capacity')) {
          // The confirmation response may have been lost earlier and the
          // portal may already hold our place. Check before queueing: we must
          // never leave a confirmed booking behind while reporting waitlist.
          await this._lookup(maps, candidate.reference);
          const already = activeReceiptsFor(candidate, [...maps.receipts.values()])[0] ?? null;
          if (already) {
            candidate.receipt = already.receipt;
            candidate.status = 'confirmed';
            candidate.waitlist = null;
            candidate.lastError = null;
            candidate.updatedAt = this._clock();
            return { outcome: 'confirmed' };
          }
          candidate.receipt = null;
          candidate.status = 'waitlisted';
          candidate.lastError = null;
          candidate.waitlist = {
            ...(candidate.waitlist ?? {}),
            eventId: candidate.eventId,
            slot: candidate.slot,
            // Position is explained by when the candidate entered the queue;
            // re-observing a full portal must not reset that time.
            enqueuedAt: candidate.waitlist?.enqueuedAt ?? this._clock(),
          };
          candidate.updatedAt = this._clock();
          return { outcome: 'waitlisted', capacity: true };
        }
        // e.g. "no draft": start over with a fresh session.
        candidate.lastError = `portal 409: ${error}`;
        await this.waitFor(10 * (attempt + 1));
        continue;
      }
      if (confirm.status === 422) {
        candidate.status = 'failed';
        candidate.lastError = `portal validation: ${confirm.body?.error ?? 'rejected'}`;
        candidate.updatedAt = this._clock();
        return { outcome: 'failed' };
      }
      if (confirm.status === 403) {
        candidate.lastError = 'portal session expired';
        await this.waitFor(10 * (attempt + 1));
        continue;
      }
      candidate.lastError = `portal confirm ${confirm.status}`;
      await this.waitFor(10 * (attempt + 1));
    }
    candidate.updatedAt = this._clock();
    return { outcome: candidate.status };
  }

  async _cancelCandidate(maps, candidate, { documentType } = {}) {
    const now = this._clock();
    const receipts = [...maps.receipts.values()];
    const receipt = candidate.receipt ? receipts.find((entry) => entry.receipt === candidate.receipt) : null;
    const active = (receipt && receipt.status === 'confirmed')
      ? receipt
      : activeReceiptsFor(candidate, receipts, { anySlot: true })[0] ?? null;
    if (!active) {
      candidate.status = 'cancelled';
      candidate.waitlist = null;
      candidate.lastError = null;
      candidate.resolvedAt = candidate.resolvedAt ?? now;
      candidate.updatedAt = now;
      return { outcome: 'cancelled' };
    }
    const result = await this._cancelReceipt(maps, active, { documentType });
    if (result.ok) {
      candidate.receipt = active.receipt;
      candidate.status = 'cancelled';
      candidate.waitlist = null;
      candidate.lastError = null;
      candidate.resolvedAt = candidate.resolvedAt ?? this._clock();
      candidate.updatedAt = candidate.resolvedAt;
      return { outcome: 'cancelled' };
    }
    if (result.invalid) {
      // The portal has no such booking, so it cannot support a success claim.
      candidate.receipt = active.receipt;
      candidate.status = 'cancelled';
      candidate.waitlist = null;
      candidate.lastError = `receipt invalidated: ${result.error}`;
      candidate.resolvedAt = candidate.resolvedAt ?? this._clock();
      candidate.updatedAt = candidate.resolvedAt;
      return { outcome: 'cancelled', invalid: true };
    }
    candidate.status = 'cancelling';
    candidate.lastError = result.error ?? 'cancel failed';
    candidate.updatedAt = this._clock();
    return { outcome: 'cancelling' };
  }

  async _cancelReceipt(maps, receipt, { documentType } = {}) {
    const portal = this._requirePortal();
    let lastError = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      let response;
      try {
        // A fresh portal session is opened for every cancellation so an
        // expired browser session cannot leave a success in place.
        response = await portal.cancel(receipt.receipt);
      } catch (error) {
        lastError = error.message;
        const lookup = await this._lookup(maps, receipt.reference);
        const current = maps.receipts.get(receipt.receipt);
        if (current?.status === 'cancelled') {
          return { ok: true, receipt: current };
        }
        if (!lookup.ok) await this.waitFor(10 * (attempt + 1));
        continue;
      }
      if (response.status === 200 || response.status === 201) {
        const normalized = normalizeReceipt(response.body, {
          reference: receipt.reference, now: this._clock(),
        });
        if (!normalized.ok) return { ok: false, error: `portal cancel receipt ${normalized.reason}` };
        const merge = mergeReceipt([...maps.receipts.values()], normalized.receipt, { now: this._clock() });
        maps.receipts = new Map(merge.receipts.map((entry) => [entry.receipt, entry]));
        const stored = maps.receipts.get(receipt.receipt);
        // The response only counts if the merged ledger now says cancelled; a
        // stale "cancelled" reply must not overwrite a newer confirmation.
        if (stored?.status !== 'cancelled') {
          return { ok: false, error: 'portal cancel superseded by newer revision' };
        }
        return { ok: true, receipt: stored };
      }
      if (response.status === 404) {
        // Confirm with a lookup: the portal is the source of truth for whether
        // this receipt ever existed.
        await this._lookup(maps, receipt.reference);
        const current = maps.receipts.get(receipt.receipt);
        if (current && current.status === 'cancelled') return { ok: true, receipt: current };
        const invalidation = invalidateReceipt([...maps.receipts.values()], receipt.receipt, {
          reason: 'portal does not know receipt', now: this._clock(),
        });
        if (invalidation.applied) {
          maps.receipts = new Map(invalidation.receipts.map((entry) => [entry.receipt, entry]));
          return { ok: false, invalid: true, error: 'portal does not know receipt' };
        }
        return { ok: false, error: 'portal does not know receipt' };
      }
      if (response.status === 403) {
        // cancel() starts a new session on the next attempt.
        lastError = 'portal session expired';
        continue;
      }
      lastError = `portal cancel ${response.status}`;
      await this.waitFor(10 * (attempt + 1));
    }
    return { ok: false, error: lastError ?? 'cancel failed' };
  }

  /**
   * After a cancellation releases capacity, earlier waitlisted applications
   * are retried in explained queue order. A 409 stops the pass because the
   * slot is full again.
   */
  async _promote(maps, freedCandidate, { documentType } = {}) {
    const positions = waitlistPositions([...maps.candidates.values()]);
    const waiting = [...maps.candidates.values()]
      .filter((candidate) => candidate.desiredStatus === JOIN
        && candidate.status === 'waitlisted'
        && samePlace(candidate, freedCandidate))
      .sort((left, right) => {
        const leftPosition = positions.get(left.reference)?.position ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = positions.get(right.reference)?.position ?? Number.MAX_SAFE_INTEGER;
        if (leftPosition !== rightPosition) return leftPosition - rightPosition;
        return byRequestOrder(left, right);
      });
    for (const candidate of waiting.slice(0, MAX_PROMOTIONS_PER_PASS)) {
      // Queue the candidate as pending first. If the portal is full again the
      // confirmation re-waitlists it; if the process dies mid-promotion the
      // persisted state still shows unconfirmed work to retry.
      candidate.status = 'pending';
      candidate.updatedAt = this._clock();
      const result = await this._processCandidate(maps, candidate, { promote: true, documentType });
      if (result?.capacity) break;
    }
  }

  /** Exposed for tests and operators: compare a late response with a receipt. */
  receiptSupersedes(existing, incoming) { return receiptSupersedes(existing, incoming); }
}

export { normalizeRequest, normalizeReceipt, mergeReceipt, createCandidate };
