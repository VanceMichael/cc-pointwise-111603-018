import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { EnrollmentRepository } from './enrollment-repository.js';
import { EnrollmentService } from './enrollment-service.js';
import { PortalClient } from './portal-client.js';
import { readOperations } from './operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const recordsPath = process.env.RECORDS_FILE ?? resolve(here, '../var/records.json');
const records = new RecordRepository(recordsPath);
const service = new CollectionService(records);
const enrollment = new EnrollmentService(new EnrollmentRepository({
  directory: process.env.ENROLLMENT_DIR ?? resolve(here, '../var/enrollment'),
  records,
}));
const commandHelp = [
  { name: 'ingest', usage: 'ingest [文件]', description: '从 JSON 文件导入来源观察' },
  { name: 'query', usage: 'query [来源]', description: '查询本地来源观察' },
  { name: 'status', usage: 'status', description: '读取候选、成功名单、候补顺序与回执' },
  { name: 'apply', usage: 'apply [文件] [--no-process] [--portal URL]', description: '把居民申请接入门户确认（默认文件 fixtures/records.json）' },
  { name: 'enroll', usage: 'enroll <reference> [--slot A] [--name 姓名] [--event E1] [--document passport|identity-card] [--portal URL]', description: '登记居民申请并等待门户确认' },
  { name: 'process', usage: 'process [--retry] [--portal URL]', description: '处理待办；重试前先核对门户既有报名' },
  { name: 'lookup', usage: 'lookup <reference> [--portal URL]', description: '用门户报名记录核对本地状态' },
  { name: 'cancel', usage: 'cancel <reference> [--receipt 回执] [--portal URL]', description: '取消报名；释放名额后按候补顺序递补' },
  { name: 'operations', usage: 'operations', description: '业务读取入口（来源观察与报名状态一致视图）' },
];

function parseOptions(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const [name, inline] = value.slice(2).split('=', 2);
      if (inline !== undefined) options[name] = inline;
      else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
        options[name] = argv[index + 1];
        index += 1;
      } else options[name] = true;
    } else positional.push(value);
  }
  return { options, positional };
}

function portalFrom(options) {
  const url = options.portal ?? process.env.PORTAL_URL;
  if (!url) {
    throw new Error('portal url required: pass --portal http://127.0.0.1:PORT or set PORTAL_URL');
  }
  return new PortalClient(url);
}

function withPortal(options) {
  enrollment.portal = portalFrom(options);
  return enrollment;
}

function output(value, pretty = true) {
  console.log(JSON.stringify(value, null, pretty ? 2 : 0));
}

const action = process.argv[2] ?? '--help';
if (action === '--help' || action === '-h') {
  output({
    usage: 'npm start -- ingest [文件] | query [来源] | apply [文件] | status | enroll <reference> | process | lookup <reference> | cancel <reference> | operations',
    commands: ['ingest', 'query'],
    enrollmentCommands: commandHelp.slice(2).map((entry) => entry.name),
    help: commandHelp,
  });
  process.exit(0);
}

const { options, positional } = parseOptions(process.argv.slice(3));
try {
  if (action === 'ingest') {
    const inputs = JSON.parse(await readFile(positional[0] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
    output(await service.ingest(inputs));
  } else if (action === 'query') {
    output(await service.query({ source: positional[0] }));
  } else if (action === 'status') {
    output(await enrollment.view());
  } else if (action === 'apply') {
    const records = JSON.parse(await readFile(positional[0] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
    const target = options['no-process'] ? enrollment : withPortal(options);
    output(await target.applyRequests(records, {
      process: !options['no-process'],
      documentType: options.document,
    }));
  } else if (action === 'enroll') {
    const reference = positional[0];
    if (!reference) throw new Error('enroll requires reference');
    const input = {
      reference,
      eventId: options.event ?? 'E1',
      name: options.name ?? reference,
      slot: options.slot ?? 'A',
      requestedAt: options['requested-at'] ?? new Date().toISOString(),
      desiredStatus: 'join',
      observedAt: new Date().toISOString(),
    };
    output(await withPortal(options).applyRequests([input], {
      documentType: options.document,
    }));
  } else if (action === 'process') {
    output(await withPortal(options).runQueue({ retry: Boolean(options.retry) }));
  } else if (action === 'lookup') {
    if (!positional[0]) throw new Error('lookup requires reference');
    output(await withPortal(options).lookup(positional[0]));
  } else if (action === 'cancel') {
    if (!positional[0]) throw new Error('cancel requires reference');
    output(await withPortal(options).cancel(positional[0], { receipt: options.receipt }));
  } else if (action === 'operations') {
    output(await readOperations(enrollment.repository));
  } else {
    throw new Error('action must be ingest or query or an enrollment command; see --help');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
