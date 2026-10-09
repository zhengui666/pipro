import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { validateConfig } from '../src/config.js';

export const fake = resolve('test/fake-pi.js');
export async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pipro-test-'));
  const a = join(root, 'a'); const b = join(root, 'b'); const home = join(root, 'home');
  await Promise.all([mkdir(a), mkdir(b), mkdir(home)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await validateConfig({ piExecutable: fake, piHome: home, host: '127.0.0.1', port: 0,
    workspaces: { a, b }, ...overrides });
  return { root, a, b, home, config };
}

export async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await setTimeout(10);
  }
  throw new Error('condition did not settle before test deadline');
}
