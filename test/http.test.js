import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer } from '../src/server.js';
import { setup, until } from './helpers.js';

async function connect(t, service, token) {
  const client = new Client({ name: 'pipro-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(service.url), token
    ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  let data;
  try { data = JSON.parse(result.content[0].text); } catch { data = null; }
  return { result, data };
}

test('official MCP client: initialize, list tools, async create/read/send/abort over HTTP', async t => {
  const { config } = await setup(t);
  const service = await startServer(config); t.after(() => service.close());
  const client = await connect(t, service);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);
  for (const tool of tools) {
    assert.ok(tool.outputSchema);
    assert.deepEqual(tool._meta.securitySchemes, [{ type: 'noauth' }]);
  }
  for (const name of ['create_task', 'send_message', 'abort_task']) {
    assert.equal(tools.find(x => x.name === name).annotations.readOnlyHint, false);
    assert.equal(tools.find(x => x.name === name).annotations.destructiveHint, true);
  }
  for (const tool of tools.filter(x => !['create_task', 'send_message', 'abort_task'].includes(x.name))) {
    assert.equal(tool.annotations.readOnlyHint, true);
  }
  assert.deepEqual((await call(client, 'list_workspaces')).data.workspaces, ['a', 'b']);
  const bad = await call(client, 'create_task', { workspace: 'a', cwd: '/tmp', executable: '/bin/sh' });
  assert.equal(bad.result.isError, true);
  assert.equal(service.manager.tasks.size, 0);
  const start = Date.now();
  const { taskId } = (await call(client, 'create_task', { workspace: 'a', prompt: 'wait' })).data;
  assert.ok(Date.now() - start < 1000);
  const task = [...service.manager.tasks.values()][0];
  await until(() => task.events.some(x => x.type === 'command_accepted'));
  assert.equal((await call(client, 'get_status', { taskId })).data.status, 'running');
  const receipt = (await call(client, 'send_message', { taskId, mode: 'steer', message: 'change' })).data;
  assert.equal(receipt.acceptedByService, true); await task.tail;
  assert.ok((await call(client, 'get_events', { taskId })).data.events.length > 0);
  assert.equal((await call(client, 'get_result', { taskId })).data.final, false);
  await call(client, 'abort_task', { taskId }); await task.cancelWork;
  assert.equal((await call(client, 'get_status', { taskId })).data.status, 'cancelled');
});

test('HTTP rejects rebinding Host, cross Origin, bad content-type, unknown route and GET', async t => {
  const { config } = await setup(t);
  const service = await startServer(config); t.after(() => service.close());
  const rebinding = await new Promise((resolve, reject) => {
    const req = request(service.url, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rebinding, 403);
  assert.equal((await fetch(service.url, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(service.url)).status, 405);
  assert.equal((await fetch(service.url + '/bad')).status, 404);
  assert.equal((await fetch(service.url, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(service.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(service.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(132000) })).status, 400);
});

test('OAuth JWT resource binding, scope, issuer, expiry, subject, signature and task ownership', async t => {
  const { config, root } = await setup(t);
  // Ephemeral test key exists only in memory; only public JWKS is written to the test temp directory.
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test';
  const jwksFile = join(root, 'jwks.json'); await writeFile(jwksFile, JSON.stringify({ keys: [jwk] }));
  const issuer = 'https://idp.example.test/'; const resource = 'https://pipro.example.test/mcp';
  config.auth = { mode: 'oauth', issuer, resource, jwksFile, allowedSubjects: ['alice', 'bob'], scope: 'pi:control' };
  const service = await startServer(config); t.after(() => service.close());
  async function token(changes = {}, key = privateKey) {
    return new SignJWT({ scope: 'pi:control', ...changes }).setProtectedHeader({ alg: 'ES256', kid: 'test' })
      .setIssuer(changes.iss || issuer).setAudience(changes.aud || resource).setSubject(changes.sub || 'alice')
      .setIssuedAt().setExpirationTime(changes.exp || '5m').sign(key);
  }
  const unauth = await fetch(service.url); assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  const metadata = await (await fetch(new URL('/.well-known/oauth-protected-resource/mcp', service.url))).json();
  assert.deepEqual(metadata.authorization_servers, [issuer]); assert.equal(metadata.resource, resource);
  for (const change of [{ aud: 'https://other.test/mcp' }, { iss: 'https://other.test/' },
    { sub: 'mallory' }, { exp: Math.floor(Date.now() / 1000) - 100 }]) {
    const res = await fetch(service.url, { headers: { Authorization: `Bearer ${await token(change)}` } });
    assert.equal(res.status, 401);
  }
  for (const scope of ['unrelated', '']) {
    const res = await fetch(service.url, { headers: { Authorization: `Bearer ${await token({ scope })}` } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'insufficient_scope');
    assert.match(res.headers.get('www-authenticate'), /error="insufficient_scope"/);
  }
  const other = await generateKeyPair('ES256');
  assert.equal((await fetch(service.url, { headers: { Authorization: `Bearer ${await token({}, other.privateKey)}` } })).status, 401);
  const alice = await connect(t, service, await token());
  const listReply = await (await fetch(service.url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${await token()}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }) })).json();
  for (const tool of listReply.result.tools) assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['pi:control'] }]);
  const bob = await connect(t, service, await token({ sub: 'bob' }));
  const { taskId } = (await call(alice, 'create_task', { workspace: 'a' })).data;
  assert.deepEqual((await call(bob, 'list_tasks')).data.tasks, []);
  for (const tool of ['get_status', 'get_events', 'get_result', 'abort_task']) {
    const denied = await call(bob, tool, { taskId });
    assert.equal(denied.result.isError, true); assert.equal(denied.data.error, 'TASK_NOT_FOUND');
  }
  const renewed = await connect(t, service, await token());
  assert.equal((await call(renewed, 'get_status', { taskId })).data.taskId, taskId);
});
