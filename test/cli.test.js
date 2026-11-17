import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('命令帮助列出导入和查询入口且正常退出', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--help'], {encoding: 'utf8'});
  assert.equal(result.status, 0);
  const help = JSON.parse(result.stdout);
  assert.ok(help.usage.includes('ingest'));
  assert.deepEqual(help.commands, ['ingest', 'query']);
  for (const command of ['status', 'enroll', 'process', 'lookup', 'cancel', 'operations']) {
    assert.ok(help.enrollmentCommands.includes(command), command);
  }
});

test('未知动作明确失败而不执行默认查询', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'invalid-action'], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ingest or query/);
});

test('status 读取报名视图且不需要门户', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cli-status-'));
  try {
    const result = spawnSync(process.execPath, ['src/cli.js', 'status'], {encoding: 'utf8', env: {
      ...process.env,
      RECORDS_FILE: join(directory, 'records.json'),
      ENROLLMENT_DIR: join(directory, 'enrollment'),
    }});
    assert.equal(result.status, 0, result.stderr);
    const view = JSON.parse(result.stdout);
    assert.deepEqual(view.rows, []);
    assert.deepEqual(view.candidates, []);
    assert.deepEqual(view.successes, []);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('enroll 缺少门户地址时明确失败', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cli-enroll-'));
  try {
    const result = spawnSync(process.execPath, ['src/cli.js', 'enroll', 'local-1'], {encoding: 'utf8', env: {
      ...process.env,
      RECORDS_FILE: join(directory, 'records.json'),
      ENROLLMENT_DIR: join(directory, 'enrollment'),
      PORTAL_URL: '',
    }});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /portal url required/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
