import type { Request } from 'express';
import { requestHasTrustedTls, requestVia } from 'src/middleware/frameleaf-via.middleware.js';
import { isRemoteVia } from 'src/utils/frameleaf-sign-in.js';

const HOST =
  /^(?:[a-z\d](?:[a-z\d-]{0,62}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,62}[a-z\d])?)*|\[[\da-f:.]+\])(?::\d{1,5})?$/i;

/**
 * FL-803: the issuer, built from the address the request used, because an app checks that the
 * metadata it found names the server it asked (RFC 8414 §3.3). The Host header is checked for shape
 * only; it can change no one's response but the requester's own, and every token, code and return
 * address is checked on its own. Remote access (relay or direct) is always https.
 */
export const oauthIssuer = (request: Request, trustedTransportOnly = false) => {
  const host = request.headers.host ?? '';
  const safeHost = HOST.test(host) ? host.toLowerCase() : 'localhost';
  const forwardedProto = request.headers['x-forwarded-proto'];
  const https = trustedTransportOnly
    ? requestHasTrustedTls(request)
    : request.secure ||
      isRemoteVia(requestVia(request)) ||
      (typeof forwardedProto === 'string' && forwardedProto.split(',', 1)[0].trim() === 'https');
  return new URL(`${https ? 'https' : 'http'}://${safeHost}`).origin;
};
