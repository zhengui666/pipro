import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createAuth } from '../src/auth.js';

export const accessConfig = {
  mode: 'cloudflare-access', issuer: 'https://pipro-unit.cloudflareaccess.com',
  resource: 'https://pipro.integration.dev/mcp', audience: '0123456789abcdef'.repeat(4),
  allowedEmail: 'owner@integration.dev'
};
export const certsUrl = accessConfig.issuer + '/cdn-cgi/access/certs';
const pair = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(pair.publicKey), kid: 'one' };

export function assertionRequest(token, extra = {}) {
  return { headers: { 'cf-access-jwt-assertion': token, ...extra },
    rawHeaders: ['Cf-Access-Jwt-Assertion', token] };
}

export async function accessFixture(t) {
  const fetches = [];
  let jwks = { keys: [publicJwk] };
  let respond = () => new Response(JSON.stringify(jwks), { status: 200 });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url !== certsUrl) throw new Error('unexpected JWKS destination');
    fetches.push({ url, options });
    return respond(options);
  });
  const auth = await createAuth({ auth: accessConfig });
  async function sign(changes = {}, key = pair.privateKey, header = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: accessConfig.issuer, aud: [accessConfig.audience], sub: 'user-one',
      email: accessConfig.allowedEmail, type: 'app', iat: now, exp: now + 86400, ...changes };
    for (const name of Object.keys(claims)) if (claims[name] === undefined) delete claims[name];
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'one', ...header }).sign(key);
  }
  return { auth, sign, fetches, setJwks: value => { jwks = value; },
    setResponder: value => { respond = value; } };
}
