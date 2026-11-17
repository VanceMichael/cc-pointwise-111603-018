import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPortal } from '../source/portal.js';
import { PortalClient } from '../src/portal-client.js';
import { EnrollmentRepository } from '../src/enrollment-repository.js';
import { EnrollmentService } from '../src/enrollment-service.js';
import { RecordRepository } from '../src/repository.js';
import { readOperations } from '../src/operations.js';
import {
  receiptSupersedes, applyRequest, normalizeRequest, mergeReceipt, validReceiptFor,
} from '../src/enrollment-state.js';

const noWait = async () => {};

function resident(reference, { slot = 'A', at = 8, status = 'join', eventId = 'E1' } = {}) {
  const requestedAt = `2026-11-16T${String(at).padStart(2, '0')}:00:00Z`;
  return {
    reference, eventId, name: `Resident ${reference}`, slot,
    requestedAt, observedAt: requestedAt, desiredStatus: status,
  };
}

async function setup({ capacity = 1, directory = null } = {}) {
  const portal = await startPortal({ capacity });
  const dir = directory ?? await mkdtemp(join(tmpdir(), 'enrollment-'));
  const repository = new EnrollmentRepository({ directory: dir });
  const service = new EnrollmentService(repository, {
    portal: new PortalClient(portal.url), waitFor: noWait,
  });
  return {
    portal, dir, repository, service,
    async close({ remove = true } = {}) {
      await portal.close();
      if (remove) await rm(dir, { recursive: true, force: true });
    },
  };
}

function byReference(view, reference) {
  return view.candidates.find((candidate) => candidate.reference === reference);
}

test('候选名额与门户回执分开保存，成功只在拿到有效回执后出现', async () => {
  const context = await setup({ capacity: 2 });
  try {
    const pending = await context.service.applyRequests([resident('local-1')], { process: false });
    assert.equal(byReference(pending, 'local-1').status, 'pending');
    assert.equal(byReference(pending, 'local-1').receipt, null);
    assert.deepEqual(pending.successes, []);
    const candidates = await context.repository.readCandidates();
    assert.equal(candidates[0].status, 'pending');
    assert.deepEqual(await context.repository.readReceipts(), []);

    const confirmed = await context.service.applyRequests([resident('local-1')]);
    const row = byReference(confirmed, 'local-1');
    assert.equal(row.status, 'confirmed');
    assert.ok(row.receipt);
    const receipts = await context.repository.readReceipts();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, 'confirmed');
    assert.equal(receipts[0].receipt, row.receipt);
    assert.deepEqual(confirmed.successes.map((entry) => entry.reference), ['local-1']);
  } finally { await context.close(); }
});

test('门户满额进入候补，候补顺序可解释；取消后按顺序递补', async () => {
  const context = await setup({ capacity: 1 });
  try {
    await context.service.applyRequests([resident('a')]);
    let view = await context.service.applyRequests([resident('b', { at: 9 })]);
    view = await context.service.applyRequests([resident('c', { at: 10 })]);
    assert.equal(byReference(view, 'a').status, 'confirmed');
    assert.equal(byReference(view, 'b').status, 'waitlisted');
    assert.equal(byReference(view, 'c').status, 'waitlisted');
    assert.deepEqual(view.waitlist.map((entry) => [entry.reference, entry.position]), [['b', 1], ['c', 2]]);
    assert.equal(view.waitlist[0].ahead, 0);
    assert.equal(view.waitlist[1].ahead, 1);
    assert.match(view.waitlist[1].explanation, /候补第 2 位/);
    assert.deepEqual(view.successes.map((entry) => entry.reference), ['a']);

    view = await context.service.cancel('a');
    assert.equal(byReference(view, 'a').status, 'cancelled');
    assert.equal(byReference(view, 'b').status, 'confirmed');
    assert.equal(byReference(view, 'c').status, 'waitlisted');
    assert.equal(view.waitlist.length, 1);
    assert.equal(view.waitlist[0].reference, 'c');
    assert.equal(view.waitlist[0].position, 1);
    assert.deepEqual(view.successes.map((entry) => entry.reference), ['b']);
  } finally { await context.close(); }
});

test('备注：重复看到同一个 join 页面不会重置候补位置', async () => {
  const context = await setup({ capacity: 1 });
  try {
    await context.service.applyRequests([resident('a')]);
    let view = await context.service.applyRequests([resident('b', { at: 9 })]);
    const enqueuedAt = byReference(view, 'b').waitlist.enqueuedAt;
    view = await context.service.applyRequests([resident('a'), resident('b', { at: 9 })], { process: false });
    assert.equal(byReference(view, 'b').status, 'waitlisted');
    assert.equal(byReference(view, 'b').waitlist.enqueuedAt, enqueuedAt);
    assert.equal(byReference(view, 'a').status, 'confirmed');
  } finally { await context.close(); }
});

test('确认响应丢失后重试先核对既有报名，不会占两个位置', async () => {
  const context = await setup({ capacity: 2 });
  try {
    const stopAfterOne = new EnrollmentService(new EnrollmentRepository({ directory: context.dir }), {
      portal: new PortalClient(context.portal.url), waitFor: noWait, maxAttempts: 1,
    });
    context.portal.loseNextReceipt();
    let view = await stopAfterOne.applyRequests([resident('d')]);
    assert.notEqual(byReference(view, 'd').status, 'confirmed', '未取得回执不能进入成功名单');
    assert.deepEqual(view.successes, []);
    const portalBookings = async () => {
      const response = await fetch(`${context.portal.url}/portal/bookings?reference=d`);
      return (await response.json()).bookings;
    };
    assert.equal((await portalBookings()).length, 1, '门户已经占了一个位置');

    view = await context.service.runQueue({ retry: true });
    assert.equal(byReference(view, 'd').status, 'confirmed');
    assert.equal((await portalBookings()).length, 1, '重试不能新增第二个报名');
    assert.equal(view.successes.length, 1);
  } finally { await context.close(); }
});

test('旧的成功响应不能盖过更晚的取消', () => {
  const cancelled = { receipt: 'r-1', status: 'cancelled', revision: 5 };
  assert.equal(receiptSupersedes(cancelled, { receipt: 'r-1', status: 'confirmed', revision: 3 }), false);
  assert.equal(receiptSupersedes(cancelled, { receipt: 'r-1', status: 'cancelled', revision: 3 }), false);
  assert.equal(receiptSupersedes(cancelled, { receipt: 'r-1', status: 'confirmed', revision: 6 }), true);
  assert.equal(receiptSupersedes(
    { receipt: 'r-1', status: 'cancelled', revision: null },
    { receipt: 'r-1', status: 'confirmed', revision: null },
  ), false, '没有修订号时也不能把已取消的回执复活');
  const merged = mergeReceipt([cancelled], { ...cancelled, status: 'confirmed', revision: 3 });
  assert.equal(merged.applied, false);
  assert.equal(merged.receipts[0].status, 'cancelled');
});

test('迟到的 201 成功响应不能把已取消的报名写回成功名单', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enrollment-'));
  try {
    const repository = new EnrollmentRepository({ directory });
    await repository.writeEnrollment({
      candidates: [{
        ...normalizeRequest(resident('late')), status: 'pending', receipt: null,
        waitlist: null, attempts: 1,
      }],
      receipts: [{
        receipt: 'receipt-late', reference: 'late', eventId: 'E1', slot: 'A',
        status: 'cancelled', revision: 9, firstSeenAt: '2026-11-16T08:00:00Z',
        confirmedAt: '2026-11-16T08:00:00Z', cancelledAt: '2026-11-16T09:00:00Z',
      }],
    });
    const stalePortal = {
      async bookings() {
        return { status: 200, body: { revision: 9, bookings: [{
          reference: 'late', slot: 'A', receipt: 'receipt-late', status: 'cancelled', revision: 9,
        }] } };
      },
      async submit() {
        return { draft: { status: 200 }, confirm: { status: 201, body: {
          reference: 'late', slot: 'A', receipt: 'receipt-late', status: 'confirmed', revision: 5,
        } } };
      },
    };
    const service = new EnrollmentService(repository, { portal: stalePortal, waitFor: noWait });
    const view = await service.applyRequests([resident('late')]);
    assert.equal(byReference(view, 'late').status, 'failed');
    assert.deepEqual(view.successes, []);
    const receipts = await repository.readReceipts();
    assert.equal(receipts[0].status, 'cancelled');
    assert.equal(receipts[0].revision, 9);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('门户侧取消后，核对和批量处理都会把报名移出成功名单', async () => {
  const context = await setup({ capacity: 1 });
  try {
    let view = await context.service.applyRequests([resident('z')]);
    const receipt = byReference(view, 'z').receipt;
    assert.ok(receipt);

    // Someone cancels directly in the portal; the local ledger still says confirmed.
    const external = new PortalClient(context.portal.url);
    assert.equal((await external.cancel(receipt)).status, 200);

    view = await context.service.lookup('z');
    assert.equal(byReference(view, 'z').status, 'pending');
    assert.deepEqual(view.successes, []);
    const stored = await context.repository.readReceipts();
    assert.equal(stored[0].status, 'cancelled');
    assert.ok(stored[0].revision > 0);
  } finally { await context.close(); }
});

test('取消后的本地成功标记没有有效回执时必须从成功名单移除', async () => {
  const repository = new EnrollmentRepository({ directory: await mkdtemp(join(tmpdir(), 'enrollment-')) });
  try {
    await repository.writeEnrollment({
      candidates: [{
        ...normalizeRequest(resident('x')), status: 'confirmed', receipt: 'gone',
        waitlist: null, sourceObservation: { observedAt: '2026-11-16T08:00:00Z', desiredStatus: 'join' },
      }],
      receipts: [{
        receipt: 'gone', reference: 'x', slot: 'A', status: 'cancelled', revision: 3,
      }],
    });
    const { buildEnrollmentView } = await import('../src/enrollment-state.js');
    const view = buildEnrollmentView(await repository.readEnrollment());
    assert.equal(view.candidates[0].status, 'pending');
    assert.equal(view.candidates[0].receipt, null);
    assert.deepEqual(view.successes, []);
  } finally {
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test('同一场次的并发待办只产生不超过容量的有效回执', async () => {
  const context = await setup({ capacity: 2 });
  try {
    const views = await Promise.all(['a', 'b', 'c', 'd'].map((reference) => context.service.enroll(resident(reference))));
    assert.equal(views.length, 4);
    const view = await context.service.view();
    const confirmed = view.candidates.filter((candidate) => candidate.status === 'confirmed');
    assert.equal(confirmed.length, 2);
    assert.equal(new Set(confirmed.map((candidate) => candidate.receipt)).size, 2);
    assert.equal(view.candidates.filter((candidate) => candidate.status === 'waitlisted').length, 2);
    assert.equal(view.successes.length, 2);
    for (const candidate of confirmed) {
      const receipt = view.receipts.find((entry) => entry.receipt === candidate.receipt);
      assert.equal(receipt.status, 'confirmed');
      assert.equal(receipt.valid, true);
    }
    const portalBookings = [];
    for (const reference of ['a', 'b', 'c', 'd']) {
      const response = await fetch(`${context.portal.url}/portal/bookings?reference=${reference}`);
      portalBookings.push(...(await response.json()).bookings);
    }
    assert.equal(portalBookings.length, 2, '门户也只有两个有效报名，没有占位泄漏');
  } finally { await context.close(); }
});

test('较旧的 join 观察不能推翻更晚的取消，较新的取消观察会取消回执', async () => {
  const context = await setup({ capacity: 1 });
  try {
    await context.service.applyRequests([resident('a')]);
    const cancelled = { ...resident('a'), observedAt: '2026-11-16T12:00:00Z', desiredStatus: 'cancel' };
    let view = await context.service.applyRequests([cancelled]);
    assert.equal(byReference(view, 'a').status, 'cancelled');
    assert.deepEqual(view.successes, []);

    view = await context.service.applyRequests([resident('a', { at: 8 })]);
    assert.equal(byReference(view, 'a').status, 'cancelled', '重放的旧 join 页面不能复活旧报名');
    assert.equal((await context.repository.readReceipts())[0].status, 'cancelled');
  } finally { await context.close(); }
});

test('来源中的取消会释放名额并按候补顺序递补，新申请不插队', async () => {
  const context = await setup({ capacity: 1 });
  try {
    await context.service.applyRequests([resident('a', { at: 8 })]);
    await context.service.applyRequests([resident('queue-1', { at: 10 })]);
    // 'new' applied earlier but only appears now; 'queue-1' is already waiting,
    // so the later request must not jump ahead of it.
    let view = await context.service.applyRequests([resident('new', { at: 9 })]);
    assert.deepEqual(view.waitlist.map((entry) => [entry.reference, entry.position]),
      [['queue-1', 1], ['new', 2]]);

    const cancelled = { ...resident('a', { at: 8 }), observedAt: '2026-11-16T12:00:00Z', desiredStatus: 'cancel' };
    view = await context.service.applyRequests([cancelled]);
    assert.equal(byReference(view, 'a').status, 'cancelled');
    assert.equal(byReference(view, 'queue-1').status, 'confirmed');
    assert.equal(byReference(view, 'new').status, 'waitlisted');
    assert.equal(view.waitlist[0].reference, 'new');
    assert.deepEqual(view.successes.map((entry) => entry.reference), ['queue-1']);
  } finally { await context.close(); }
});

test('业务读取入口同时反映来源观察与报名状态', async () => {
  const context = await setup({ capacity: 1 });
  try {
    const records = new RecordRepository(join(context.dir, 'records.json'));
    const repository = new EnrollmentRepository({ directory: join(context.dir, 'enrollment'), records });
    await records.replace([{
      sourceId: 'local-1', source: '社区活动报名台账', observedAt: '2026-11-16T08:00:00Z',
      label: 'Local Resident', attributes: resident('local-1'),
    }]);
    const service = new EnrollmentService(repository, {
      portal: new PortalClient(context.portal.url), waitFor: noWait,
    });
    await service.applyRequests([resident('local-1')]);
    const view = await readOperations(repository);
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].sourceId, 'local-1');
    assert.equal(view.candidates[0].status, 'confirmed');
    assert.deepEqual(view.successes.map((entry) => entry.reference), ['local-1']);
  } finally { await context.close(); }
});

test('两个服务实例共享状态目录时也不会同场次超额确认', async () => {
  const context = await setup({ capacity: 1 });
  try {
    const other = new EnrollmentService(new EnrollmentRepository({ directory: context.dir }), {
      portal: new PortalClient(context.portal.url), waitFor: noWait,
    });
    const [first, second] = await Promise.all([
      context.service.enroll(resident('one')),
      other.enroll(resident('two')),
    ]);
    const view = await context.service.view();
    const confirmed = view.candidates.filter((candidate) => candidate.status === 'confirmed');
    assert.equal(confirmed.length, 1, `${first.candidate.status}/${second.candidate.status}`);
    assert.equal(view.candidates.filter((candidate) => candidate.status === 'waitlisted').length, 1);
  } finally { await context.close(); }
});

test('applyRequest 只按观察时间前进，不把回执带入重新申请', () => {
  const first = applyRequest(null, normalizeRequest(resident('a')), { now: '2026-11-16T10:00:00Z' }).candidate;
  first.status = 'cancelled';
  first.receipt = 'old-receipt';
  first.waitlist = { position: 1 };
  const replay = applyRequest(first, normalizeRequest(resident('a')), { now: '2026-11-16T10:05:00Z' });
  assert.equal(replay.applied, false);
  assert.equal(replay.candidate.receipt, 'old-receipt');
  const newer = applyRequest(first, normalizeRequest({ ...resident('a'), observedAt: '2026-11-17T00:00:00Z' }), {
    now: '2026-11-17T00:00:00Z',
  });
  assert.equal(newer.applied, true);
  assert.equal(newer.candidate.status, 'pending');
  assert.equal(newer.candidate.receipt, null);
});
