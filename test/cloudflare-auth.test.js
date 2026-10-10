import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK } from 'jose';
import { accessConfig, accessFixture, assertionRequest, certsUrl } from './cloudflare-fixture.js';

test('Access assertion authenticates with fixed JWKS destination, empty OAuth scopes and stable sub ownership', async t => {
  const { auth, sign, fetches } = await accessFixture(t);
  assert.deepEqual(auth.schemes, [{ type: 'oauth2', scopes: [] }]);
  assert.equal(auth.metadata, undefined);
  assert.equal(auth.metadataUrl, undefined);
  const first = await auth.authenticate(assertionRequest(await sign(), { authorization: 'Bearer opaque-client-token' }));
  const renewed = await auth.authenticate(assertionRequest(await sign({ identity_nonce: 'new-session' })));
  const another = await auth.authenticate(assertionRequest(await sign({ sub: 'user-two' })));
  assert.equal(first, renewed);
  assert.notEqual(first, another);
  assert.match(first, /^[a-f0-9]{64}$/);
  await auth.authenticate(assertionRequest(await sign({ iat: Math.floor(Date.now() / 1000) - 7200 })));
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, certsUrl);
  assert.equal(fetches[0].options.redirect, 'manual');
  assert.equal(fetches[0].options.headers.has('Authorization'), false);
});

test('Access never falls back to Authorization, cookies or plaintext email; rejects ambiguous/oversized headers before fetch', async t => {
  const { auth, sign, fetches } = await accessFixture(t);
  const token = await sign();
  const requests = [
    { headers: { authorization: 'Bearer ' + token, cookie: 'CF_Authorization=' + token,
      'cf-access-authenticated-user-email': accessConfig.allowedEmail }, rawHeaders: [] },
    { headers: { authorization: 'Bearer opaque' }, rawHeaders: ['Authorization', 'Bearer opaque'] },
    assertionRequest('opaque'), assertionRequest(token + ',' + token), assertionRequest(' ' + token),
    assertionRequest(token + '\n'), assertionRequest(token + '\r\n'), assertionRequest(token + '\t'),
    assertionRequest('a.b.c'), assertionRequest('a'.repeat(16385) + '.b.c'),
    assertionRequest([token]),
    { ...assertionRequest(token), rawHeaders: ['Cf-Access-Jwt-Assertion', token, 'cf-access-jwt-assertion', token] },
    { headers: { 'cf-access-jwt-assertion': token } }
  ];
  for (const request of requests) await assert.rejects(auth.authenticate(request));
  assert.equal(fetches.length, 0);
});

test('Access binds signature, issuer, AUD, token type, claims and clock; valid disallowed identities are forbidden', async t => {
  const { auth, sign } = await accessFixture(t);
  const now = Math.floor(Date.now() / 1000);
  for (const changes of [
    { iss: 'https://other.cloudflareaccess.com' }, { aud: 'fedcba9876543210'.repeat(4) },
    { aud: accessConfig.resource }, { type: 'org' }, { type: undefined }, { sub: '' }, { sub: ' ' }, { sub: 9 },
    { exp: undefined }, { iat: undefined }, { sub: undefined }, { email: undefined },
    { exp: now - 30 }, { iat: now + 30 }, { nbf: now + 30 }, { iat: 'yesterday' }, { email: 7 }
  ]) await assert.rejects(auth.authenticate(assertionRequest(await sign(changes))), error => error.status !== 403);
  for (const changes of [
    { email: 'other@integration.dev' }, { email: 'OWNER@integration.dev' },
    { common_name: 'service' }, { common_name: '' }, { service_token_id: 'service' }, { service_token_status: true }
  ]) await assert.rejects(auth.authenticate(assertionRequest(await sign(changes))), error => error.status === 403);
  await auth.authenticate(assertionRequest(await sign({ iat: now + 2, nbf: now + 2 })));
  const wrong = await generateKeyPair('RS256');
  await assert.rejects(auth.authenticate(assertionRequest(await sign({}, wrong.privateKey))));
  const ec = await generateKeyPair('ES256');
  await assert.rejects(auth.authenticate(assertionRequest(await sign({}, ec.privateKey, { alg: 'ES256' }))));
  await assert.rejects(auth.authenticate(assertionRequest(await sign({}, new Uint8Array(32), { alg: 'HS256' }))));
});

test('Access requires kid and ignores no attacker-controlled JWK locations', async t => {
  const { auth, sign, fetches } = await accessFixture(t);
  for (const header of [{ kid: undefined }, { kid: '' }, { kid: ' ' }, { kid: 'x'.repeat(257) },
    { jku: 'https://attacker.integration.dev/keys' }, { x5u: 'https://attacker.integration.dev/cert' }, { jwk: {} }]) {
    await assert.rejects(auth.authenticate(assertionRequest(await sign({}, undefined, header))));
  }
  assert.equal(fetches.length, 0);
});

test('Access shares pending fetches, caches keys, throttles unknown kid and rotates after cooldown/cache expiry', async t => {
  const { auth, sign, fetches, setJwks } = await accessFixture(t);
  const token = await sign();
  await Promise.all(Array.from({ length: 8 }, () => auth.authenticate(assertionRequest(token))));
  assert.equal(fetches.length, 1);
  const rotated = await generateKeyPair('RS256');
  const rotatedToken = await sign({}, rotated.privateKey, { kid: 'two' });
  setJwks({ keys: [{ ...await exportJWK(rotated.publicKey), kid: 'two' }] });
  for (let i = 0; i < 4; i++) await assert.rejects(auth.authenticate(assertionRequest(rotatedToken)));
  assert.equal(fetches.length, 1);
  const initial = Date.now();
  let clock = initial + 31000;
  t.mock.method(Date, 'now', () => clock);
  await auth.authenticate(assertionRequest(rotatedToken));
  assert.equal(fetches.length, 2);
  await auth.authenticate(assertionRequest(rotatedToken));
  assert.equal(fetches.length, 2);
  clock = initial + 632000;
  await auth.authenticate(assertionRequest(rotatedToken));
  assert.equal(fetches.length, 3);
});

test('Access fails closed on JWKS redirects, failures and invalid key sets', async t => {
  const { auth, sign, fetches, setResponder } = await accessFixture(t);
  for (const response of [
    new Response(null, { status: 302, headers: { Location: 'https://attacker.integration.dev/keys' } }),
    new Response(null, { status: 503 }), new Response('invalid-json', { status: 200 }),
    new Response('{"keys":[]}', { status: 200 })
  ]) {
    setResponder(() => response);
    await assert.rejects(auth.authenticate(assertionRequest(await sign())));
  }
  assert.equal(fetches.length, 4);
  assert.ok(fetches.every(call => call.url === certsUrl && call.options.redirect === 'manual'));
});

test('Access JWKS fetch aborts after the configured five-second timeout', async t => {
  const { auth, sign, fetches, setResponder } = await accessFixture(t);
  setResponder(({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const keepAlive = setTimeout(() => {}, 7000); t.after(() => clearTimeout(keepAlive));
  const start = performance.now();
  await assert.rejects(auth.authenticate(assertionRequest(await sign())), error => error.code === 'ERR_JWKS_TIMEOUT');
  assert.ok(performance.now() - start >= 4500 && performance.now() - start < 6500);
  assert.equal(fetches.length, 1);
});
