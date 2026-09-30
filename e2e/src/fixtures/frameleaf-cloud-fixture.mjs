/**
 * A fake Frameleaf Cloud for e2e (FL-201): discovery, the instance token and the ML gateway, answering
 * the published contract fixtures of `@frameleaf/cloud-contracts` 0.0.2 (frameleaf-cloud
 * 18da2ba868bac1227a7e138602fc0aa2e184b1c5, packages/contracts/fixtures), vendored unchanged under
 * ./frameleaf-cloud/. Only what the fixtures cannot hold is filled in here: this service's own address in
 * discovery (issuer, api and ml.<region> on one host), the token's `cnf.jkt` (the thumbprint of the key
 * in the DPoP proof; signatures are not checked), a fresh estimate expiry, and the consent state.
 *
 * Consent follows docs/cloud-ml.md: GET /v2/consent/current (any query key other than identityNames and
 * medicalSignals is 422), POST /v2/consent (403 consent-version-outdated with data.requiredVersion for any
 * version other than the one required), DELETE /v2/consent (204, idempotent). /capabilities never answers
 * 402; it reports the required and recorded versions.
 *
 * Test-only control (never part of the contract): POST /__fixture/consent {"requiredVersion"} bumps the
 * version the cloud requires, GET /__fixture/state reads the state, POST /__fixture/reset restores it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.FRAMELEAF_CLOUD_FIXTURE_PORT ?? 3010);
// Port 0 (medium specs) takes a free port; with no URL given, BASE is then the loopback address it bound.
let BASE = (process.env.FRAMELEAF_CLOUD_FIXTURE_URL ?? `http://frameleaf-cloud-fixture:${PORT}`).replace(/\/+$/, '');
const INSTANCE_ID = process.env.FRAMELEAF_CLOUD_FIXTURE_INSTANCE_ID ?? '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';

const fixture = (path) => JSON.parse(readFileSync(new URL(`./frameleaf-cloud/${path}`, import.meta.url), 'utf8'));

const INITIAL_VERSION = fixture('ml/consent-current.json').requiredVersion;
const initialState = () => ({ requiredVersion: INITIAL_VERSION, recorded: null, requests: [] });
let state = initialState();

const send = (response, status, body, headers = {}) => {
  if (body === undefined) {
    response.writeHead(status, headers).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
};

const refusal = (response, name, status, data) => {
  const body = fixture(`errors/${name}.json`);
  send(response, status, data ? { ...body, data: { ...body.data, ...data } } : body);
};

const readBody = async (request) => {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 65_536) {
      throw new Error('body too large');
    }
  }
  return text;
};

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** RFC 7638 thumbprint of the public key in a DPoP proof's header, which the app uses as its key id. */
const dpopThumbprint = (proof) => {
  const [header] = String(proof ?? '').split('.', 1);
  const { jwk } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  const members =
    jwk.kty === 'OKP'
      ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
      : jwk.kty === 'EC'
        ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
        : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return createHash('sha256').update(JSON.stringify(members)).digest('base64url');
};

const discovery = () => {
  const document = fixture('instance/discovery-instance.json');
  const endpoints = Object.fromEntries(
    Object.entries(document.endpoints).map(([name, url]) => [name, `${BASE}${new URL(url).pathname}`]),
  );
  return {
    ...document,
    issuer: BASE,
    api: BASE,
    store: `${BASE}/store`,
    ml: Object.fromEntries(Object.keys(document.ml).map((region) => [region, BASE])),
    endpoints: { ...endpoints, mlGrant: `${BASE}/token` },
    jwks: { oidc: `${BASE}/jwks`, keys: `${BASE}/.well-known/frameleaf-keys.json` },
    instanceId: INSTANCE_ID,
  };
};

const consentText = (template, version) => template.replaceAll(INITIAL_VERSION, version);

const capabilities = () => {
  const answer = fixture('ml/capabilities.json');
  return {
    ...answer,
    consent: {
      ...answer.consent,
      requiredVersion: state.requiredVersion,
      recordedVersion: state.recorded?.version ?? null,
      features: state.recorded?.features ?? answer.consent.features,
    },
  };
};

const routes = {
  'GET /ping': (_request, response) => send(response, 200, { ok: true }),
  'GET /.well-known/frameleaf-services': (_request, response) => send(response, 200, discovery()),
  'POST /token': (request, response) => {
    const jkt = dpopThumbprint(request.headers.dpop);
    const recorded = fixture('instance/token-response-dpop.json');
    const accessToken = [
      base64url({ alg: 'EdDSA', typ: 'at+jwt' }),
      base64url({ sub: INSTANCE_ID, cnf: { jkt }, frameleaf_kid: jkt, scope: 'instance' }),
      Buffer.from('unsigned-e2e-fixture').toString('base64url'),
    ].join('.');
    send(response, 200, { ...recorded, access_token: accessToken });
  },
  'GET /capabilities': (_request, response) => send(response, 200, capabilities()),
  'GET /hardware': (_request, response) => send(response, 200, fixture('ml/hardware.json')),
  'GET /v2/catalog': (_request, response) => send(response, 200, fixture('ml/catalog-restoration.json')),
  'GET /v2/wallet': (_request, response) => send(response, 200, fixture('ml/wallet.json')),
  'GET /v2/usage': (_request, response) => send(response, 200, fixture('ml/usage.json')),
  'GET /v2/consent/current': (request, response, url) => {
    if ([...url.searchParams.keys()].some((key) => key !== 'identityNames' && key !== 'medicalSignals')) {
      refusal(response, 'request-invalid', 422);
      return;
    }
    const current = fixture('ml/consent-current.json');
    const text = consentText(current.text, state.requiredVersion);
    send(response, 200, {
      ...current,
      requiredVersion: state.requiredVersion,
      recordedVersion: state.recorded?.version ?? null,
      recordedAt: state.recorded?.at ?? null,
      features: {
        ...current.features,
        identityNames: url.searchParams.get('identityNames') === 'true',
        medicalSignals: url.searchParams.get('medicalSignals') === 'true',
      },
      summary: consentText(current.summary, state.requiredVersion),
      text,
      // the contract's digest is the SHA-256 of the text (contracts src/ml/consent.ts)
      textSha256: createHash('sha256').update(text).digest('hex'),
    });
  },
  'POST /v2/consent': async (request, response) => {
    const body = JSON.parse((await readBody(request)) || '{}');
    if (body.version !== state.requiredVersion) {
      refusal(response, 'consent-version-outdated', 403, { requiredVersion: state.requiredVersion });
      return;
    }
    const at = new Date().toISOString();
    state.recorded = { version: body.version, features: body.features, at };
    send(response, 200, {
      ...fixture('ml/consent-recorded.json'),
      recordedVersion: body.version,
      recordedAt: at,
      features: body.features,
    });
  },
  'DELETE /v2/consent': (_request, response) => {
    state.recorded = null;
    send(response, 204);
  },
  'POST /v2/estimates': async (request, response) => {
    await readBody(request);
    if (!state.recorded) {
      refusal(response, 'consent-missing', 403);
      return;
    }
    if (state.recorded.version !== state.requiredVersion) {
      refusal(response, 'consent-version-outdated', 403, { requiredVersion: state.requiredVersion });
      return;
    }
    const estimate = fixture('ml/estimate-response.json');
    send(response, 200, { ...estimate, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
  },
  // test-only control, not part of the contract
  'POST /__fixture/consent': async (request, response) => {
    const body = JSON.parse((await readBody(request)) || '{}');
    if (typeof body.requiredVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/.test(body.requiredVersion)) {
      send(response, 400, { message: 'requiredVersion must be YYYY-MM-DD.N' });
      return;
    }
    state.requiredVersion = body.requiredVersion;
    send(response, 200, { requiredVersion: state.requiredVersion, recorded: state.recorded });
  },
  'GET /__fixture/state': (_request, response) => send(response, 200, state),
  'POST /__fixture/reset': (_request, response) => {
    state = initialState();
    send(response, 200, state);
  },
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', BASE);
  const key = `${request.method} ${url.pathname}`;
  if (!url.pathname.startsWith('/__fixture/')) {
    state.requests.push(key);
    state.requests = state.requests.slice(-200);
  }
  const route = routes[key];
  try {
    if (route) {
      await route(request, response, url);
      return;
    }
  } catch (error) {
    console.error(`frameleaf-cloud-fixture: ${key} failed: ${error}`);
    refusal(response, 'request-invalid', 422);
    return;
  }
  console.error(`frameleaf-cloud-fixture: no route for ${key}`);
  send(response, 404, { code: 'not-found', message: 'Not found.', retryable: false, requestId: 'req_e2e_fixture' });
});
server.listen(PORT, '0.0.0.0', () => {
  if (PORT === 0 && !process.env.FRAMELEAF_CLOUD_FIXTURE_URL) {
    BASE = `http://127.0.0.1:${server.address().port}`;
  }
  // The ready line: callers wait for it instead of polling.
  console.log(`frameleaf-cloud-fixture listening on ${BASE}`);
});
