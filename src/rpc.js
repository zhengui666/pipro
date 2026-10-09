import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export class RpcError extends Error {
  constructor(code, action, detail = '') {
    super(`${code}: ${action}${detail ? ` (${detail})` : ''}`);
    this.code = code;
    this.action = action;
  }
}

export class PiRpc extends EventEmitter {
  constructor({ executable, args, cwd, env, timeoutMs = 5000, maxRecordBytes = 1048576 }) {
    super();
    this.timeoutMs = timeoutMs;
    this.maxRecordBytes = maxRecordBytes;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.failure = null;
    this.stopping = false;
    this.writeTail = Promise.resolve();
    this.child = spawn(executable, args, { cwd, env, shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.stderr.resume(); // Never forward arbitrary diagnostics or credentials.
    this.child.stdin.on('error', () => this.fail(new RpcError('PIPE_CLOSED', 'write')));
    this.child.on('error', error => this.fail(new RpcError('SPAWN_FAILED', 'spawn', error.code || 'unknown')));
    this.child.on('exit', (code, signal) => {
      // Descendants may retain stdout/stderr; do not wait forever for stream close.
      // Briefly allow the final pipe records to drain before classifying the exit.
      const timer = setTimeout(() => {
        if (!this.closed && !this.stopping) this.fail(new RpcError(this.buffer.length ? 'TRUNCATED_RECORD' : 'PROCESS_EXIT',
          this.buffer.length ? 'stdout' : 'pi', `${code ?? signal}`));
      }, 50);
      timer.unref();
    });
    this.child.on('close', (code, signal) => {
      if (this.buffer.length && !this.stopping) this.fail(new RpcError('TRUNCATED_RECORD', 'stdout'));
      if (!this.closed) this.fail(new RpcError('PROCESS_EXIT', 'pi', `${code ?? signal}`));
      this.resolveExit();
      this.emit('exit');
    });
  }

  consume(chunk) {
    if (this.closed) return;
    // Split on byte LF only: U+2028/U+2029 are legal JSON string content.
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start);
      const end = lf < 0 ? chunk.length : lf;
      const piece = chunk.subarray(start, end);
      if (this.buffer.length + piece.length > this.maxRecordBytes) {
        this.fail(new RpcError('RECORD_TOO_LARGE', 'stdout')); return;
      }
      this.buffer = Buffer.concat([this.buffer, piece]);
      if (lf < 0) return;
      const line = this.buffer;
      this.buffer = Buffer.alloc(0);
      try {
        const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') {
          throw new Error('invalid record');
        }
        this.record(record);
      } catch {
        this.fail(new RpcError('INVALID_JSONL', 'stdout')); return;
      }
      if (this.closed) return;
      start = lf + 1;
    }
  }

  record(record) {
    if (record.type !== 'response') { this.emit('event', record); return; }
    if (typeof record.id !== 'string') { this.fail(new RpcError('UNCORRELATED_RESPONSE', 'stdout')); return; }
    const p = this.pending.get(record.id);
    if (!p) return; // Duplicates / late replies cannot resolve a different request.
    if (record.command !== p.type || typeof record.success !== 'boolean') {
      this.fail(new RpcError('INVALID_RESPONSE', p.type)); return;
    }
    this.pending.delete(record.id);
    clearTimeout(p.timer);
    if (!record.success) p.reject(new RpcError('COMMAND_REJECTED', p.type));
    else p.resolve(record.data);
  }

  request(type, data = {}) {
    if (this.closed || this.stopping) return Promise.reject(new RpcError('PROCESS_CLOSED', type));
    if (this.pending.size >= 32) return Promise.reject(new RpcError('RPC_BUSY', type));
    const id = randomUUID();
    const bytes = JSON.stringify({ ...data, type, id }) + '\n';
    if (Buffer.byteLength(bytes) > this.maxRecordBytes) return Promise.reject(new RpcError('COMMAND_TOO_LARGE', type));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new RpcError('RPC_TIMEOUT', type)), this.timeoutMs);
      this.pending.set(id, { type, resolve, reject, timer });
      const write = () => new Promise((done, failed) => {
        if (this.closed || this.stopping) { failed(new RpcError('PROCESS_CLOSED', type)); return; }
        // The callback respects writable backpressure before the next queued write.
        this.child.stdin.write(bytes, error => error ? failed(error) : done());
      });
      this.writeTail = this.writeTail.then(write).catch(() => this.fail(new RpcError('PIPE_CLOSED', type)));
    });
  }

  fail(error) {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.emit('failure', error);
    void this.close().catch(error => this.emit('cleanupFailure', error.code || 'unknown'));
  }

  signal(signal) {
    try {
      if (this.child.pid) {
        if (process.platform === 'win32') this.child.kill(signal);
        else process.kill(-this.child.pid, signal);
      }
    } catch (error) { if (error.code !== 'ESRCH') this.emit('cleanupFailure', error.code || 'unknown'); }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.shutdown();
    return this.closePromise;
  }

  async shutdown() {
    this.stopping = true;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new RpcError('PROCESS_CLOSED', p.type)); }
    this.pending.clear();
    this.child.stdin.end();
    const term = setTimeout(() => this.signal('SIGTERM'), 200);
    const kill = setTimeout(() => this.signal('SIGKILL'), 600);
    let deadline;
    try {
      await Promise.race([this.exited, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new RpcError('SHUTDOWN_TIMEOUT', 'terminate_process_group')), 2000);
      })]);
      // Reap remaining tools in the process group even after the RPC parent exits.
      this.signal('SIGKILL');
    } finally { clearTimeout(term); clearTimeout(kill); clearTimeout(deadline); }
  }
}
