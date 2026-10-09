import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PiRpc, RpcError } from './rpc.js';
import { piEnvironment } from './config.js';
import { eventSummary, redactor, safeText } from './output.js';

const terminal = new Set(['failed', 'timed_out', 'cancelled', 'closed', 'cleanup_unconfirmed']);
const behaviors = { prompt: undefined, steer: 'steer', followup: 'followUp' };
const errorSummary = error => ({ code: error.code || 'INTERNAL_ERROR', action: error.action || 'task' });
const totalBytes = entries => [...entries.values()].reduce((sum, bytes) => sum + bytes, 0);

export class TaskManager {
  constructor(config) {
    this.config = config;
    this.tasks = new Map();
    this.locks = new Set();
    this.quarantined = new Set();
    this.leaseDir = join(config.piHome, 'pipro-leases');
    mkdirSync(this.leaseDir, { recursive: true, mode: 0o700 });
    for (const [workspace, cwd] of Object.entries(config.workspaces)) {
      if (existsSync(join(this.leaseDir, `${workspace}.json`))) {
        this.locks.add(cwd); this.quarantined.add(cwd);
      }
    }
    this.closing = false;
    this.env = piEnvironment(config);
    this.redact = redactor(config.passEnv.map(key => this.env[key]));
    this.janitor = setInterval(() => this.sweep(), 1000);
    this.janitor.unref();
  }

  emit(task, event) {
    task.updatedAt = Date.now();
    task.events.push({ seq: ++task.seq, time: task.updatedAt, ...event });
    if (task.events.length > this.config.limits.maxEvents) task.events.shift();
  }

  get(owner, id) {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner) throw new RpcError('TASK_NOT_FOUND', 'task');
    return task;
  }

  snapshot(task) {
    return { taskId: task.id, workspace: task.workspace, status: task.status,
      createdAt: task.createdAt, updatedAt: task.updatedAt, eventCursor: task.seq,
      lastDisposition: task.disposition ?? null, error: task.error ?? null,
      cleanupError: task.cleanupError ?? null, cleanupStatus: task.cleanupStatus,
      processExited: task.processExited, pendingCommands: task.queued,
      pendingMessages: task.piQueueCount + task.unknownQueue.size,
      queuedMessageBytes: task.piQueueBytes + totalBytes(task.unknownQueue),
      outputMode: this.config.outputMode };
  }

  list(owner) { return [...this.tasks.values()].filter(t => t.owner === owner).map(t => this.snapshot(t)); }

  create(owner, workspace, prompt) {
    if (this.closing) throw new RpcError('SERVICE_CLOSING', 'create');
    if (!Object.hasOwn(this.config.workspaces, workspace)) throw new RpcError('UNKNOWN_WORKSPACE', 'create');
    const cwd = this.config.workspaces[workspace];
    if (this.quarantined.has(cwd)) throw new RpcError('WORKSPACE_QUARANTINED', 'create');
    if (this.locks.has(cwd)) throw new RpcError('WORKSPACE_BUSY', 'create');
    if ([...this.tasks.values()].filter(t => !t.processExited).length >= this.config.limits.maxProcesses) throw new RpcError('PROCESS_LIMIT', 'create');
    this.sweep();
    if (this.tasks.size >= this.config.limits.maxTasks) throw new RpcError('TASK_LIMIT', 'create');
    if (prompt !== undefined) {
      this.validateMessage(prompt);
      if (Buffer.byteLength(prompt) > this.config.limits.maxQueuedMessageBytes) throw new RpcError('MESSAGE_BYTES_LIMIT', 'create');
    }
    const task = { id: randomUUID(), owner, workspace, cwd, status: 'starting', createdAt: Date.now(),
      updatedAt: Date.now(), lastInputAt: Date.now(), events: [], seq: 0, queued: 0,
      reservations: new Map(), unknownQueue: new Map(), piQueueCount: 0, piQueueBytes: 0, queueVersion: 0,
      runActive: false, runEpoch: 0, cleanupStatus: 'pending',
      processExited: false, tail: Promise.resolve(), result: { available: false } };
    task.lease = join(this.leaseDir, `${workspace}.json`);
    // An exclusive lease also protects against another server and survives abrupt server death.
    try {
      writeFileSync(task.lease, JSON.stringify({ taskId: task.id, workspace, cwd, status: 'active' }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') {
        this.locks.add(cwd); this.quarantined.add(cwd);
        throw new RpcError('WORKSPACE_QUARANTINED', 'create');
      }
      throw new RpcError('LEASE_WRITE_FAILED', 'create');
    }
    this.tasks.set(task.id, task);
    this.locks.add(cwd);
    this.emit(task, { type: 'task_created' });
    task.ready = this.start(task, prompt);
    return this.snapshot(task);
  }

  release(task) {
    try { unlinkSync(task.lease); }
    catch (error) { if (error.code !== 'ENOENT') { this.cleanupFailed(task, new RpcError('LEASE_REMOVE_FAILED', 'release_workspace')); return; } }
    task.cleanupStatus = 'confirmed';
    this.locks.delete(task.cwd);
  }

  quarantine(task) {
    task.status = 'cleanup_unconfirmed';
    task.cleanupStatus = 'unconfirmed';
    this.quarantined.add(task.cwd);
    // The original exclusive marker survives if this best-effort update fails.
    try {
      writeFileSync(task.lease, JSON.stringify({ taskId: task.id, workspace: task.workspace, cwd: task.cwd,
        status: 'cleanup_unconfirmed', error: task.error }), { mode: 0o600 });
    } catch { task.cleanupError ??= { code: 'LEASE_UPDATE_FAILED', action: 'quarantine_workspace' }; }
  }

  async start(task, prompt) {
    try {
      if (await realpath(task.cwd) !== task.cwd) throw new RpcError('WORKSPACE_CHANGED', 'spawn');
      if (terminal.has(task.status) || task.status === 'cancelling') return;
      const args = ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp', '--no-skills',
        '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline',
        '--tools', 'read,bash,edit,write,grep,find,ls'];
      if (this.config.provider) args.push('--provider', this.config.provider);
      if (this.config.model) args.push('--model', this.config.model);
      task.rpc = new PiRpc({ executable: this.config.piExecutable, args, cwd: task.cwd, env: this.env,
        timeoutMs: this.config.limits.rpcTimeoutMs, maxRecordBytes: this.config.limits.maxRecordBytes });
      task.rpc.on('event', record => this.onEvent(task, record));
      task.rpc.on('failure', error => {
        task.failure ??= error;
        task.error ??= errorSummary(error);
        if (task.status !== 'cancelling') this.fail(task, error);
      });
      task.rpc.on('cleanupFailure', code => this.cleanupFailed(task, new RpcError(code, 'terminate_process_group')));
      task.rpc.on('exit', () => { task.processExited = true; });
      const state = await task.rpc.request('get_state');
      if (typeof state?.isStreaming !== 'boolean') throw new RpcError('INVALID_STATE', 'get_state');
      if (task.status !== 'starting') return;
      task.status = 'idle';
      this.emit(task, { type: 'task_ready' });
      if (prompt !== undefined) this.submit(task.owner, task.id, 'prompt', prompt);
    } catch (error) {
      task.failure ??= error; task.error ??= errorSummary(error);
      if (task.status !== 'cancelling') this.fail(task, error);
    } finally {
      if (!task.rpc) task.processExited = true;
      if ((!task.rpc || !task.rpc.child.pid) && task.status !== 'cancelling') this.release(task);
    }
  }

  armDeadline(task) {
    clearTimeout(task.deadline);
    task.deadline = setTimeout(() => this.expire(task), this.config.limits.taskTimeoutMs);
  }

  updateQueue(task, record) {
    if (!Array.isArray(record.steering) || !Array.isArray(record.followUp)
      || [...record.steering, ...record.followUp].some(m => typeof m !== 'string')) {
      this.fail(task, new RpcError('INVALID_QUEUE', 'queue_update')); return;
    }
    const messages = [...record.steering, ...record.followUp];
    task.piQueueCount = messages.length;
    task.piQueueBytes = messages.reduce((sum, m) => sum + Buffer.byteLength(m), 0);
    task.queueVersion++;
    task.unknownQueue.clear(); // Full authoritative snapshot, including consumption/removal.
    if (task.piQueueCount > this.config.limits.maxQueuedCommands || task.piQueueBytes > this.config.limits.maxQueuedMessageBytes) {
      this.fail(task, new RpcError('PI_QUEUE_LIMIT', 'queue_update')); return;
    }
    if (task.piQueueCount && !task.runActive && !terminal.has(task.status) && task.status !== 'cancelling') {
      task.status = 'queued'; if (!task.deadline) this.armDeadline(task);
    }
  }

  onEvent(task, record) {
    this.emit(task, eventSummary(record));
    if (terminal.has(task.status)) return;
    if (record.type === 'queue_update') this.updateQueue(task, record);
    if (record.type === 'agent_start') {
      if (!task.runActive) {
        task.runActive = true; task.runEpoch++;
        task.result = { available: false }; task.runError = false;
        if (task.status !== 'cancelling') this.armDeadline(task);
      }
      if (task.status !== 'cancelling') task.status = 'running';
    }
    if (record.type === 'message_end' && record.message?.role === 'assistant') {
      const message = record.message;
      task.runError = message.stopReason === 'error';
      const blocks = Array.isArray(message.content) ? message.content : [];
      const raw = blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
      task.result = { available: true, stopReason: ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message.stopReason)
        ? message.stopReason : 'unknown',
        ...(this.config.outputMode === 'redacted_text' ? safeText(raw, this.redact, this.config.limits.maxTextChars)
          : { textWithheld: true }) };
    }
    if (record.type === 'agent_settled') {
      task.runActive = false;
      clearTimeout(task.deadline); task.deadline = undefined;
      if (task.status === 'cancelling') return;
      if (task.runError || record.aborted === true) {
        if (task.runError) task.error = { code: 'AGENT_ERROR', action: 'run' };
        task.status = 'cancelling';
        task.cancelWork = this.stop(task, task.runError ? 'failed' : 'cancelled');
      } else if (task.piQueueCount || task.unknownQueue.size) {
        task.status = 'queued'; this.armDeadline(task);
      } else task.status = 'settled';
    }
  }

  validateMessage(message) {
    if (typeof message !== 'string' || !message.trim() || message.length > this.config.limits.maxPromptChars) throw new RpcError('INVALID_PROMPT', 'submit');
    if (message.trimStart().startsWith('/')) throw new RpcError('SLASH_COMMAND_DISABLED', 'submit');
  }

  submit(owner, id, mode, message) {
    const task = this.get(owner, id);
    this.validateMessage(message);
    if (!Object.hasOwn(behaviors, mode)) throw new RpcError('INVALID_MODE', 'submit');
    if (terminal.has(task.status) || task.status === 'cancelling') throw new RpcError('TASK_CLOSED', 'submit');
    if (task.status === 'starting') throw new RpcError('TASK_NOT_READY', 'submit');
    const bytes = Buffer.byteLength(message);
    if (task.piQueueCount + task.unknownQueue.size + task.reservations.size >= this.config.limits.maxQueuedCommands) throw new RpcError('COMMAND_LIMIT', 'submit');
    if (task.piQueueBytes + totalBytes(task.unknownQueue) + totalBytes(task.reservations) + bytes > this.config.limits.maxQueuedMessageBytes) throw new RpcError('MESSAGE_BYTES_LIMIT', 'submit');
    const commandId = randomUUID();
    task.reservations.set(commandId, bytes); task.queued++;
    task.lastInputAt = Date.now();
    this.emit(task, { type: 'command_submitted', commandId, mode });
    task.tail = task.tail.then(async () => {
      await task.ready;
      if (terminal.has(task.status) || task.status === 'cancelling') throw new RpcError('TASK_CLOSED', mode);
      const queueVersion = task.queueVersion;
      const epoch = task.runEpoch;
      const data = await task.rpc.request('prompt', { message,
        ...(behaviors[mode] ? { streamingBehavior: behaviors[mode] } : {}) });
      if (!['started', 'queued', 'handled'].includes(data?.disposition)) throw new RpcError('INVALID_DISPOSITION', 'prompt');
      task.disposition = data.disposition;
      if (data.disposition === 'queued' && task.queueVersion === queueVersion) task.unknownQueue.set(commandId, bytes);
      if (!terminal.has(task.status) && task.status !== 'cancelling') {
        if (data.disposition === 'started' && task.runEpoch === epoch) {
          task.status = 'running'; this.armDeadline(task); // Watch acceptance-to-start if event has not arrived yet.
        } else if (data.disposition === 'queued' && !task.runActive && (task.piQueueCount || task.unknownQueue.size)) {
          task.status = 'queued'; if (!task.deadline) this.armDeadline(task);
        }
      }
      this.emit(task, { type: 'command_accepted', commandId, mode, disposition: data.disposition });
    }).catch(error => {
      this.emit(task, { type: 'command_failed', commandId, mode, code: error.code || 'INTERNAL_ERROR', action: error.action || mode });
      if (!['TASK_CLOSED', 'COMMAND_REJECTED'].includes(error.code)) {
        task.failure ??= error; task.error ??= errorSummary(error);
        if (task.status !== 'cancelling') this.fail(task, error);
      }
    }).finally(() => { task.reservations.delete(commandId); task.queued--; });
    return { taskId: id, commandId, acceptedByService: true, acceptedByPi: false };
  }

  fail(task, error) {
    task.failure ??= error; task.error ??= errorSummary(error);
    task.endedAt = Date.now();
    clearTimeout(task.deadline); task.deadline = undefined;
    if (task.rpc?.child.pid) this.quarantine(task); else task.status = 'failed';
    this.emit(task, { type: 'task_failed', ...task.error, status: task.status });
    if (task.rpc) void task.rpc.close().catch(e => this.cleanupFailed(task, e));
  }

  cleanupFailed(task, error) {
    task.cleanupError ??= errorSummary(error); task.error ??= errorSummary(error);
    task.endedAt = Date.now(); this.quarantine(task);
    this.emit(task, { type: 'cleanup_failed', ...task.cleanupError });
  }

  cancel(owner, id) {
    const task = this.get(owner, id);
    if (task.status === 'cancelling' || terminal.has(task.status)) return this.snapshot(task);
    task.status = 'cancelling';
    clearTimeout(task.deadline); task.deadline = undefined;
    this.emit(task, { type: 'cancel_requested' });
    task.cancelWork = this.stop(task, 'cancelled');
    return this.snapshot(task);
  }

  async stop(task, target) {
    await task.ready;
    await task.tail;
    let error = task.failure || task.rpc?.failure;
    if (task.rpc && !error) {
      if (task.rpc.closed) error = new RpcError('PROCESS_CLOSED', 'cancel');
      else {
        try {
          await task.rpc.request('clear_queue');
          task.piQueueCount = 0; task.piQueueBytes = 0; task.unknownQueue.clear();
          await task.rpc.request('abort');
        } catch (e) { error = e; }
      }
    }
    if (error) {
      const summary = errorSummary(error);
      if (task.error && (task.error.code !== summary.code || task.error.action !== summary.action)) task.cleanupError ??= summary;
      task.error ??= summary;
    }
    if (task.rpc) {
      try { await task.rpc.close(); } catch (e) { error ??= e; this.cleanupFailed(task, e); }
    }
    error ||= task.failure || task.rpc?.failure;
    if (error || task.cleanupError) {
      task.error ??= errorSummary(error || new RpcError('CLEANUP_FAILED', 'cancel'));
      if (task.rpc?.child.pid) this.quarantine(task); else { task.status = 'failed'; this.release(task); }
    } else { task.status = target; this.release(task); }
    task.endedAt = Date.now();
    this.emit(task, { type: task.cleanupStatus === 'unconfirmed' ? 'cancel_failed' : 'task_stopped', status: task.status });
  }

  expire(task) {
    if (terminal.has(task.status) || task.status === 'cancelling') return;
    task.status = 'cancelling';
    task.error = { code: 'TASK_TIMEOUT', action: 'run' };
    this.emit(task, { type: 'task_timeout' });
    task.cancelWork = this.stop(task, 'timed_out');
  }

  events(owner, id, after = 0, limit = 20) {
    const task = this.get(owner, id);
    if (!Number.isSafeInteger(after) || after < 0 || after > task.seq || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new RpcError('INVALID_CURSOR', 'events');
    const oldest = task.events[0]?.seq ?? task.seq + 1;
    const events = task.events.filter(e => e.seq > after).slice(0, limit);
    const nextCursor = events.at(-1)?.seq ?? after;
    return { taskId: id, events, nextCursor, gap: after < oldest - 1, oldestCursor: oldest - 1, hasMore: task.seq > nextCursor };
  }

  result(owner, id) {
    const task = this.get(owner, id);
    const final = task.status !== 'cleanup_unconfirmed' && (task.status === 'settled' || terminal.has(task.status))
      && !task.runActive && !task.queued && !task.piQueueCount && !task.unknownQueue.size;
    return { ...this.snapshot(task), ...task.result, final };
  }

  sweep() {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.cleanupStatus === 'confirmed' && task.processExited && terminal.has(task.status) && now - task.endedAt > this.config.limits.retentionMs) this.tasks.delete(task.id);
      else if (['idle', 'settled'].includes(task.status) && !task.queued && !task.piQueueCount && !task.unknownQueue.size
        && now - Math.max(task.lastInputAt, task.updatedAt) > this.config.limits.idleTimeoutMs) {
        task.status = 'cancelling'; task.cancelWork = this.stop(task, 'closed');
      }
    }
  }

  async close() {
    this.closing = true; clearInterval(this.janitor);
    await Promise.all([...this.tasks.values()].map(async task => {
      if (!terminal.has(task.status)) this.cancel(task.owner, task.id);
      await task.cancelWork;
      if (task.rpc) { try { await task.rpc.close(); } catch (error) { this.cleanupFailed(task, error); } }
    }));
  }
}
