import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, parse, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const mcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const sourceFiles = ['plugin.json', 'package.json', 'skills/setup/SKILL.md', 'skills/control-pi/SKILL.md', 'docs/PLUGIN_INSTALL.md'];
export const usage = 'Usage: npm run package:plugin -- --target chatgpt --app-id <raw-id> --out <dir>\n   or: npm run package:plugin -- --target desktop --mcp-url <https-url/mcp> --out <dir> [--allow-loopback-http]';
const fail = code => { const error = new Error(code); error.code = code; throw error; };

export function validateOptions(input) {
  const keys = ['target', 'appId', 'mcpUrl', 'out', 'allowLoopbackHttp'];
  if (!input || Object.keys(input).some(key => !keys.includes(key))) fail('INVALID_OPTIONS');
  if (!['chatgpt', 'desktop'].includes(input.target) || typeof input.out !== 'string' || !input.out.trim() || input.out.includes('\0')) fail('INVALID_OPTIONS');
  if (input.allowLoopbackHttp !== undefined && typeof input.allowLoopbackHttp !== 'boolean') fail('INVALID_OPTIONS');
  if (input.target === 'chatgpt') {
    if (input.mcpUrl !== undefined || input.allowLoopbackHttp !== undefined) fail('MIXED_TARGET_OPTIONS');
    if (typeof input.appId !== 'string' || !/^(?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(input.appId)) fail('INVALID_APP_ID');
  } else {
    if (input.appId !== undefined) fail('MIXED_TARGET_OPTIONS');
    if (typeof input.mcpUrl !== 'string' || input.mcpUrl.length > 2048 || /[\s\\]/.test(input.mcpUrl) || /[?#]/.test(input.mcpUrl)) fail('INVALID_MCP_URL');
    let url;
    try { url = new URL(input.mcpUrl); } catch { fail('INVALID_MCP_URL'); }
    if (url.username || url.password || url.pathname !== '/mcp' || url.search || url.hash) fail('INVALID_MCP_URL');
    if (url.protocol !== 'https:') {
      if (url.protocol !== 'http:' || input.allowLoopbackHttp !== true || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('INVALID_MCP_URL');
      if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/mcp$/.test(input.mcpUrl)) fail('INVALID_MCP_URL');
    }
    // Reject normalization tricks: only an explicit authority followed by literal /mcp is accepted.
    if (!/^https?:\/\/[^/@]+\/mcp$/.test(input.mcpUrl)) fail('INVALID_MCP_URL');
  }
  return { ...input, out: resolve(input.out) };
}

export function parseArgs(args) {
  const names = { '--target': 'target', '--app-id': 'appId', '--mcp-url': 'mcpUrl', '--out': 'out', '--allow-loopback-http': 'allowLoopbackHttp' };
  const input = {};
  for (let i = 0; i < args.length; i++) {
    const key = names[args[i]];
    if (!key || Object.hasOwn(input, key)) fail('INVALID_ARGUMENTS');
    if (key === 'allowLoopbackHttp') input[key] = true;
    else {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
      input[key] = args[++i];
    }
  }
  return validateOptions(input);
}

async function directoryPath(path, create = false) {
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_DIRECTORY');
  }
  return fs.lstat(path);
}

async function readSource(root, name) {
  const path = join(root, name);
  await directoryPath(dirname(path));
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) fail('INVALID_SOURCE_FILE');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

async function destination(out) {
  try {
    const stat = await fs.lstat(out);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_OUTPUT');
    if ((await fs.readdir(out)).length) fail('OUTPUT_NOT_EMPTY');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const json = value => JSON.stringify(value, null, 2) + '\n';

// sourceRoot is an internal fixture seam; the CLI always reads this repository's fixed whitelist.
export async function buildPlugin(input, sourceRoot = projectRoot) {
  const options = validateOptions(input);
  const sources = new Map();
  for (const name of sourceFiles) sources.set(name, await readSource(resolve(sourceRoot), name));
  const manifest = JSON.parse(sources.get('plugin.json'));
  const pkg = JSON.parse(sources.get('package.json'));
  const extension = manifest.extensions?.['com.openai'];
  if (manifest.$schema !== pluginSchema || manifest.name !== 'pipro' || manifest.version !== pkg.version
    || Object.keys(manifest).some(key => !['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'].includes(key))
    || manifest.repository !== 'https://github.com/zhengui666/pipro'
    || extension?.onboardingSkill !== './skills/setup/SKILL.md'
    || Object.keys(extension).some(key => !['onboardingSkill', 'interface'].includes(key))
    || JSON.stringify(extension.interface?.capabilities) !== JSON.stringify(['Read', 'Write'])) fail('INVALID_TEMPLATE');
  if (options.target === 'chatgpt') extension.apps = './.app.json';
  const marketplace = { name: 'pipro-local', interface: { displayName: 'pipro local' }, plugins: [{ name: 'pipro',
    source: { source: 'local', path: './plugins/pipro' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] };
  const files = new Map([
    ['.gitignore', '*\n'],
    ['.agents/plugins/marketplace.json', json(marketplace)],
    ['plugins/pipro/plugin.json', json(manifest)],
    ['plugins/pipro/skills/setup/SKILL.md', sources.get('skills/setup/SKILL.md')],
    ['plugins/pipro/skills/control-pi/SKILL.md', sources.get('skills/control-pi/SKILL.md')],
    ['INSTALL.md', `# pipro ${options.target} 安装包\n\n本目录包含用户指定的连接绑定，默认由 .gitignore 整包忽略；不要提交到 pipro 源仓库。\n\n${sources.get('docs/PLUGIN_INSTALL.md')}`],
    [options.target === 'chatgpt' ? 'plugins/pipro/.app.json' : 'plugins/pipro/mcp.json', options.target === 'chatgpt'
      ? json({ apps: { pipro: { id: options.appId, required: true } } })
      : json({ $schema: mcpSchema, mcpServers: { pipro: { type: 'streamable-http', url: options.mcpUrl } } })]
  ]);
  // All CLI inputs and source reads finish before creating any output directories.
  const parent = dirname(options.out);
  const parentStat = await directoryPath(parent, true);
  await destination(options.out);
  const stage = await fs.mkdtemp(join(parent, '.pipro-build-'));
  const stageStat = await fs.lstat(stage);
  let committed = false;
  try {
    for (const [name, content] of files) {
      await fs.mkdir(dirname(join(stage, name)), { recursive: true, mode: 0o700 });
      await fs.writeFile(join(stage, name), content, { flag: 'wx', mode: 0o600 });
    }
    const currentParent = await directoryPath(parent);
    if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino) fail('OUTPUT_PARENT_CHANGED');
    await destination(options.out);
    // rename is the only publication step; a concurrently populated destination causes failure.
    await fs.rename(stage, options.out);
    committed = true;
    return { target: options.target, files: [...files.keys()] };
  } finally {
    if (!committed) {
      const current = await fs.lstat(stage).catch(() => null);
      if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === stageStat.dev && current.ino === stageStat.ino) await fs.rm(stage, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage);
    else {
      const result = await buildPlugin(parseArgs(process.argv.slice(2)));
      console.log(`pipro ${result.target} plugin package generated (${result.files.length} files). Review INSTALL.md before importing.`);
    }
  } catch (error) {
    console.error(`pipro package failed: ${error.code || 'INVALID_SOURCE'}\n${usage}`);
    process.exitCode = 1;
  }
}
