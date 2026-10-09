import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { validateConfig, piEnvironment } from '../src/config.js';
import { setup } from './helpers.js';

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
