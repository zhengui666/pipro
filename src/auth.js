import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';

export async function createAuth(config) {
  if (config.auth.mode === 'none') return { authenticate: async () => 'local', schemes: [{ type: 'noauth' }] };
  const auth = config.auth;
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
      return createHash('sha256').update(JSON.stringify([auth.issuer, payload.sub])).digest('hex');
    }
  };
}
