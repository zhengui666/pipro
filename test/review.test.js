import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { TaskManager } from '../src/tasks.js';
import { setup, until } from './helpers.js';

async function fixture(t, scenario, limits = {}) {
  const s = await setup(t, { limits: { rpcTimeoutMs: 200, ...limits } });
  await writeFile(join(s.a, 'fake-scenario'), scenario);
  const manager = new TaskManager(s.config); t.after(() => manager.close());
  const { taskId } = manager.create('review', 'a', 'wait');
  const task = manager.get('review', taskId);
  await until(() => task.events.some(e => e.type === (scenario === 'cancel-timeout' ? 'agent_start' : 'command_accepted')));
  return { ...s, manager, taskId, task };
}

for (const limit of [8, 1]) {
  test(`review startup order: immediate external input cannot overtake the initial prompt with queue limit ${limit}`, async t => {
    const { config, a } = await setup(t, limit === 8 ? {} : { limits: { maxQueuedCommands: 1 } });
    const manager = new TaskManager(config); t.after(() => manager.close());
    const { taskId, status } = manager.create('review', 'a', 'wait');
    const task = manager.get('review', taskId);
    assert.equal(status, 'starting');
    assert.equal(config.limits.maxQueuedCommands, limit);
    for (const mode of ['followup', 'steer', 'prompt']) {
      assert.throws(() => manager.submit('review', taskId, mode, 'early external input'),
        { code: 'TASK_NOT_READY', action: 'submit' });
    }
    assert.equal(task.queued, 0);
    await task.ready; await task.tail;
    assert.equal(task.status, 'running');
    assert.equal(task.runEpoch, 1);
    assert.equal(task.error, undefined);
    assert.equal(task.cleanupError, undefined);
    assert.equal(task.cleanupStatus, 'pending');
    assert.equal(manager.snapshot(task).pendingMessages, 0);
    assert.equal(task.events.filter(e => e.type === 'command_submitted').length, 1);
    assert.ok(task.events.some(e => e.type === 'command_accepted' && e.mode === 'prompt' && e.disposition === 'started'));
    assert.ok(!task.events.some(e => e.type === 'command_failed' || e.type === 'task_failed'));
    const sent = (await readFile(join(a, 'protocol.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(sent.map(c => c.type), ['get_state', 'prompt']);
    assert.equal(sent[1].streamingBehavior, undefined);
    manager.submit('review', taskId, 'followup', 'retry after startup'); await task.tail;
    assert.equal(task.disposition, 'queued');
    assert.equal(manager.snapshot(task).pendingMessages, 1);
    manager.cancel('review', taskId); await task.cancelWork;
    assert.equal(task.status, 'cancelled');
    assert.equal(task.cleanupStatus, 'confirmed');
    assert.equal(task.error, undefined);
    const next = manager.create('review', 'a'); await manager.get('review', next.taskId).ready;
  });
}

test('review P1: detached tool may survive crash; workspace remains quarantined across restart and retention', async t => {
  const { manager, task, taskId, a, config } = await fixture(t, 'detached-crash', { maxProcesses: 1, retentionMs: 100 });
  await until(() => task.processExited);
  assert.equal(task.status, 'cleanup_unconfirmed');
  assert.equal(task.cleanupStatus, 'unconfirmed');
  assert.equal(task.error.code, 'PROCESS_EXIT');
  assert.equal(task.error.action, 'pi');
  assert.equal(manager.result('review', taskId).final, false);
  assert.throws(() => manager.create('review', 'a'), /WORKSPACE_QUARANTINED/);
  await access(task.lease);
  const second = new TaskManager(config); t.after(() => second.close());
  assert.throws(() => second.create('review', 'a'), /WORKSPACE_QUARANTINED/);
  const other = second.create('review', 'b'); await second.get('review', other.taskId).ready;
  // No attempt to kill an unrelated process: this bounded fixture exits after its one write.
  await until(() => task.processExited); await setTimeout(850);
  assert.equal(await readFile(join(a, 'detached-tool-wrote'), 'utf8'), 'orphan write');
  manager.sweep();
  assert.equal(manager.get('review', taskId).status, 'cleanup_unconfirmed');
});

test('review queue count: queued reply does not free capacity; authoritative consumption does', async t => {
  const { manager, task, taskId } = await fixture(t, '', { maxQueuedCommands: 1 });
  manager.submit('review', taskId, 'followup', 'next'); await task.tail;
  assert.equal(task.queued, 0);
  assert.equal(manager.snapshot(task).pendingMessages, 1);
  assert.equal(manager.snapshot(task).queuedMessageBytes, 4);
  for (let i = 0; i < 20; i++) assert.throws(() => manager.submit('review', taskId, 'followup', `queued ${i}`), /COMMAND_LIMIT/);
  assert.equal(task.events.filter(e => e.type === 'command_accepted' && e.mode === 'followup').length, 1);
  await task.rpc.request('test_consume');
  assert.equal(manager.snapshot(task).pendingMessages, 0);
  assert.equal(manager.snapshot(task).queuedMessageBytes, 0);
  manager.submit('review', taskId, 'followup', 'more'); await task.tail;
  assert.equal(manager.snapshot(task).pendingMessages, 1);
});

test('review queue bytes: UTF-8 bytes and in-flight reservations share one bounded budget', async t => {
  const { manager, task, taskId } = await fixture(t, '', { maxQueuedCommands: 8, maxQueuedMessageBytes: 6 });
  manager.submit('review', taskId, 'steer', '你'); await task.tail;
  assert.equal(manager.snapshot(task).queuedMessageBytes, 3);
  assert.throws(() => manager.submit('review', taskId, 'followup', 'hello'), /MESSAGE_BYTES_LIMIT/);
  manager.submit('review', taskId, 'followup', '好');
  assert.throws(() => manager.submit('review', taskId, 'steer', 'x'), /MESSAGE_BYTES_LIMIT/);
  await task.tail;
  assert.equal(manager.snapshot(task).queuedMessageBytes, 6);
  await task.rpc.request('test_consume');
  assert.equal(manager.snapshot(task).queuedMessageBytes, 3);
});

test('review queue without snapshot: hold the accepted slot until a full queue update arrives', async t => {
  const { manager, task, taskId } = await fixture(t, 'no-queue-update', { maxQueuedCommands: 1 });
  manager.submit('review', taskId, 'followup', 'next'); await task.tail;
  assert.equal(manager.snapshot(task).pendingMessages, 1);
  assert.throws(() => manager.submit('review', taskId, 'followup', 'more'), /COMMAND_LIMIT/);
  await task.rpc.request('test_consume');
  assert.equal(manager.snapshot(task).pendingMessages, 0);
});

for (const mode of ['steer', 'followup']) {
  test(`review settled race: ${mode} uses atomic prompt and starts new work rather than stranding input`, async t => {
    const { manager, task, taskId, a } = await fixture(t, 'settle-race');
    manager.submit('review', taskId, mode, 'must execute next');
    assert.equal(manager.result('review', taskId).final, false);
    await task.tail;
    assert.equal(task.disposition, 'started');
    assert.equal(task.status, 'running');
    assert.equal(task.runEpoch, 2);
    assert.equal(manager.result('review', taskId).final, false);
    assert.equal(manager.result('review', taskId).available, false);
    const commands = (await readFile(join(a, 'protocol.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    const latest = commands.at(-1);
    assert.equal(latest.type, 'prompt');
    assert.equal(latest.streamingBehavior, mode === 'steer' ? 'steer' : 'followUp');
    await task.rpc.request('test_settle');
    assert.equal(manager.result('review', taskId).final, true);
  });
}

test('review new-run deadline: old settled cannot remove the next agent_start timer or result reset', async t => {
  const { manager, task, taskId } = await fixture(t, 'prompt-settle-race', { taskTimeoutMs: 140 });
  manager.submit('review', taskId, 'prompt', 'next run'); await task.tail;
  assert.equal(task.runEpoch, 2); assert.equal(task.status, 'running');
  assert.equal(task.result.available, false);
  assert.ok(task.deadline);
  await until(() => task.status === 'timed_out');
  assert.equal(task.error.code, 'TASK_TIMEOUT');
  assert.equal(task.cleanupStatus, 'confirmed');
  assert.equal(task.processExited, true);
});

test('review cancel timeout: preserves failed prompt action and cannot claim cancelled when abort was never sent', async t => {
  const { manager, task, taskId, a } = await fixture(t, 'cancel-timeout');
  manager.cancel('review', taskId); await task.cancelWork;
  assert.equal(task.status, 'cleanup_unconfirmed');
  assert.equal(task.error.code, 'RPC_TIMEOUT');
  assert.equal(task.error.action, 'prompt');
  assert.equal(task.cleanupStatus, 'unconfirmed');
  assert.equal(task.processExited, true);
  assert.equal(manager.result('review', taskId).final, false);
  assert.throws(() => manager.create('review', 'a'), /WORKSPACE_QUARANTINED/);
  const sent = (await readFile(join(a, 'protocol.log'), 'utf8')).trim().split('\n').map(x => JSON.parse(x).type);
  assert.deepEqual(sent, ['get_state', 'prompt']);
  assert.ok(task.events.some(e => e.type === 'command_failed' && e.code === 'RPC_TIMEOUT' && e.action === 'prompt'));
});

test('review cleanup failure: retain the run timeout and report a later abort failure separately', async t => {
  const { manager, task, taskId } = await fixture(t, 'hang_abort', { taskTimeoutMs: 140 });
  await until(() => task.status === 'cleanup_unconfirmed');
  assert.deepEqual(task.error, { code: 'TASK_TIMEOUT', action: 'run' });
  assert.deepEqual(task.cleanupError, { code: 'RPC_TIMEOUT', action: 'abort' });
  assert.equal(task.cleanupStatus, 'unconfirmed');
  assert.equal(task.processExited, true);
  assert.equal(manager.result('review', taskId).final, false);
  assert.throws(() => manager.create('review', 'a'), /WORKSPACE_QUARANTINED/);
});
