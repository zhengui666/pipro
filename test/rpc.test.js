import test from 'node:test';
import assert from 'node:assert/strict';
import { PiRpc } from '../src/rpc.js';
import { setup, fake } from './helpers.js';

async function rpcFixture(t, options = {}) {
  const { a } = await setup(t);
  const rpc = new PiRpc({ executable: process.execPath, args: [fake], cwd: a,
    env: { PATH: process.env.PATH }, timeoutMs: 500, ...options });
  t.after(() => rpc.close());
  return rpc;
}

test('LF framing keeps fragmented UTF-8 / Unicode separators / CRLF intact', async t => {
  const rpc = await rpcFixture(t);
  assert.equal(await rpc.request('unicode'), '你\u2028我\u2029😀');
});
test('multiple in-flight requests correlate by id despite reverse replies', async t => {
  const rpc = await rpcFixture(t);
  const first = rpc.request('first');
  const second = rpc.request('second');
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(rpc.pending.size, 0);
});
test('command success=false rejects that request without exposing raw error', async t => {
  const rpc = await rpcFixture(t);
  await assert.rejects(rpc.request('reject'), e => e.code === 'COMMAND_REJECTED' && !e.message.includes('should-not-leak'));
  assert.equal(rpc.closed, false);
  assert.equal((await rpc.request('get_state')).isStreaming, false);
});
for (const [command, code] of [['mismatch', 'INVALID_RESPONSE'], ['malformed', 'INVALID_JSONL'],
  ['oversize', 'RECORD_TOO_LARGE'], ['partialexit', 'TRUNCATED_RECORD'], ['exit', 'PROCESS_EXIT'],
  ['nonid', 'UNCORRELATED_RESPONSE'], ['hang', 'RPC_TIMEOUT'], ['orphanexit', 'PROCESS_EXIT']]) {
  test(`${command}: rejects every pending request and shuts down`, async t => {
    const rpc = await rpcFixture(t, { maxRecordBytes: 1024, timeoutMs: 200 });
    const pending = rpc.request('first');
    const failing = rpc.request(command);
    const results = await Promise.allSettled([pending, failing]);
    assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === code));
    await rpc.close();
    assert.equal(rpc.pending.size, 0);
    assert.equal(rpc.closed, true);
  });
}
test('missing executable is a bounded startup error', async t => {
  const { a } = await setup(t);
  const rpc = new PiRpc({ executable: '/no/such/pipro-pi', args: [], cwd: a, env: {}, timeoutMs: 200 });
  await assert.rejects(rpc.request('get_state'), e => e.code === 'SPAWN_FAILED');
  await rpc.close();
});
