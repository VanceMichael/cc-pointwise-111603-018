import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { RecordRepository } from './repository.js';

const EMPTY = Object.freeze({ candidates: [], receipts: [] });
const LOCK_TIMEOUT = 15000;
const LOCK_STALE = 120000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const transactions = new WeakMap();

async function readCollection(path, key) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const value = JSON.parse(text);
  if (Array.isArray(value)) return value;
  if (!value || !Array.isArray(value[key])) throw new Error(`${key} collection missing`);
  return value[key];
}

async function writeCollection(path, key, items) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ [key]: items }, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Stores candidate allocations and portal receipts separately from the source
 * observation collection. Candidate state never doubles as proof of a place.
 */
export class EnrollmentRepository {
  constructor(directory, options = {}) {
    if (directory && typeof directory === 'object') {
      options = directory;
      directory = options.directory;
    }
    if (typeof directory !== 'string' || !directory) {
      throw new TypeError('enrollment directory is required');
    }
    this.directory = directory;
    this.candidatesPath = join(directory, 'candidates.json');
    this.receiptsPath = join(directory, 'receipts.json');
    this.recordsRepository = options.records ?? null;
    this.recordsPath = options.recordsPath ?? null;
  }

  /** The existing business read entry expects repository.read() to return observations. */
  async read() {
    if (this.recordsRepository) return this.recordsRepository.read();
    if (this.recordsPath) return new RecordRepository(this.recordsPath).read();
    return [];
  }

  async readCandidates() {
    return readCollection(this.candidatesPath, 'candidates');
  }

  async readReceipts() {
    return readCollection(this.receiptsPath, 'receipts');
  }

  async readEnrollment() {
    const [candidates, receipts] = await Promise.all([
      this.readCandidates(), this.readReceipts(),
    ]);
    return { candidates, receipts };
  }

  async writeCandidates(candidates) {
    await writeCollection(this.candidatesPath, 'candidates', candidates);
  }

  async writeReceipts(receipts) {
    await writeCollection(this.receiptsPath, 'receipts', receipts);
  }

  async writeEnrollment(state) {
    const candidates = Array.isArray(state?.candidates) ? state.candidates : [];
    const receipts = Array.isArray(state?.receipts) ? state.receipts : [];
    // Receipts are written before candidates: success is derived by joining a
    // candidate to a confirmed receipt, so a crash between the two writes can
    // leave an orphan receipt (not counted) but never a success without one.
    await this.writeReceipts(receipts);
    await this.writeCandidates(candidates);
  }

  async replace(records) {
    if (this.recordsRepository) return this.recordsRepository.replace(records);
    if (this.recordsPath) return new RecordRepository(this.recordsPath).replace(records);
    throw new Error('record store is not configured');
  }

  async clear() {
    await this.writeEnrollment(EMPTY);
  }

  /**
   * Cross-process mutual exclusion for one enrollment directory. The
   * in-process queue alone is not enough when two CLI invocations race for the
   * same slot or both try to cancel/promote at once.
   */
  async exclusive(operation) {
    await mkdir(this.directory, { recursive: true });
    const lockPath = join(this.directory, 'state.lock');
    const started = Date.now();
    let handle;
    while (!handle) {
      try {
        handle = await open(lockPath, 'wx');
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > LOCK_STALE) {
            await rm(lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code === 'ENOENT') continue;
          throw statError;
        }
        if (Date.now() - started > LOCK_TIMEOUT) {
          throw new Error('enrollment state is locked by another process');
        }
        await delay(5);
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => {});
      await rm(lockPath, { force: true }).catch(() => {});
    }
  }

  /** Runs a read-modify-write cycle under both in-process and file locking. */
  async transaction(operation) {
    const previous = transactions.get(this) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    transactions.set(this, tail);
    await previous;
    try {
      return await this.exclusive(async () => {
        const state = await this.readEnrollment();
        const value = await operation(state);
        await this.writeEnrollment(state);
        return value;
      });
    } finally {
      release();
      if (transactions.get(this) === tail) transactions.delete(this);
    }
  }
}
