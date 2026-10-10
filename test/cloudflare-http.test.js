import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startServer } from '../src/server.js';
import { setup, until } from './helpers.js';
import { accessConfig, accessFixture } from './cloudflare-fixture.js';

function httpCall(service, { token, method = 'POST', path = '/mcp', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, service.url), { method,
      headers: { Host: new URL(accessConfig.resource).host, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
const tool = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const data = response => JSON.parse(response.body.result.content[0].text);

test('Access HTTP fails closed without an assertion, advertises empty OAuth scopes and preserves Host/Origin checks', async t => {
  const { sign, fetches } = await accessFixture(t);
  const { config } = await setup(t, { auth: accessConfig });
  const service = await startServer(config); t.after(() => service.close());
  const token = await sign();
  for (const headers of [{}, { Authorization: 'Bearer opaque-token' },
    { Authorization: 'Bearer ' + token, Cookie: 'CF_Authorization=' + token,
      'Cf-Access-Authenticated-User-Email': accessConfig.allowedEmail }]) {
    const denied = await httpCall(service, { headers, body: rpc('tools/list') });
    assert.equal(denied.status, 401); assert.equal(denied.headers['www-authenticate'], undefined);
  }
  assert.equal(fetches.length, 0);
  const duplicate = await httpCall(service, { headers: { 'Cf-Access-Jwt-Assertion': [token, token] }, body: rpc('tools/list') });
  assert.equal(duplicate.status, 401);
  const listed = await httpCall(service, { token, headers: { Authorization: 'Bearer opaque-token', Origin: new URL(accessConfig.resource).origin }, body: rpc('tools/list') });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.result.tools.length, 8);
  for (const entry of listed.body.result.tools) {
    assert.deepEqual(entry.securitySchemes, [{ type: 'oauth2', scopes: [] }]);
    assert.deepEqual(entry._meta.securitySchemes, entry.securitySchemes);
    assert.equal(entry.annotations.readOnlyHint, !['create_task', 'send_message', 'abort_task'].includes(entry.name));
  }
  assert.equal((await httpCall(service, { token, headers: { Host: 'attacker.integration.dev' } })).status, 403);
  assert.equal((await httpCall(service, { token, headers: { Origin: 'https://attacker.integration.dev' } })).status, 403);
  assert.equal((await httpCall(service, { token, headers: { Origin: new URL(service.url).origin } })).status, 403);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    assert.equal((await httpCall(service, { method: 'GET', path })).status, 404);
  }
  const forbidden = await httpCall(service, { token: await sign({ email: 'other@integration.dev' }), body: rpc('tools/list') });
  assert.equal(forbidden.status, 403); assert.deepEqual(forbidden.body, { error: 'forbidden' });
  assert.equal(forbidden.headers['www-authenticate'], undefined);
  assert.equal((await httpCall(service, { token: 'a.b.c', body: rpc('tools/list') })).status, 401);
  assert.equal(fetches.length, 1);
});

test('Access HTTP token renewal keeps task ownership while a different verified sub cannot inspect or cancel tasks', async t => {
  const { sign, fetches } = await accessFixture(t);
  const { config } = await setup(t, { auth: accessConfig });
  const service = await startServer(config); t.after(() => service.close());
  const alice = await sign();
  const created = data(await httpCall(service, { token: alice, body: tool('create_task', { workspace: 'a' }) }));
  const task = [...service.manager.tasks.values()][0]; await until(() => task.status === 'idle');
  const renewed = await sign({ identity_nonce: 'renewed' });
  assert.equal(data(await httpCall(service, { token: renewed, body: tool('get_status', { taskId: created.taskId }) })).taskId, created.taskId);
  const bob = await sign({ sub: 'user-two' });
  assert.deepEqual(data(await httpCall(service, { token: bob, body: tool('list_tasks') })).tasks, []);
  for (const name of ['get_status', 'get_events', 'get_result', 'abort_task']) {
    const denied = await httpCall(service, { token: bob, body: tool(name, { taskId: created.taskId }) });
    assert.equal(denied.body.result.isError, true);
    assert.equal(data(denied).error, 'TASK_NOT_FOUND');
  }
  await httpCall(service, { token: renewed, body: tool('abort_task', { taskId: created.taskId }) });
  await task.cancelWork;
  assert.equal(task.status, 'cancelled'); assert.equal(task.cleanupStatus, 'confirmed');
  assert.equal(fetches.length, 1);
});
