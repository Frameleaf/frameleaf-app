import type { NextFunction, Request, Response } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import { ImmichHeader } from 'src/enum.js';
import { type FrameleafVia, claimsFrameleafVia, frameleafVia } from 'src/utils/frameleaf-sign-in.js';

/**
 * FL-161 (instance contract "Via-header contract"): how a request reached this server.
 *
 * The edge worker proxies remote-access traffic to the API over loopback and marks each request with
 * `X-Frameleaf-Via` (`lan`, `wan` or `relay`), the visitor's `X-Forwarded-*` values and
 * `X-Frameleaf-Via-Auth`, the per-boot `FRAMELEAF_EDGE_SECRET` the supervisor handed to both
 * workers. Only a request carrying that secret is vouched for. A request that claims an arrival
 * (`X-Frameleaf-Via` or `X-Frameleaf-Via-Auth`) without the right secret is refused with 403
 * `frameleaf_via_unverified` and never treated as a home request: a misconfigured edge worker fails
 * closed instead of letting remote visitors in as if they were at home. A request with neither header
 * never went through the edge worker and is unmarked (`frameleafVia: null`). Every other
 * `X-Frameleaf-*` header a client sent is then dropped, so nothing later in the request can read a
 * claim the edge worker did not make; the one exception is `x-frameleaf-worker-session`, the render
 * worker's session credential, which this server issued and checks where it is used.
 *
 * A split deployment that runs the edge worker in another container than the API must set
 * `FRAMELEAF_EDGE_SECRET` explicitly and give both the same value; otherwise each generates its own.
 */

/** The error code of a request that claims an arrival the edge worker did not vouch for. */
export const FRAMELEAF_VIA_UNVERIFIED = 'frameleaf_via_unverified';

/**
 * Headers in the `X-Frameleaf-` namespace that clients legitimately send: credentials this server
 * issued itself, checked where they are used, never arrival claims. Everything else is dropped.
 */
const CLIENT_CREDENTIAL_HEADERS = new Set<string>([ImmichHeader.RenderWorkerSession]);

export type FrameleafForwarded = {
  /** The visitor's address as the edge worker reported it. */
  for: string | null;
  proto: string | null;
  host: string | null;
};

export type FrameleafArrival = {
  via: FrameleafVia | null;
  /** The edge worker's `X-Forwarded-*` values; only for a request it vouched for. */
  forwarded: FrameleafForwarded | null;
};

export interface FrameleafRequest extends Request {
  frameleafVia?: FrameleafVia | null;
  frameleafForwarded?: FrameleafForwarded | null;
}

const firstValue = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The hop nearest to this server: the value the edge worker added itself. */
const nearestHop = (value: string | string[] | undefined): string | null => {
  const hops = (Array.isArray(value) ? value.join(',') : (value ?? ''))
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.at(-1) ?? null;
};

/** Read the arrival from the headers as received (before they are stripped). */
export const readFrameleafArrival = (headers: IncomingHttpHeaders, edgeSecret: string | null): FrameleafArrival => {
  const via = frameleafVia(headers, edgeSecret);
  if (!via) {
    return { via: null, forwarded: null };
  }
  return {
    via,
    forwarded: {
      for: nearestHop(headers['x-forwarded-for']),
      proto: nearestHop(firstValue(headers['x-forwarded-proto'])),
      host: nearestHop(firstValue(headers['x-forwarded-host'])),
    },
  };
};

/** Drop every client-supplied `X-Frameleaf-*` header except the credentials this server issued. */
export const stripFrameleafHeaders = (headers: IncomingHttpHeaders) => {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase().startsWith('x-frameleaf-') && !CLIENT_CREDENTIAL_HEADERS.has(name.toLowerCase())) {
      delete headers[name];
    }
  }
};

/** Registered right after `cookieParser()`, before any route, guard or server-side render. */
export const frameleafViaMiddleware =
  (edgeSecret: string | null) => (request: Request, response: Response, next: NextFunction) => {
    const arrival = readFrameleafArrival(request.headers, edgeSecret);
    if (!arrival.via && claimsFrameleafVia(request.headers)) {
      response.status(403).json({
        message: 'This request claims to come through Frameleaf remote access, but the claim could not be verified',
        statusCode: 403,
        code: FRAMELEAF_VIA_UNVERIFIED,
      });
      return;
    }
    stripFrameleafHeaders(request.headers);
    const marked = request as FrameleafRequest;
    marked.frameleafVia = arrival.via;
    marked.frameleafForwarded = arrival.forwarded;
    next();
  };

/** How a request arrived, as the middleware recorded it (`null` when not vouched for). */
export const requestVia = (request: Request): FrameleafVia | null => (request as FrameleafRequest).frameleafVia ?? null;
