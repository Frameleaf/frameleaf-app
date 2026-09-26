import { createHash, createPublicKey, verify } from 'node:crypto';
import { once } from 'node:events';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

/**
 * A scriptable fake Frameleaf Cloud for specs (FL-154..FL-158): discovery is served by default and
 * every other path answers from `routes` (`"POST /id/token"`), else 404. Every request is recorded,
 * so specs can assert what was (and was not) sent. Fork tests never need the real hosted service.
 *
 * FL-178: like the cloud after FC-66, every request that carries a `DPoP` header has its proof
 * checked before any route runs (RFC 9449 section 4.3: `typ`, `alg`, a public `jwk` and no `kid`,
 * the signature, `htm`, `htu` equal to the literal address asked for, `iat` within ±60 s, `jti` not
 * reused, `ath` matching a presented token, whose `cnf.jkt` must be the proof key); a failure answers
 * `invalid_dpop_proof` (400 from the token endpoint, else 401). The `client_credentials` token request
 * and `POST /api/v1/instances` must carry a proof, and at the token endpoint the proof key must be the
 * client assertion's key. Tokens are looked up in the store of tokens a fake minted: one presented as
 * a bearer, or an unknown one, answers `401 invalid_token`, as the cloud does with `bearer_compat` off.
 * With `nonce` set, a proof without that nonce gets the nonce challenge: `400 use_dpop_nonce` from
 * the token endpoint, `401 use_dpop_nonce` with `WWW-Authenticate` from everything else, and a
 * `DPoP-Nonce` header either way.
 */
export type FakeDpopProof = {
  header: { typ?: unknown; alg?: unknown; kid?: unknown; jwk?: { kty: string; crv: string; x: string; d?: unknown } };
  claims: { jti?: unknown; htm?: unknown; htu?: unknown; iat?: unknown; nonce?: unknown; ath?: unknown };
  jkt: string;
};

export type FakeCloudRequest = {
  method: string;
  path: string;
  /** The full address asked for, query included. */
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
  json: () => any;
  form: () => URLSearchParams;
  /** The verified DPoP proof, when the request carried one. */
  dpop: FakeDpopProof | null;
};

export type FakeCloudAnswer = { status: number; body?: unknown; headers?: Record<string, string> };

export type FakeCloud = {
  url: string;
  requests: FakeCloudRequest[];
  routes: Map<string, (request: FakeCloudRequest) => FakeCloudAnswer | Promise<FakeCloudAnswer>>;
  on: (route: string, handler: (request: FakeCloudRequest) => FakeCloudAnswer | Promise<FakeCloudAnswer>) => void;
  discovery: () => Record<string, unknown>;
  /** When set, every DPoP proof must carry this nonce (FC-66 nonce handling). */
  nonce: string | null;
  /** Answers sent before any route ran (proof refusals and nonce challenges), for assertions. */
  refusals: Array<{ path: string; status: number; code: string }>;
  close: () => Promise<void>;
};

/**
 * The cloud's golden answer to a resource nonce challenge: packages/contracts
 * `fixtures/errors/use-dpop-nonce.json` (frameleaf-cloud, FC-19/FC-66).
 */
export const USE_DPOP_NONCE_ENVELOPE = {
  code: 'use_dpop_nonce',
  message: 'Retry with the DPoP-Nonce from this response.',
  retryable: true,
  requestId: 'req_01J8ZK3M4N5P6Q7S',
};

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const decode = (part: string | undefined) => JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'));

/** The claims of a JWT-shaped token, or null. */
export const tokenClaims = (token: string | undefined): Record<string, any> | null => {
  try {
    return decode(token?.split('.', 3)[1]) as Record<string, any>;
  } catch {
    return null;
  }
};

/** The access token presented as `Authorization: DPoP <token>`, or null. */
export const dpopTokenOf = (request: Pick<FakeCloudRequest, 'headers'>): string | null => {
  const match = /^DPoP (\S+)$/.exec(request.headers.authorization ?? '');
  return match ? match[1] : null;
};

/** The name a fake token was minted under (`api-token`, `ml-token`, …), from `Authorization: DPoP`. */
export const tokenNameOf = (request: Pick<FakeCloudRequest, 'headers'>): string | null =>
  tokenClaims(dpopTokenOf(request) ?? undefined)?.name ?? null;

/** The `kid` in the header of the request's client assertion. */
export const assertionKidOf = (request: FakeCloudRequest): string =>
  decode(request.form().get('client_assertion')?.split('.', 1)[0]).kid;

/**
 * A token as the cloud mints it after FC-66: a JWT bound to the proof's key (`cnf.jkt`) naming the
 * key whose client assertion minted it (`frameleaf_kid`). `overrides` replaces claims, to mint a
 * token bound to the wrong key.
 */
/** Every access token a fake cloud minted: the token store a bearer or unknown token is looked up in. */
const mintedTokens = new Set<string>();

export const mintToken = (request: FakeCloudRequest, name = 'api-token', overrides: Record<string, unknown> = {}) => {
  const claims = {
    name,
    scope: 'instance',
    cnf: { jkt: request.dpop?.jkt },
    frameleaf_kid: assertionKidOf(request),
    ...overrides,
  };
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${part({ alg: 'EdDSA', typ: 'at+jwt' })}.${part(claims)}.${Buffer.from(name).toString('base64url')}`;
  mintedTokens.add(token);
  return token;
};

/** A successful token answer (`token_type` `DPoP`) bound to the request's proof key. */
export const tokenAnswer = (request: FakeCloudRequest, name = 'api-token', expiresIn = 600): FakeCloudAnswer => ({
  status: 200,
  body: { access_token: mintToken(request, name), token_type: 'DPoP', expires_in: expiresIn },
});

/** `htu` is compared with the literal address asked for (`expectedHtu`), never re-normalised. */
const proofProblem = (proof: string, method: string, expectedHtu: string, seen: Map<string, number>, now: number) => {
  const parts = proof.split('.');
  if (parts.length !== 3) {
    return { problem: 'not a compact JWS' };
  }
  let header: FakeDpopProof['header'];
  let claims: FakeDpopProof['claims'];
  try {
    header = decode(parts[0]);
    claims = decode(parts[1]);
  } catch {
    return { problem: 'unreadable' };
  }
  const jwk = header.jwk;
  if (header.typ !== 'dpop+jwt' || header.alg !== 'EdDSA' || header.kid !== undefined) {
    return { problem: 'header' };
  }
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || 'd' in jwk) {
    return { problem: 'jwk' };
  }
  const valid = verify(
    null,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'),
  );
  if (!valid) {
    return { problem: 'signature' };
  }
  if (claims.htm !== method || claims.htu !== expectedHtu) {
    return { problem: 'htm or htu' };
  }
  if (typeof claims.iat !== 'number' || Math.abs(claims.iat - now / 1000) > 60) {
    return { problem: 'iat' };
  }
  if (typeof claims.jti !== 'string' || !claims.jti || (seen.get(claims.jti) ?? 0) > now - 5 * 60 * 1000) {
    return { problem: 'jti' };
  }
  seen.set(claims.jti, now);
  return { proof: { header, claims, jkt: ed25519Thumbprint(jwk) } };
};

export const startFakeCloud = async (): Promise<FakeCloud> => {
  const fake = { requests: [], routes: new Map(), nonce: null, refusals: [] } as unknown as FakeCloud;
  const seenJti = new Map<string, number>();
  fake.on = (route, handler) => fake.routes.set(route, handler);
  fake.discovery = () => ({
    version: 1,
    validFor: 3600,
    issuer: `${fake.url}/id`,
    api: `${fake.url}/api`,
    ml: { eu: `${fake.url}/ml-eu` },
  });

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server: Server = createServer(async (incoming: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(incoming);
    const path = (incoming.url ?? '/').split('?', 1)[0];
    const request: FakeCloudRequest = {
      method: incoming.method ?? 'GET',
      path,
      url: `${fake.url}${incoming.url ?? '/'}`,
      headers: incoming.headers,
      body,
      json: () => JSON.parse(body),
      form: () => new URLSearchParams(body),
      dpop: null,
    };
    fake.requests.push(request);
    const send = ({ status, body: payload, headers }: FakeCloudAnswer) => {
      response.writeHead(status, { ...headers, 'content-type': 'application/json' });
      response.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    const tokenEndpoint = path === '/id/token';
    const refuse = (status: number, code: string, headers: Record<string, string> = {}) => {
      fake.refusals.push({ path, status, code });
      return send({
        status,
        headers,
        body: tokenEndpoint
          ? { error: code }
          : code === 'use_dpop_nonce'
            ? USE_DPOP_NONCE_ENVELOPE
            : { code, message: `refused: ${code}`, retryable: false },
      });
    };

    const authorization = incoming.headers.authorization ?? '';
    // an instance token presented as a bearer is refused (the cloud with bearer_compat off); the link
    // and initial access tokens are not in the token store and stay bearer
    if (authorization.startsWith('Bearer ') && mintedTokens.has(authorization.slice('Bearer '.length))) {
      return refuse(401, 'invalid_token');
    }
    const proofHeader = incoming.headers.dpop;
    const clientCredentials = tokenEndpoint && request.form().get('grant_type') === 'client_credentials';
    // FC-66: the instance token request and the registration always carry a proof
    if (
      typeof proofHeader !== 'string' &&
      (clientCredentials || (request.method === 'POST' && path === '/api/v1/instances'))
    ) {
      return refuse(tokenEndpoint ? 400 : 401, 'invalid_dpop_proof');
    }
    if (typeof proofHeader === 'string') {
      // the address asked for, without its query: a literal, not the client's normalisation
      const checked = proofProblem(proofHeader, request.method, `${fake.url}${path}`, seenJti, Date.now());
      if (!checked.proof) {
        return refuse(tokenEndpoint ? 400 : 401, 'invalid_dpop_proof');
      }
      if (clientCredentials) {
        let assertionKid: unknown;
        try {
          assertionKid = assertionKidOf(request);
        } catch {
          assertionKid = undefined;
        }
        // the proof key and the client assertion key must be one key
        if (assertionKid !== checked.proof.jkt) {
          return refuse(400, 'invalid_dpop_proof');
        }
      }
      const token = dpopTokenOf(request);
      if (token && !mintedTokens.has(token)) {
        return refuse(401, 'invalid_token');
      }
      if (token) {
        const ath = createHash('sha256').update(token, 'ascii').digest('base64url');
        if (checked.proof.claims.ath !== ath || tokenClaims(token)?.cnf?.jkt !== checked.proof.jkt) {
          return refuse(401, 'invalid_dpop_proof');
        }
      } else if (checked.proof.claims.ath !== undefined) {
        return refuse(401, 'invalid_dpop_proof');
      }
      if (fake.nonce && checked.proof.claims.nonce !== fake.nonce) {
        return refuse(tokenEndpoint ? 400 : 401, 'use_dpop_nonce', {
          'DPoP-Nonce': fake.nonce,
          ...(!tokenEndpoint && { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce", algs="EdDSA"' }),
        });
      }
      request.dpop = checked.proof;
    } else if (authorization.startsWith('DPoP ')) {
      return refuse(401, 'invalid_dpop_proof');
    }

    const handler = fake.routes.get(`${request.method} ${path}`);
    if (handler) {
      return send(await handler(request));
    }
    if (path === '/.well-known/frameleaf-services') {
      return send({ status: 200, body: fake.discovery() });
    }
    return send({ status: 404, body: { code: 'not-found', message: 'not found' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
};
