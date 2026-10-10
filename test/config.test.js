import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { validateConfig, piEnvironment } from '../src/config.js';
import { setup } from './helpers.js';
import { accessConfig } from './cloudflare-fixture.js';

test('only named, nonoverlapping real workspaces; no arbitrary config/host/args', async t => {
  const { config, root, a } = await setup(t);
  for (const patch of [{ host: '0.0.0.0' }, { piArgs: ['-e', 'unknown'] }, { piExecutable: 'pi' },
    { provider: '--no-extensions' }, { model: '-e' },
    { workspaces: { a: '/missing/pipro-workspace' } }]) {
    await assert.rejects(validateConfig({ ...config, ...patch }));
  }
  const alias = join(root, 'alias'); await symlink(a, alias);
  await assert.rejects(validateConfig({ ...config, workspaces: { a, alias } }), /same real path/);
  await assert.rejects(validateConfig({ ...config, workspaces: { a, root } }), /overlap/);
  assert.throws(() => piEnvironment({ ...config, passEnv: ['NODE_OPTIONS'] }), /reserved/);
  assert.throws(() => piEnvironment({ ...config, passEnv: ['PI_CODING_AGENT_DIR'] }), /reserved/);
});

test('Cloudflare Access requires a team origin, canonical resource, application AUD and one confirmed email', async t => {
  const { config } = await setup(t, { auth: accessConfig });
  assert.deepEqual(config.auth, accessConfig);
  const bad = [
    { issuer: accessConfig.issuer + '/' }, { issuer: accessConfig.issuer + '/path' },
    { issuer: accessConfig.issuer + ':443' }, { issuer: 'https://other.integration.dev' },
    { issuer: 'http://pipro-unit.cloudflareaccess.com' }, { issuer: 'https://your-team.cloudflareaccess.com' },
    { issuer: 'https://yourteam.cloudflareaccess.com' },
    { issuer: 'https://user:pass@pipro-unit.cloudflareaccess.com' },
    { resource: accessConfig.resource + '?token=x' }, { resource: accessConfig.resource + '#fragment' },
    { resource: 'https://pipro.integration.dev/foo/../mcp' }, { resource: 'https://pipro.integration.dev/mcp/' },
    { resource: 'https://pipro.example.com/mcp' }, { resource: 'https://pipro.invalid/mcp' },
    { audience: accessConfig.resource }, { audience: 'REPLACE_WITH_REAL_ACCESS_AUD' },
    { audience: '0'.repeat(64) }, { audience: 'a'.repeat(63) }, { audience: 'A'.repeat(64) },
    { audience: accessConfig.audience + '\n' },
    { allowedEmail: ['owner@integration.dev'] }, { allowedEmail: 'owner@example.com' }, { allowedEmail: '' },
    { allowedEmail: 'owner@EXAMPLE.COM' },
    { scope: 'pi:control' }, { jwksFile: '/tmp/keys.json' }, { jwksUrl: 'https://other.integration.dev/keys' },
    { allowedSubjects: ['user-one'] }, { unknownField: true }
  ];
  for (const patch of bad) await assert.rejects(validateConfig({ ...config, auth: { ...accessConfig, ...patch } }));
});
