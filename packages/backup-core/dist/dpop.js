import { createHash, randomUUID } from 'node:crypto';
export const base64url = (input) => Buffer.from(input).toString('base64url');
export const ed25519Thumbprint = (jwk) => createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest('base64url');
export const DPOP_NONCE_HEADER = 'dpop-nonce';
export const USE_DPOP_NONCE = 'use_dpop_nonce';
const MAX_NONCE_LENGTH = 512;
export const isUsableNonce = (value) => {
    if (!value || value.length > MAX_NONCE_LENGTH) {
        return false;
    }
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x21 || code > 0x7e || code === 0x22 || code === 0x5c) {
            return false;
        }
    }
    return true;
};
export const dpopHtu = (url) => {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
};
export const dpopAth = (accessToken) => createHash('sha256').update(accessToken, 'ascii').digest('base64url');
export const createDpopProof = (signer, request, now = Date.now()) => {
    const { kty, crv, x } = signer.publicJwk;
    return signer.sign({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: { kty, crv, x } }, {
        jti: randomUUID(),
        htm: request.htm.toUpperCase(),
        htu: dpopHtu(request.htu),
        iat: Math.floor(now / 1000),
        ...(request.nonce && { nonce: request.nonce }),
        ...(request.accessToken && { ath: dpopAth(request.accessToken) }),
    });
};
export const signClientAssertion = (signer, claims) => signer.sign({ alg: 'EdDSA', typ: 'JWT', kid: signer.kid }, claims);
export const isNonceChallenge = (status, code, wwwAuthenticate) => {
    if (status !== 400 && status !== 401) {
        return false;
    }
    if (code === USE_DPOP_NONCE) {
        return true;
    }
    return /(?:^|[\s,])error\s*=\s*(?:"use_dpop_nonce"|use_dpop_nonce(?=[\s,;]|$))/i.test(wwwAuthenticate ?? '');
};
export const boundTokenProblem = (response, signer) => {
    if (response.token_type?.toLowerCase() !== 'dpop') {
        return `the token type is ${response.token_type ?? 'missing'}, not DPoP`;
    }
    let claims;
    try {
        const [, payload] = response.access_token.split('.', 3);
        claims = payload ? JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) : null;
    }
    catch {
        claims = null;
    }
    if (!claims || typeof claims !== 'object') {
        return 'the token is not a JWT this server can read';
    }
    const jwtClaims = claims;
    if (jwtClaims.cnf?.jkt !== signer.kid) {
        return 'the token is not bound to this server’s key (cnf.jkt)';
    }
    if (jwtClaims.frameleaf_kid !== undefined && jwtClaims.frameleaf_kid !== signer.kid) {
        return 'the token was minted for another key of this server (frameleaf_kid)';
    }
    return null;
};
export const jwsSigningInput = (header, payload) => `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
