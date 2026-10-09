import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { TaskManager } from '../src/tasks.js';
import { setup, until } from './helpers.js';

async function fixture(t, overrides) {
  const s = await setup(t, overrides);
  const manager = new TaskManager(s.config);
  t.after(() => manager.close());
  return { ...s, manager };
}

test('isolated tasks, workspace locks, owner isolation and fixed pi flags', async t => {
  const { manager } = await fixture(t, { limits: { maxProcesses: 2 } });
  assert.throws(() => manager.create('u', '/tmp'), /UNKNOWN_WORKSPACE/);
  const a = manager.create('u', 'a');
  const b = manager.create('v', 'b');
  assert.notEqual(a.taskId, b.taskId);
  assert.throws(() => manager.create('v', 'a'), /WORKSPACE_BUSY/);
  assert.throws(() => manager.get('v', a.taskId), /TASK_NOT_FOUND/);
  assert.equal(manager.list('u').length, 1);
  const task = manager.get('u', a.taskId);
  await task.ready;
  const state = await task.rpc.request('get_state');
  for (const flag of ['--mode', '--no-session', '--no-extensions', '--no-mcp', '--no-approve', '--offline']) assert.ok(state.args.includes(flag));
  assert.ok(!state.envKeys.includes('NODE_OPTIONS'));
  manager.cancel('u', a.taskId);
  await task.cancelWork;
  assert.equal(task.processExited, true);
  const next = manager.create('u', 'a');
  assert.notEqual(next.taskId, a.taskId);
});

test('agent_end is not completion; accepted commands differ from settled results', async t => {
  const { manager } = await fixture(t);
  const { taskId } = manager.create('u', 'a');
  const task = manager.get('u', taskId); await task.ready;
  const receipt = manager.submit('u', taskId, 'prompt', 'normal');
  assert.equal(receipt.acceptedByPi, false);
  await task.tail;
  assert.equal(task.status, 'running');
  assert.equal(manager.result('u', taskId).final, false);
  await until(() => task.status === 'settled');
  const result = manager.result('u', taskId);
  assert.equal(result.final, true);
  assert.equal(result.available, true);
  assert.equal(result.textWithheld, true);
  assert.ok(!JSON.stringify(manager.events('u', taskId)).includes('secret'));
});

test('fast completion before prompt response remains settled; handled does not wait', async t => {
  const { manager } = await fixture(t);
  const { taskId } = manager.create('u', 'a', 'fast');
  const task = manager.get('u', taskId);
  await until(() => task.status === 'settled');
  manager.submit('u', taskId, 'prompt', 'handled');
  await task.tail;
  assert.equal(task.status, 'settled');
  assert.equal(task.disposition, 'handled');
  assert.equal(task.result.available, true); // A handled input did not start a new run or replace its result.
});

test('cancel clears queue before abort, is idempotent and rejects new input', async t => {
  const { manager, a } = await fixture(t);
  const { taskId } = manager.create('u', 'a', 'wait');
  const task = manager.get('u', taskId);
  await until(() => task.events.some(e => e.type === 'command_accepted'));
  manager.submit('u', taskId, 'steer', 'change'); await task.tail;
  manager.submit('u', taskId, 'followup', 'then'); await task.tail;
  assert.equal(task.disposition, 'queued');
  const status = manager.cancel('u', taskId);
  assert.equal(status.status, 'cancelling');
  assert.throws(() => manager.submit('u', taskId, 'prompt', 'new'), /TASK_CLOSED/);
  manager.cancel('u', taskId); await task.cancelWork;
  assert.equal(task.status, 'cancelled');
  assert.equal(task.processExited, true);
  const commands = (await readFile(join(a, 'protocol.log'), 'utf8')).trim().split('\n').map(x => JSON.parse(x).type);
  assert.deepEqual(commands.slice(-2), ['clear_queue', 'abort']);
});

for (const scenario of ['fail_clear', 'fail_abort', 'hang_abort']) {
  test(`cancel ${scenario} reports exact failed action and kills pi`, async t => {
    const { manager, a } = await fixture(t, { limits: { rpcTimeoutMs: 150 } });
    await writeFile(join(a, 'fake-scenario'), scenario);
    const { taskId } = manager.create('u', 'a', 'wait'); const task = manager.get('u', taskId);
    await until(() => task.events.some(e => e.type === 'command_accepted'));
    manager.cancel('u', taskId); await task.cancelWork;
    assert.equal(task.status, 'cleanup_unconfirmed'); assert.equal(task.processExited, true);
    assert.equal(task.cleanupStatus, 'unconfirmed');
    assert.throws(() => manager.create('u', 'a'), /WORKSPACE_QUARANTINED/);
    assert.equal(task.error.action, scenario === 'fail_clear' ? 'clear_queue' : 'abort');
  });
}

test('bounded events indicate eviction gap and reject impossible cursors', async t => {
  const { manager } = await fixture(t, { limits: { maxEvents: 5 } });
  const { taskId } = manager.create('u', 'a', 'flood'); const task = manager.get('u', taskId);
  await until(() => task.status === 'settled');
  const page = manager.events('u', taskId, 0, 2);
  assert.equal(page.events.length, 2); assert.equal(page.gap, true); assert.equal(page.hasMore, true);
  assert.throws(() => manager.events('u', taskId, task.seq + 1), /INVALID_CURSOR/);
  assert.ok(task.events.length <= 5);
});

test('opt-in text redacts known credentials before truncating', async t => {
  const { manager } = await fixture(t, { outputMode: 'redacted_text', limits: { maxTextChars: 128 } });
  const { taskId } = manager.create('u', 'a', 'secret'); const task = manager.get('u', taskId);
  await until(() => task.status === 'settled');
  const result = manager.result('u', taskId);
  assert.equal(result.text.length, 128); assert.equal(result.truncated, true);
  for (const secret of ['fake-value', 'sk-testsecret', 'faketoken', 'never-return-stderr']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('model error is a failed task at agent_settled, not success', async t => {
  const { manager } = await fixture(t);
  const { taskId } = manager.create('u', 'a', 'model-error'); const task = manager.get('u', taskId);
  await until(() => task.status === 'failed' && task.processExited);
  assert.equal(task.error.code, 'AGENT_ERROR');
});

test('run timeout, idle expiry and bounded retention clean up process and task', async t => {
  const { manager } = await fixture(t, { limits: { taskTimeoutMs: 120, idleTimeoutMs: 100, retentionMs: 100 } });
  const { taskId } = manager.create('u', 'a', 'wait'); const task = manager.get('u', taskId);
  await until(() => task.status === 'timed_out');
  assert.equal(task.processExited, true);
  await setTimeout(120); manager.sweep();
  assert.throws(() => manager.get('u', taskId), /TASK_NOT_FOUND/);
  const second = manager.create('u', 'a'); const idle = manager.get('u', second.taskId); await idle.ready;
  await setTimeout(120); manager.sweep(); await idle.cancelWork;
  assert.equal(idle.status, 'closed'); assert.equal(idle.processExited, true);
});

test('closing task also terminates spawned tool process group', async t => {
  const { manager, a } = await fixture(t);
  const { taskId } = manager.create('u', 'a', 'spawn-tool'); const task = manager.get('u', taskId);
  await until(() => task.events.some(e => e.type === 'command_accepted'));
  manager.cancel('u', taskId); await task.cancelWork;
  await setTimeout(900);
  await assert.rejects(access(join(a, 'tool-survived')));
});

test('slash commands and queue overflow are rejected before pi; failed command allows retry', async t => {
  const { manager } = await fixture(t, { limits: { maxQueuedCommands: 1 } });
  const { taskId } = manager.create('u', 'a'); const task = manager.get('u', taskId); await task.ready;
  assert.throws(() => manager.submit('u', taskId, 'prompt', '/reload'), /SLASH_COMMAND_DISABLED/);
  manager.submit('u', taskId, 'prompt', 'reject');
  assert.throws(() => manager.submit('u', taskId, 'prompt', 'more'), /COMMAND_LIMIT/);
  await task.tail;
  assert.equal(task.status, 'idle');
  assert.ok(task.events.some(e => e.type === 'command_failed' && e.code === 'COMMAND_REJECTED'));
  manager.submit('u', taskId, 'prompt', 'fast'); await task.tail;
  assert.equal(task.status, 'settled');
});
