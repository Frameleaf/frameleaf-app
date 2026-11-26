import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { once } from 'node:events';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

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
  /** The token store of the fake cloud that received the request: every token it minted. */
  tokens: Set<string>;
};

/** An answer: `body` is sent as JSON, `raw` as it is (with its own `content-type` in `headers`). */
export type FakeCloudAnswer = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> };

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
  /** Every access token this fake minted, or accepts from the fake whose store it shares. */
  tokens: Set<string>;
  close: () => Promise<void>;
};

/**
 * The cloud's golden answer to a resource nonce challenge: packages/contracts
 * `fixtures/errors/use-dpop-nonce.json` (frameleaf-cloud, FC-19/FC-66), as vendored by FL-177.
 */
export const USE_DPOP_NONCE_ENVELOPE = cloudContractFixture<Record<string, unknown>>('errors/use-dpop-nonce.json');

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
  // kept in the store of the fake cloud that minted it, where a bearer or unknown token is looked up
  request.tokens.add(token);
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
  if (
    !header ||
    typeof header !== 'object' ||
    Array.isArray(header) ||
    !claims ||
    typeof claims !== 'object' ||
    Array.isArray(claims)
  ) {
    return { problem: 'unreadable' };
  }
  const jwk = header.jwk;
  if (header.typ !== 'dpop+jwt' || header.alg !== 'EdDSA' || header.kid !== undefined) {
    return { problem: 'header' };
  }
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || 'd' in jwk) {
    return { problem: 'jwk' };
  }
  try {
    if (
      !verify(
        null,
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }),
        Buffer.from(parts[2], 'base64url'),
      )
    ) {
      return { problem: 'signature' };
    }
  } catch {
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

/**
 * `tokens` shares another fake's token store, as an ML region accepts the tokens the cloud's token
 * endpoint issued on its own origin.
 */
export const startFakeCloud = async ({
  tokens,
  listenHost = '127.0.0.1',
  listenPort = 0,
  advertisedHost = '127.0.0.1',
}: {
  tokens?: Set<string>;
  /** Explicit test-only listener/address for a caller in an isolated container. */
  listenHost?: string;
  listenPort?: number;
  advertisedHost?: string;
} = {}): Promise<FakeCloud> => {
  const mintedTokens = tokens ?? new Set<string>();
  const fake = {
    requests: [],
    routes: new Map(),
    nonce: null,
    refusals: [],
    tokens: mintedTokens,
  } as unknown as FakeCloud;
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
      tokens: mintedTokens,
    };
    fake.requests.push(request);
    const send = ({ status, body: payload, raw, headers }: FakeCloudAnswer) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(raw ?? (payload === undefined ? '' : JSON.stringify(payload)));
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
  server.listen(listenPort, listenHost);
  await once(server, 'listening');
  fake.url = `http://${advertisedHost}:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
};

type FakeKey = { kty: 'OKP'; crv: 'Ed25519'; x: string };
/** One server as the fake Cloud knows it. `home` and `remote` are the addresses it lists in grants. */
export type FakeHouseholdServer = {
  instanceId: string;
  name: string;
  key: FakeKey;
  /** A live Server licence. */
  licensed: boolean;
  /** The owner's remote access plan: without it only `home` is listed. */
  plan: boolean;
  home: string | null;
  remote: string | null;
};
type FakeHouseholdLink = {
  id: string;
  a: string;
  b: string;
  createdAt: string;
  endedAt: string | null;
  endedBy: string | null;
};

/**
 * `/v1/households/*` as Frameleaf Cloud serves it (FL-928 contracts, mirrored in `src/utils/frameleaf-household.ts`):
 * invitations, links, five-minute grants signed with a real Ed25519 key, `grants/verify` and the JWKS. The caller is
 * the registered server whose key signed the request's DPoP proof, which the fake cloud has already verified. Specs
 * change `servers` and `links` directly (a lapsed licence, a plan, an ended link) and may replace any route.
 */
export const addHouseholdRoutes = (cloud: FakeCloud) => {
  const signer = generateKeyPairSync('ed25519');
  const kid = 'household-fixture';
  const jwks = { keys: [{ ...(signer.publicKey.export({ format: 'jwk' }) as FakeKey), kid }] };
  const servers = new Map<string, FakeHouseholdServer>();
  const links = new Map<string, FakeHouseholdLink>();
  /** Keyed by the 43-character token and by the short code without its dashes. */
  const invitations = new Map<string, { instanceId: string; used: boolean }>();
  const invitationKey = (value: unknown) => {
    const text = String(value).replaceAll(/\s/g, '');
    return text.length === 43 ? text : text.replaceAll('-', '').toUpperCase();
  };
  const grants = new Map<string, Record<string, any>>();
  const issuer = () => `${cloud.url}/api`;

  const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => ({
    status,
    body: { code, message, retryable: false, ...extra },
  });
  const denied = (detail?: string) =>
    refuse(403, 'forbidden', 'This household link is not available to this server.', detail ? { detail } : {});
  const unlicensed = (instanceId: string) =>
    refuse(403, 'entitlement-missing', 'Both servers need a Server licence to link households.', {
      data: { instanceId },
    });
  const byId = (instanceId: string) => servers.values().find((server) => server.instanceId === instanceId);
  const view = (link: FakeHouseholdLink, self: FakeHouseholdServer) => {
    const peerId = link.a === self.instanceId ? link.b : link.a;
    const peer = byId(peerId);
    return {
      version: 1,
      linkId: link.id,
      state: link.endedAt ? 'ended' : 'active',
      peerInstanceId: peerId,
      peerName: peer?.name ?? '',
      peerPublicKey: peer?.key ?? null,
      createdAt: link.createdAt,
      endedAt: link.endedAt,
      endedByInstanceId: link.endedBy,
    };
  };
  const connection = (uri: string, local: boolean) => {
    const url = new URL(uri);
    return {
      kind: local ? 'local' : 'wan',
      uri,
      protocol: url.protocol.slice(0, -1),
      address: url.hostname,
      port: Number(url.port) || 443,
      local,
      relay: false,
      ipv6: false,
      custom: false,
      dnsRebindingProtection: false,
      httpsRequired: true,
      verified: !local,
    };
  };
  /** A compact JWS signed by the fake Cloud's grant key, for specs that need a grant Cloud would not issue. */
  const signGrant = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'EdDSA', typ: 'household-grant+jwt', kid, ...header })}.${encode(claims)}`;
    return `${input}.${sign(null, Buffer.from(input), signer.privateKey).toString('base64url')}`;
  };
  const grantClaims = (link: FakeHouseholdLink, source: FakeHouseholdServer, destination: FakeHouseholdServer) => {
    const iat = Math.floor(Date.now() / 1000);
    return {
      version: 1,
      iss: issuer(),
      aud: 'frameleaf-household',
      sub: source.instanceId,
      jti: randomUUID(),
      iat,
      exp: iat + 300,
      linkId: link.id,
      sourceInstanceId: source.instanceId,
      destinationInstanceId: destination.instanceId,
      cnf: { jkt: ed25519Thumbprint(source.key), jwk: source.key },
      destinationKey: destination.key,
    };
  };

  const guarded = (
    route: string,
    handler: (request: FakeCloudRequest, server: FakeHouseholdServer) => FakeCloudAnswer,
  ) =>
    cloud.on(route, (request) => {
      const server = request.dpop && dpopTokenOf(request) ? servers.get(request.dpop.jkt) : undefined;
      return server
        ? handler(request, server)
        : refuse(401, 'instance_revoked', "This server isn't linked to Frameleaf Cloud any more.");
    });
  const end = (link: FakeHouseholdLink, by: string) => {
    link.endedAt ??= new Date().toISOString();
    link.endedBy ??= by;
  };

  cloud.on('POST /id/token', (request) => tokenAnswer(request));
  cloud.on('GET /v1/households/jwks', () => ({ status: 200, body: jwks }));
  guarded('POST /v1/households/invitations', (_request, server) => {
    if (!server.licensed) {
      return unlicensed(server.instanceId);
    }
    const token = randomBytes(32).toString('base64url');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const short = [...randomBytes(12)].map((byte) => alphabet[byte % alphabet.length]).join('');
    const code = `${short.slice(0, 4)}-${short.slice(4, 8)}-${short.slice(8)}`;
    const invitation = { instanceId: server.instanceId, used: false };
    invitations.set(token, invitation);
    invitations.set(short, invitation);
    // the token, or the code as shown, without its dashes, or typed in lower case
    for (const form of [token, code, short, code.toLowerCase(), short.toLowerCase()]) {
      guarded(`GET /v1/households/invitations/${form}`, () =>
        invitation.used
          ? refuse(410, 'invitation_gone', 'This invitation has expired or was used.')
          : {
              status: 200,
              body: { version: 1, instanceId: server.instanceId, name: server.name, publicKey: server.key },
            },
      );
    }
    return {
      status: 201,
      body: {
        version: 1,
        invitationId: randomUUID(),
        token,
        code,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
    };
  });
  guarded('POST /v1/households/invitations/accept', (request, server) => {
    const invitation = invitations.get(invitationKey(request.json().token));
    const inviter = invitation && byId(invitation.instanceId);
    if (!invitation || invitation.used || !inviter) {
      return refuse(410, 'invitation_gone', 'This invitation has expired or was used.');
    }
    if (invitation.instanceId === server.instanceId) {
      return refuse(422, 'request-invalid', "A server can't be linked with itself.");
    }
    const without = [server, inviter].find((each) => !each.licensed);
    if (without) {
      return unlicensed(without.instanceId);
    }
    invitation.used = true;
    const link: FakeHouseholdLink = {
      id: randomUUID(),
      a: inviter.instanceId,
      b: server.instanceId,
      createdAt: new Date().toISOString(),
      endedAt: null,
      endedBy: null,
    };
    links.set(link.id, link);
    guarded(`POST /v1/households/links/${link.id}/end`, (_request, caller) => {
      if (![link.a, link.b].includes(caller.instanceId)) {
        return denied();
      }
      end(link, caller.instanceId);
      return { status: 200, body: view(link, caller) };
    });
    return { status: 201, body: view(link, server) };
  });
  guarded('GET /v1/households/links', (_request, server) => ({
    status: 200,
    body: {
      version: 1,
      links: links
        .values()
        .filter((link) => [link.a, link.b].includes(server.instanceId))
        .map((link) => view(link, server))
        .toArray(),
    },
  }));
  guarded('POST /v1/households/grants', (request, server) => {
    const link = links.get(request.json().linkId);
    if (!link || ![link.a, link.b].includes(server.instanceId)) {
      return denied();
    }
    if (link.endedAt) {
      return denied('link-ended');
    }
    const destination = byId(link.a === server.instanceId ? link.b : link.a);
    if (!destination) {
      return denied('peer-unavailable');
    }
    const without = [server, destination].find((each) => !each.licensed);
    if (without) {
      return unlicensed(without.instanceId);
    }
    const claims = grantClaims(link, server, destination);
    const token = signGrant(claims);
    grants.set(token, claims);
    return {
      status: 200,
      body: {
        version: 1,
        token,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        claims,
        connections: [
          ...(destination.home ? [connection(destination.home, true)] : []),
          ...(destination.plan && destination.remote ? [connection(destination.remote, false)] : []),
        ],
      },
    };
  });
  guarded('POST /v1/households/grants/verify', (request, server) => {
    const claims = grants.get(request.json().token);
    const link = claims && links.get(claims.linkId);
    if (!claims || !link || claims.exp * 1000 <= Date.now()) {
      return refuse(401, 'invalid_token', 'This household grant is invalid or expired.');
    }
    if (claims.destinationInstanceId !== server.instanceId) {
      return denied();
    }
    if (link.endedAt) {
      return denied('link-ended');
    }
    return { status: 200, body: { version: 1, claims } };
  });

  return { servers, links, grants, issuer, signGrant, grantClaims, end, byId };
};
