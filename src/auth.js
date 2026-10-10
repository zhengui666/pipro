import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

const taskOwner = (issuer, sub) => createHash('sha256').update(JSON.stringify([issuer, sub])).digest('hex');

function cloudflareAccess(auth) {
  // One resolver per server retains jose's rotation cache and unknown-kid cooldown.
  const keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', auth.issuer), {
    timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000
  });
  return {
    schemes: [{ type: 'oauth2', scopes: [] }],
    authenticate: async request => {
      const name = 'cf-access-jwt-assertion';
      const header = request.headers[name];
      let count = 0;
      for (let i = 0; i < (request.rawHeaders?.length ?? 0); i += 2) {
        if (request.rawHeaders[i].toLowerCase() === name) count++;
      }
      if (count !== 1 || typeof header !== 'string' || header.length > 16384 || header.trim() !== header
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)) throw new Error('unauthorized');
      const protectedHeader = decodeProtectedHeader(header);
      if (protectedHeader.alg !== 'RS256' || typeof protectedHeader.kid !== 'string'
        || !protectedHeader.kid.trim() || protectedHeader.kid.length > 256
        || ['jku', 'x5u', 'jwk'].some(key => Object.hasOwn(protectedHeader, key))) throw new Error('unauthorized');
      const { payload } = await jwtVerify(header, keys, {
        issuer: auth.issuer, audience: auth.audience, algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'email', 'type'], clockTolerance: 5
      });
      if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub.trim()
        || typeof payload.email !== 'string' || !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)
        || (payload.nbf !== undefined && !Number.isFinite(payload.nbf))
        || payload.iat > Math.floor(Date.now() / 1000) + 5) throw new Error('unauthorized');
      if (payload.email !== auth.allowedEmail || Object.hasOwn(payload, 'common_name')
        || Object.hasOwn(payload, 'service_token_id') || payload.service_token_status === true) {
        const error = new Error('forbidden'); error.status = 403; throw error;
      }
      return taskOwner(auth.issuer, payload.sub);
    }
  };
}

export async function createAuth(config) {
  if (config.auth.mode === 'none') return { authenticate: async () => 'local', schemes: [{ type: 'noauth' }] };
  const auth = config.auth;
  if (auth.mode === 'cloudflare-access') return cloudflareAccess(auth);
  const jwks = JSON.parse(await readFile(auth.jwksFile, 'utf8'));
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0 || jwks.keys.some(key =>
    !['RSA', 'EC', 'OKP'].includes(key.kty) || ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].some(k => k in key))) {
    throw new Error('Public asymmetric JWKS required');
  }
  const keys = createLocalJWKSet(jwks);
  const subjects = new Set(auth.allowedSubjects);
  return {
    schemes: [{ type: 'oauth2', scopes: [auth.scope] }],
    metadata: { resource: auth.resource, authorization_servers: [auth.issuer],
      scopes_supported: [auth.scope], bearer_methods_supported: ['header'], resource_name: 'pipro' },
    metadataUrl: `${new URL(auth.resource).origin}/.well-known/oauth-protected-resource/mcp`,
    authenticate: async request => {
      const header = request.headers.authorization;
      if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,16384}$/.test(header)) throw new Error('unauthorized');
      const { payload } = await jwtVerify(header.slice(7), keys, { issuer: auth.issuer, audience: auth.resource,
        algorithms: ['RS256', 'ES256', 'EdDSA'], requiredClaims: ['exp', 'iat', 'sub'], maxTokenAge: '1h' });
      if (!subjects.has(payload.sub)) {
        throw new Error('unauthorized');
      }
      if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(auth.scope)) {
        const error = new Error('insufficient_scope'); error.status = 403; throw error;
      }
      // Task ownership survives access-token renewal; raw subject/token is never returned.
      return taskOwner(auth.issuer, payload.sub);
    }
  };
}
