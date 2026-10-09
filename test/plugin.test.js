import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPlugin, parseArgs, validateOptions } from '../scripts/build-plugin.mjs';

const sourceRoot = resolve('.');
const sources = ['plugin.json', 'package.json', 'skills/setup/SKILL.md', 'skills/control-pi/SKILL.md', 'docs/PLUGIN_INSTALL.md'];
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'pipro-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function sourceFixture(root) {
  const source = join(root, 'source');
  for (const file of sources) {
    await fs.mkdir(dirname(join(source, file)), { recursive: true });
    await fs.copyFile(join(sourceRoot, file), join(source, file));
  }
  return source;
}
async function contents(root, prefix = '') {
  const files = {};
  for (const entry of await fs.readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await contents(root, path));
    else files[path] = await fs.readFile(join(root, path), 'utf8');
  }
  return files;
}
const readJson = async path => JSON.parse(await fs.readFile(path, 'utf8'));

test('portable root template uses canonical fields and matches package version', async () => {
  const manifest = await readJson('plugin.json'); const pkg = await readJson('package.json');
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.version, pkg.version); assert.equal(manifest.name, 'pipro');
  assert.equal(manifest.repository, 'https://github.com/zhengui666/pipro');
  assert.equal(manifest.extensions['com.openai'].onboardingSkill, './skills/setup/SKILL.md');
  assert.deepEqual(manifest.extensions['com.openai'].interface.capabilities, ['Read', 'Write']);
  assert.equal(manifest.extensions['com.openai'].apps, undefined);
  assert.equal(manifest.skills, undefined); // portable uses the fixed skills/ directory, no legacy root field.
});

for (const target of ['chatgpt', 'desktop']) {
  test(`${target} package: exact whitelist, reachable references, exclusive connection and deterministic bytes`, async t => {
    const root = await fixture(t); const source = await sourceFixture(root);
    await fs.mkdir(join(source, 'node_modules'));
    await fs.writeFile(join(source, 'node_modules', 'secret'), 'must-not-be-copied');
    await fs.writeFile(join(source, 'config.json'), 'must-not-be-copied');
    await fs.writeFile(join(source, '.app.json'), 'must-not-be-copied');
    await fs.writeFile(join(source, 'mcp.json'), 'must-not-be-copied');
    const binding = target === 'chatgpt' ? { appId: 'asdk_app_fixture' } : { mcpUrl: 'https://pipro.example.test/mcp' };
    const first = join(root, 'out'); const second = join(root, 'nested', 'out');
    await buildPlugin({ target, out: first, ...binding }, source);
    await buildPlugin({ target, out: second, ...binding }, source);
    const files = await contents(first); assert.deepEqual(files, await contents(second));
    const configName = target === 'chatgpt' ? '.app.json' : 'mcp.json';
    assert.deepEqual(Object.keys(files).sort(), ['.gitignore', '.agents/plugins/marketplace.json', 'INSTALL.md',
      'plugins/pipro/plugin.json', `plugins/pipro/${configName}`, 'plugins/pipro/skills/setup/SKILL.md', 'plugins/pipro/skills/control-pi/SKILL.md'].sort());
    assert.ok(!JSON.stringify(files).includes('must-not-be-copied'));
    const catalog = JSON.parse(files['.agents/plugins/marketplace.json']);
    assert.equal(catalog.name, 'pipro-local');
    assert.deepEqual(catalog.plugins[0].source, { source: 'local', path: './plugins/pipro' });
    assert.deepEqual(catalog.plugins[0].policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
    const plugin = join(first, catalog.plugins[0].source.path);
    const manifest = await readJson(join(plugin, 'plugin.json'));
    await fs.access(join(plugin, manifest.extensions['com.openai'].onboardingSkill));
    for (const name of ['setup', 'control-pi']) assert.equal(await fs.readFile(join(plugin, 'skills', name, 'SKILL.md'), 'utf8'), await fs.readFile(join(source, 'skills', name, 'SKILL.md'), 'utf8'));
    if (target === 'chatgpt') {
      assert.deepEqual(await readJson(join(plugin, manifest.extensions['com.openai'].apps)), { apps: { pipro: { id: binding.appId, required: true } } });
      assert.equal(files['plugins/pipro/mcp.json'], undefined);
    } else {
      assert.equal(manifest.extensions['com.openai'].apps, undefined);
      assert.deepEqual(await readJson(join(plugin, 'mcp.json')), { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { pipro: { type: 'streamable-http', url: binding.mcpUrl } } });
      assert.equal(files['plugins/pipro/.app.json'], undefined);
    }
  });
}

test('CLI validation rejects missing, duplicate, positional, unknown and mixed target arguments', () => {
  const valid = ['--target', 'chatgpt', '--app-id', 'connector_fixture', '--out', '/tmp/not-generated'];
  assert.equal(parseArgs(valid).appId, 'connector_fixture');
  for (const args of [[], ['--target'], ['desktop'], [...valid, '--out', '/tmp/x'], [...valid, '--bogus'],
    [...valid, '--mcp-url', 'https://example.test/mcp'], [...valid, '--allow-loopback-http'],
    ['--target', 'desktop', '--mcp-url', 'https://example.test/mcp', '--app-id', 'asdk_app_fixture', '--out', '/tmp/x'],
    ['--target', 'other', '--out', '/tmp/x'], ['--out', '--target', 'chatgpt']]) assert.throws(() => parseArgs(args));
  assert.throws(() => validateOptions({ target: 'chatgpt', appId: 'connector_fixture', out: '/tmp/x', token: 'secret' }));
});

test('raw app IDs accept documented namespaces and reject plugin page IDs, URLs and injected values', () => {
  for (const id of ['asdk_app_fixture', 'connector_fixture', 'templated_apps_fixture']) assert.equal(validateOptions({ target: 'chatgpt', appId: id, out: '/tmp/x' }).appId, id);
  for (const id of ['', 'plugin_asdk_app_fixture', 'plugin_fixture', 'asdk_app_', 'asdk_app_../config', 'asdk_app_x\nsecret', 'https://example.test', 'unknown_fixture', 'asdk_app_' + 'a'.repeat(201)]) assert.throws(() => validateOptions({ target: 'chatgpt', appId: id, out: '/tmp/x' }), /INVALID_APP_ID/);
});

test('HTTPS URL validation forbids credentials, query, fragment, wrong path and normalization tricks', () => {
  const valid = { target: 'desktop', out: '/tmp/x' };
  assert.equal(validateOptions({ ...valid, mcpUrl: 'https://example.test:8443/mcp' }).mcpUrl, 'https://example.test:8443/mcp');
  for (const mcpUrl of ['https://user:secret@example.test/mcp', 'https://@example.test/mcp', 'https://example.test/mcp?',
    'https://example.test/mcp#', 'https://example.test/mcp?q=1', 'https://example.test/mcp#x', 'https://example.test/other',
    'https://example.test/mcp/', 'https://example.test/a/../mcp', 'https://example.test/%6dcp', 'https://example.test\\other/mcp',
    'https://example.test/mcp\n', 'file:///mcp', 'http://127.0.0.1/mcp', 'https:///mcp', 'https://example.test:70000/mcp']) assert.throws(() => validateOptions({ ...valid, mcpUrl }), /INVALID_MCP_URL/);
});

test('HTTP is explicit loopback development only, including IPv6; aliases and public hosts are rejected', async t => {
  const root = await fixture(t);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const mcpUrl = `http://${host}:8787/mcp`;
    assert.throws(() => validateOptions({ target: 'desktop', mcpUrl, out: root }), /INVALID_MCP_URL/);
    assert.equal(validateOptions({ target: 'desktop', mcpUrl, out: root, allowLoopbackHttp: true }).mcpUrl, mcpUrl);
  }
  for (const host of ['0.0.0.0', 'example.test', '127.0.0.2', '127.1', '2130706433', '0x7f000001', 'localhost.example', '[::]']) assert.throws(() => validateOptions({ target: 'desktop', mcpUrl: `http://${host}/mcp`, out: root, allowLoopbackHttp: true }), /INVALID_MCP_URL/);
  const out = join(root, 'out');
  await buildPlugin({ target: 'desktop', mcpUrl: 'http://[::1]:8787/mcp', out, allowLoopbackHttp: true });
  assert.equal((await readJson(join(out, 'plugins/pipro/mcp.json'))).mcpServers.pipro.url, 'http://[::1]:8787/mcp');
  assert.match(await fs.readFile(join(out, 'INSTALL.md'), 'utf8'), /同一机器/);
});

test('existing nonempty output is preserved; empty output can be atomically replaced', async t => {
  const root = await fixture(t); const out = join(root, 'out'); await fs.mkdir(out);
  await fs.writeFile(join(out, 'user-file'), 'keep');
  const input = { target: 'chatgpt', appId: 'asdk_app_fixture', out };
  await assert.rejects(buildPlugin(input), /OUTPUT_NOT_EMPTY/);
  assert.deepEqual(await fs.readdir(out), ['user-file']); assert.equal(await fs.readFile(join(out, 'user-file'), 'utf8'), 'keep');
  const empty = join(root, 'empty'); await fs.mkdir(empty);
  await buildPlugin({ ...input, out: empty }); await fs.access(join(empty, 'plugins/pipro/.app.json'));
});

test('output symlink and symlink ancestors are refused without touching the target', async t => {
  const root = await fixture(t); const real = join(root, 'real'); await fs.mkdir(real);
  const link = join(root, 'link'); await fs.symlink(real, link);
  for (const out of [link, join(link, 'nested', 'out')]) await assert.rejects(buildPlugin({ target: 'chatgpt', appId: 'asdk_app_fixture', out }));
  assert.deepEqual(await fs.readdir(real), []);
});

for (const path of ['plugin.json', 'skills/setup']) {
  test(`whitelisted source symlink ${path} is refused before output writes`, async t => {
    const root = await fixture(t); const source = await sourceFixture(root);
    const original = join(source, path); const outside = join(root, 'outside'); await fs.rename(original, outside); await fs.symlink(outside, original);
    const out = join(root, 'new-parent', 'out');
    await assert.rejects(buildPlugin({ target: 'chatgpt', appId: 'asdk_app_fixture', out }, source));
    await assert.rejects(fs.access(join(root, 'new-parent')));
    await fs.access(outside);
  });
}

test('invalid inputs and incomplete/mismatched source templates produce no partial output', async t => {
  const root = await fixture(t); const source = await sourceFixture(root); const out = join(root, 'new-parent', 'out');
  await assert.rejects(buildPlugin({ target: 'chatgpt', appId: 'plugin_bad', out }, source), /INVALID_APP_ID/);
  const manifest = await readJson(join(source, 'plugin.json')); manifest.version = '999.0.0';
  await fs.writeFile(join(source, 'plugin.json'), JSON.stringify(manifest));
  await assert.rejects(buildPlugin({ target: 'chatgpt', appId: 'asdk_app_fixture', out }, source), /INVALID_TEMPLATE/);
  await fs.rm(join(source, 'docs/PLUGIN_INSTALL.md'));
  await assert.rejects(buildPlugin({ target: 'chatgpt', appId: 'asdk_app_fixture', out }, source));
  await assert.rejects(fs.access(join(root, 'new-parent')));
});

for (const method of ['writeFile', 'rename']) {
  test(`assembly ${method} failure cleans owned staging and preserves existing empty destination`, async t => {
    const root = await fixture(t); const out = join(root, 'out'); await fs.mkdir(out);
    const original = fs[method];
    t.mock.method(fs, method, async () => { const error = new Error('fixture IO failure'); error.code = 'EIO'; throw error; });
    await assert.rejects(buildPlugin({ target: 'chatgpt', appId: 'asdk_app_fixture', out }), { code: 'EIO' });
    t.mock.restoreAll(); assert.equal(fs[method], original);
    assert.deepEqual(await fs.readdir(out), []);
    assert.deepEqual(await fs.readdir(root), ['out']);
  });
}

test('a concurrently populated destination is never overwritten and leaves no staging', async t => {
  const root = await fixture(t); const out = join(root, 'out'); await fs.mkdir(out);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => { await fs.writeFile(join(to, 'user-file'), 'keep'); return rename(from, to); });
  await assert.rejects(buildPlugin({ target: 'chatgpt', appId: 'asdk_app_fixture', out }));
  t.mock.restoreAll(); assert.equal(await fs.readFile(join(out, 'user-file'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(root), ['out']);
});

test('generated binding files are ignored by ordinary git even under a custom output name', async t => {
  const root = await fixture(t); const out = join(root, 'custom-name');
  execFileSync('git', ['init', '-q', root]);
  await buildPlugin({ target: 'chatgpt', appId: 'asdk_app_fixture', out });
  const ignored = execFileSync('git', ['check-ignore', 'custom-name/plugins/pipro/.app.json', 'custom-name/.agents/plugins/marketplace.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(ignored.trim().split('\n').length, 2);
});

test('actual CLI generates offline package and reports invalid arguments without echoing secret values', async t => {
  const root = await fixture(t); const script = resolve('scripts/build-plugin.mjs'); const out = join(root, 'out');
  const log = execFileSync(process.execPath, [script, '--target', 'chatgpt', '--app-id', 'asdk_app_fixture', '--out', out], { encoding: 'utf8' });
  assert.match(log, /package generated/); await fs.access(join(out, 'plugins/pipro/.app.json'));
  try {
    execFileSync(process.execPath, [script, '--target', 'desktop', '--mcp-url', 'https://user:do-not-echo@example.test/mcp', '--out', join(root, 'failed')], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('invalid credentials URL must fail');
  } catch (error) {
    assert.equal(error.status, 1); assert.match(error.stderr, /INVALID_MCP_URL/); assert.ok(!error.stderr.includes('do-not-echo'));
  }
  await assert.rejects(fs.access(join(root, 'failed')));
});
