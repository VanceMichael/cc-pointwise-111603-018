import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { startPortal } from '../source/portal.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';
import { PortalClient } from './portal-client.js';
import { EnrollmentRepository } from './enrollment-repository.js';
import { EnrollmentService } from './enrollment-service.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const portal = await startPortal({ capacity: 1 });
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const first = await new CollectionService(repository).ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');
  const operations = await readOperations(reopened);
  assert.deepEqual(operations.rows.map(row => row.sourceId), stored.map(row => row.sourceId));
  for (const row of operations.rows) {
    const original = stored.find(record => record.sourceId === row.sourceId);
    assert.equal(row.source, original.source);
    assert.equal(row.observedAt, original.observedAt);
    for (const [field, value] of Object.entries(row.attributes)) assert.deepEqual(value, original.attributes[field] ?? null);
  }

  // Real enrollment: the source page only produces candidates; the portal
  // receipt decides success, capacity overflows go to the waitlist, and a
  // cancellation frees a place for the next explained queue position.
  const enrollmentDirectory = join(directory, 'enrollment');
  const enrollmentRepository = new EnrollmentRepository({ directory: enrollmentDirectory, records: reopened });
  const enrollment = new EnrollmentService(enrollmentRepository, { portal: new PortalClient(portal.url) });
  const request = (reference, at) => ({
    reference, eventId: 'E1', name: reference, slot: 'A',
    requestedAt: at, observedAt: at, desiredStatus: 'join',
  });
  await enrollment.applyRequests(page.records.map(record => record.attributes));
  let view = await enrollment.applyRequests([request('acceptance-wait', '2026-11-18T09:00:00Z')]);
  assert.equal(view.candidates.find(candidate => candidate.reference === 'local-1').status, 'confirmed');
  assert.equal(view.candidates.find(candidate => candidate.reference === 'acceptance-wait').status, 'waitlisted');
  view = await enrollment.cancel('local-1');
  assert.deepEqual(view.successes.map(entry => entry.reference), ['acceptance-wait']);
  const restarted = await new EnrollmentService(
    new EnrollmentRepository({ directory: enrollmentDirectory, records: reopened }),
  ).view();
  assert.equal(restarted.successes.length, 1);
  assert.equal(restarted.successes[0].receipt, view.successes[0].receipt);

  console.log(JSON.stringify({accepted: first.accepted, persisted: stored.length, replayStored: second.stored, operationRows: operations.rows.length, enrollmentSuccesses: restarted.successes.length, status: 'ok'}));
} finally {
  await portal.close();
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
