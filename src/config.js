import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const absolute = z.string().refine(isAbsolute, 'must be an absolute path');
const https = z.string().url().refine(v => {
  const u = new URL(v);
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
}, 'HTTPS URL without userinfo/query/fragment required');
const placeholderHost = host => /(?:^|\.)(?:example\.(?:com|org|net)|invalid|example|test)$/.test(host?.toLowerCase());
const accessIssuer = https.refine(v => {
  const u = new URL(v);
  const team = u.hostname.split('.')[0];
  return v === u.origin && !u.port
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(u.hostname)
    && !['yourteam', 'your-team', 'example', 'replace-me'].includes(team);
}, 'Cloudflare team HTTPS origin required, without path or placeholder');
const accessResource = https.refine(v => {
  const u = new URL(v);
  return v === u.href && u.pathname === '/mcp' && !placeholderHost(u.hostname);
}, 'Canonical HTTPS /mcp resource without placeholder required');
const limits = z.object({
  maxProcesses: z.number().int().min(1).max(16).default(2),
  maxTasks: z.number().int().min(1).max(1000).default(100),
  rpcTimeoutMs: z.number().int().min(100).max(30000).default(5000),
  taskTimeoutMs: z.number().int().min(100).max(86400000).default(3600000),
  idleTimeoutMs: z.number().int().min(100).max(86400000).default(900000),
  retentionMs: z.number().int().min(100).max(86400000).default(3600000),
  maxRecordBytes: z.number().int().min(1024).max(8388608).default(1048576),
  maxEvents: z.number().int().min(1).max(2000).default(300),
  maxTextChars: z.number().int().min(64).max(32768).default(12000),
  maxPromptChars: z.number().int().min(1).max(32768).default(16000),
  maxQueuedCommands: z.number().int().min(1).max(32).default(8),
  maxQueuedMessageBytes: z.number().int().min(1).max(1048576).default(131072),
  maxHttpRequests: z.number().int().min(1).max(128).default(32)
}).strict();
const schema = z.object({
  host: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8787),
  piExecutable: absolute,
  provider: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/).optional(),
  model: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.:/-]{0,199}$/).optional(),
  workspaces: z.record(name, absolute).refine(v => Object.keys(v).length > 0, 'workspace required'),
  piHome: absolute,
  passEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(32).default([]),
  outputMode: z.enum(['metadata', 'redacted_text']).default('metadata'),
  limits: limits.default(() => limits.parse({})),
  auth: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('none') }).strict(),
    z.object({
      mode: z.literal('oauth'), issuer: https, resource: https,
      jwksFile: absolute, allowedSubjects: z.array(z.string().min(1).max(200)).min(1).max(100),
      scope: z.literal('pi:control').default('pi:control')
    }).strict(),
    z.object({
      mode: z.literal('cloudflare-access'), issuer: accessIssuer, resource: accessResource,
      audience: z.string().length(64).regex(/^[a-f0-9]{64}$/, 'Access application AUD must be 64 lowercase hex characters')
        .refine(v => !/^([a-f0-9])\1{63}$/.test(v), 'Access AUD placeholder is not allowed'),
      allowedEmail: z.string().email().max(254).refine(v => !placeholderHost(v.split('@')[1]), 'Confirmed email required')
    }).strict()
  ]).default({ mode: 'none' })
}).strict();

export async function validateConfig(input) {
  const config = schema.parse(input);
  if (config.limits.maxTasks < config.limits.maxProcesses) throw new Error('maxTasks must be >= maxProcesses');
  for (const [workspace, path] of Object.entries(config.workspaces)) {
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isDirectory()) throw new Error(`workspace ${workspace} is not a directory`);
    config.workspaces[workspace] = resolved;
  }
  const paths = Object.values(config.workspaces);
  if (new Set(paths).size !== paths.length) throw new Error('workspace aliases must not share the same real path');
  for (const a of paths) for (const b of paths) {
    if (a !== b && b.startsWith(a.endsWith('/') ? a : a + '/')) throw new Error('workspace paths must not overlap');
  }
  config.piHome = await realpath(config.piHome);
  if (!(await stat(config.piHome)).isDirectory()) throw new Error('piHome must be a directory');
  if (config.auth.mode === 'oauth' && new URL(config.auth.resource).pathname !== '/mcp') {
    throw new Error('OAuth resource must end in /mcp');
  }
  return config;
}

export async function loadConfig(file) {
  return validateConfig(JSON.parse(await readFile(file, 'utf8')));
}

export function piEnvironment(config) {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: config.piHome,
    PI_CODING_AGENT_DIR: config.piHome, PI_OFFLINE: '1', LANG: 'C.UTF-8' };
  for (const key of config.passEnv) {
    if (['HOME', 'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(key)
      || key.startsWith('PI_')) throw new Error(`passEnv ${key} is reserved`);
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
