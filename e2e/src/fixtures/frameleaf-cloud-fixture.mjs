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
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.FRAMELEAF_CLOUD_FIXTURE_PORT ?? 3010);
// Port 0 (medium specs) takes a free port; with no URL given, BASE is then the loopback address it bound.
let BASE = (process.env.FRAMELEAF_CLOUD_FIXTURE_URL ?? `http://frameleaf-cloud-fixture:${PORT}`).replace(/\/+$/, '');
const INSTANCE_ID = process.env.FRAMELEAF_CLOUD_FIXTURE_INSTANCE_ID ?? '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';

const fixture = (path) => JSON.parse(readFileSync(new URL(`./frameleaf-cloud/${path}`, import.meta.url), 'utf8'));

// FL-159: opt-in recorded-provider lifecycle, never a real GPU or wallet ledger. The original
// consent fixture stays unchanged unless this exact mode is selected. Containers mount the
// existing vendored contracts here; local runs resolve the same tracked files without copying.
const DESCRIPTIONS = process.env.FRAMELEAF_CLOUD_FIXTURE_MODE === 'description-accounting';
const contracts = (path) =>
  JSON.parse(
    readFileSync(
      new URL(
        path,
        process.env.FRAMELEAF_CLOUD_FIXTURE_CONTRACTS ??
          new URL('../../../server/test/fixtures/frameleaf-cloud-contracts/ml/', import.meta.url),
      ),
      'utf8',
    ),
  );
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lifecycle = () => ({ jobs: [], estimates: new Map(), transport: [], unknownUsage: false });
let descriptionState = lifecycle();

const targets = (job) =>
  job.request.inputs.map((input) => ({
    ...contracts('storage/job-admitted-uploads.json').uploads[0],
    ...input,
    inline: { url: `${BASE}/fixture-storage/${job.id}/in/${input.inputId}`, method: 'PUT' },
    uploaded: job.uploads.has(input.inputId),
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  }));

const admitted = (job) => ({
  ...contracts('storage/job-admitted-uploads.json'),
  jobId: job.id,
  modelSku: job.request.modelSku,
  modelRev: job.request.modelRev,
  createdAt: job.createdAt,
  uploads: targets(job),
});

const jobView = (job) => {
  const view = contracts('job-completed.json');
  const storage = contracts('storage/job-completed-result.json').result;
  return {
    ...view,
    jobId: job.id,
    modelSku: job.request.modelSku,
    modelRev: job.request.modelRev,
    clientRef: job.request.clientRef,
    createdAt: job.createdAt,
    updatedAt: job.createdAt,
    progress: {
      ...view.progress,
      done: job.completed ? job.request.inputs.length : 0,
      total: job.request.inputs.length,
    },
    status: job.completed ? 'completed' : job.started ? 'running' : 'admitted',
    cost: job.completed ? { ...view.cost, settledAt: job.createdAt } : null,
    result: job.completed
      ? {
          ...storage,
          modelSku: job.request.modelSku,
          modelRev: job.request.modelRev,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          outputs: job.request.inputs.map((input) => {
            const bytes = job.outputs.get(input.inputId);
            return {
              ...storage.outputs[0],
              outputId: input.inputId,
              url: `${BASE}/fixture-storage/${job.id}/out/${input.inputId}`,
              sha256: hash(bytes),
              bytes: bytes.length,
            };
          }),
        }
      : null,
  };
};

const descriptionUsage = () => {
  const template = contracts('usage.json').items[0];
  const completed = contracts('job-completed.json');
  const items = descriptionState.jobs
    .filter((job) => job.completed)
    .map((job) => ({
      ...template,
      jobId: job.id,
      clientRef: job.request.clientRef,
      settledUsd: completed.cost.totalUsd,
      settledAt: job.createdAt,
      modelSku: job.request.modelSku,
      gpuSeconds: completed.run.meteredSeconds,
      estimateUsd: completed.charges.holdUsd,
    }));
  if (descriptionState.unknownUsage) {
    items.push({ ...template, jobId: '0192f1b0-0000-7000-8000-000000000000', clientRef: null });
  }
  return { items };
};

const descriptionWallet = () => {
  const wallet = fixture('ml/wallet.json');
  const total =
    descriptionState.jobs.filter((job) => job.completed).length * contracts('job-completed.json').cost.totalUsd;
  return {
    ...wallet,
    balanceUsd: wallet.balanceUsd - total,
    heldUsd:
      descriptionState.jobs.filter((job) => !job.completed && !job.released).length *
      contracts('job-completed.json').charges.holdUsd,
    spentTodayUsd: total,
  };
};

/** Test-provider route handling only: runtime correlations and actual bytes, not App state writes. */
const descriptionRoute = async (request, response, url) => {
  if (!DESCRIPTIONS) {
    return false;
  }
  if (request.method === 'POST' && url.pathname === '/__fixture/unknown-usage') {
    descriptionState.unknownUsage = true;
    send(response, 204);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/v2/jobs') {
    const body = JSON.parse(await readBody(request));
    const key = request.headers['idempotency-key'];
    const existing = descriptionState.jobs.find((job) => job.key === key);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(body)) {
        refusal(response, 'request-invalid', 422);
      } else {
        send(response, 201, admitted(existing));
      }
      return true;
    }
    const estimate = descriptionState.estimates.get(body.estimate);
    if (
      !key ||
      !estimate ||
      estimate.used ||
      body.workload !== 'descriptions' ||
      body.modelSku !== estimate.body.modelSku ||
      JSON.stringify(body.inputs) !== JSON.stringify(estimate.body.inputs) ||
      JSON.stringify(body.request) !== JSON.stringify(estimate.body.request) ||
      body.inputs.length !== 1 ||
      body.inputs[0].bytes > 1_048_576
    ) {
      refusal(response, 'request-invalid', 422);
      return true;
    }
    estimate.used = true;
    const job = {
      id: randomUUID(),
      key,
      request: body,
      createdAt: new Date().toISOString(),
      uploads: new Set(),
      outputs: new Map(),
      started: false,
      completed: false,
      released: false,
    };
    descriptionState.jobs.push(job);
    send(response, 201, admitted(job));
    return true;
  }
  const storage = /^\/fixture-storage\/([^/]+)\/(in|out)\/([\w-]+)$/.exec(url.pathname);
  if (storage) {
    const [, id, direction, inputId] = storage;
    const job = descriptionState.jobs.find((job) => job.id === id);
    const input = job?.request.inputs.find((item) => item.inputId === inputId);
    const headers =
      direction === 'in'
        ? targets(job ?? { request: { inputs: [] } })[0]?.headers
        : contracts('storage/job-completed-result.json').result.headers;
    const encrypted = headers && Object.entries(headers).every(([name, value]) => request.headers[name] === value);
    if (!job || !input || !encrypted || job.released || request.headers.authorization) {
      send(response, 403);
      return true;
    }
    if (direction === 'in' && request.method === 'PUT' && !job.started) {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > input.bytes || size > 1_048_576) {
          send(response, 413);
          return true;
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (size !== input.bytes || hash(bytes) !== input.sha256) {
        send(response, 400);
      } else {
        job.uploads.add(inputId);
        send(response, 200, undefined, { etag: `"${hash(bytes)}"` });
      }
    } else if (direction === 'out' && request.method === 'GET' && job.completed) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(job.outputs.get(inputId));
    } else {
      send(response, 409);
    }
    return true;
  }
  const route = /^\/v2\/jobs\/([^/]+)(?:\/(uploads|start))?$/.exec(url.pathname);
  if (!route) {
    return false;
  }
  const [, id, action] = route;
  const job = descriptionState.jobs.find((job) => job.id === id);
  if (!job) {
    send(response, 404);
  } else if (!action && request.method === 'DELETE') {
    job.released = true;
    send(response, 204);
  } else if (!action && request.method === 'GET') {
    // Complete at the normal client's first post-start poll; usage is unsettled before that.
    job.completed = job.started;
    send(response, 200, jobView(job), { etag: `"${job.id}-${job.started}"` });
  } else if (action === 'uploads' && request.method === 'GET') {
    send(response, 200, { jobId: job.id, uploads: targets(job) });
  } else if (action === 'start' && request.method === 'POST') {
    if (job.uploads.size !== job.request.inputs.length) {
      send(response, 409, {
        code: 'inputs-missing',
        message: 'Inputs missing.',
        retryable: false,
        requestId: 'req_fixture',
      });
    } else {
      for (const input of job.request.inputs) {
        const document = contracts('descriptions/result.json');
        document.modelSku = job.request.modelSku;
        document.modelRev = job.request.modelRev;
        document.items = [{ ...document.items[0], inputId: input.inputId }];
        job.outputs.set(input.inputId, Buffer.from(JSON.stringify(document)));
      }
      job.started = true;
      send(response, 200, jobView(job));
    }
  } else {
    send(response, 404);
  }
  return true;
};

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
  'GET /v2/catalog': (_request, response) =>
    send(response, 200, DESCRIPTIONS ? contracts('catalog-descriptions.json') : fixture('ml/catalog-restoration.json')),
  'GET /v2/wallet': (_request, response) =>
    send(response, 200, DESCRIPTIONS ? descriptionWallet() : fixture('ml/wallet.json')),
  'GET /v2/usage': (_request, response) =>
    send(response, 200, DESCRIPTIONS ? descriptionUsage() : fixture('ml/usage.json')),
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
    const text = await readBody(request);
    const body = DESCRIPTIONS ? JSON.parse(text || '{}') : null;
    if (!state.recorded) {
      refusal(response, 'consent-missing', 403);
      return;
    }
    if (state.recorded.version !== state.requiredVersion) {
      refusal(response, 'consent-version-outdated', 403, { requiredVersion: state.requiredVersion });
      return;
    }
    const estimate = fixture('ml/estimate-response.json');
    if (DESCRIPTIONS) {
      if (body.workload !== 'descriptions' || !Array.isArray(body.inputs) || body.inputs.length !== 1) {
        refusal(response, 'request-invalid', 422);
        return;
      }
      const view = contracts('job-completed.json');
      estimate.estimate = `est1.${hash(randomUUID())}`;
      estimate.cost = {
        p50: view.cost.totalUsd,
        p90: view.charges.holdUsd,
        startup: view.cost.lines[0].amountUsd,
        hold: view.charges.holdUsd,
        minimum: view.cost.lines[0].amountUsd,
      };
      descriptionState.estimates.set(estimate.estimate, { body, used: false });
    }
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
  'GET /__fixture/state': (_request, response) =>
    send(response, 200, {
      ...state,
      ...(DESCRIPTIONS && {
        lifecycle: {
          jobs: descriptionState.jobs.map((job) => ({
            id: job.id,
            clientRef: job.request.clientRef,
            inputs: job.request.inputs,
            started: job.started,
            released: job.released,
            uploads: [...job.uploads],
            totalUsd: job.completed ? jobView(job).cost.totalUsd : null,
          })),
          transport: descriptionState.transport,
        },
      }),
    }),
  'POST /__fixture/reset': (_request, response) => {
    state = initialState();
    descriptionState = lifecycle();
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
    if (DESCRIPTIONS && url.pathname.startsWith('/v2/')) {
      // Keep only proof presence/key binding, never tokens, proofs or storage keys in evidence.
      let bound = false;
      try {
        const token = String(request.headers.authorization ?? '').split(' ')[1];
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        bound = payload.cnf.jkt === dpopThumbprint(request.headers.dpop);
      } catch {
        /* malformed credentials are refused by this fixture */
      }
      descriptionState.transport.push({ method: request.method, path: url.pathname, bound });
      if (!bound) {
        send(response, 401);
        return;
      }
    }
    if (await descriptionRoute(request, response, url)) {
      return;
    }
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
