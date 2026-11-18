export declare const base64url: (input: Uint8Array | string) => string;
export declare const ed25519Thumbprint: (jwk: {
    crv: string;
    kty: string;
    x: string;
}) => string;
export type Ed25519PublicJwk = {
    kty: 'OKP';
    crv: 'Ed25519';
    x: string;
};
export type FrameleafKeySigner = {
    kid: string;
    publicJwk: Ed25519PublicJwk;
    sign: (header: Record<string, unknown>, payload: Record<string, unknown>) => string;
    signBytes?: (data: Buffer) => Buffer;
};
export declare const DPOP_NONCE_HEADER = "dpop-nonce";
export declare const USE_DPOP_NONCE = "use_dpop_nonce";
export declare const isUsableNonce: (value: string | null | undefined) => value is string;
export declare const dpopHtu: (url: string) => string;
export declare const dpopAth: (accessToken: string) => string;
export declare const createDpopProof: (signer: FrameleafKeySigner, request: {
    htm: string;
    htu: string;
    nonce?: string;
    accessToken?: string;
}, now?: number) => string;
export declare const signClientAssertion: (signer: FrameleafKeySigner, claims: Record<string, unknown>) => string;
export declare const isNonceChallenge: (status: number, code: string | null | undefined, wwwAuthenticate: string | null | undefined) => boolean;
export declare const boundTokenProblem: (response: {
    access_token: string;
    token_type?: string;
}, signer: Pick<FrameleafKeySigner, "kid">) => string | null;
export declare const jwsSigningInput: (header: Record<string, unknown>, payload: Record<string, unknown>) => string;
