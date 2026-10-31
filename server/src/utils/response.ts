import { CookieOptions, Response } from 'express';
import { OutgoingHttpHeaders, STATUS_CODES, ServerResponse, validateHeaderName, validateHeaderValue } from 'node:http';
import { Writable } from 'node:stream';
import { CookieResponse } from 'src/dtos/auth.dto.js';
import { AuthCookie } from 'src/enum.js';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const AUTH_COOKIE_MAX_AGE = 400 * DAY_IN_MILLISECONDS;

export class ClientDisconnectedError extends Error {}

export const waitForDrain = (response: Writable) =>
  new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('finish', onClose);
      response.off('error', onError);
    };

    const onDrain = () => {
      cleanup();
      resolve();
    };

    const onClose = () => {
      cleanup();
      reject(new ClientDisconnectedError());
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('finish', onClose);
    response.once('error', onError);

    // A terminal event may already have fired.
    if (response.destroyed || response.writableEnded) {
      onClose();
    }
  });

type InformationResponse = ServerResponse & {
  writeInformation?: (statusCode: number, headers: OutgoingHttpHeaders) => void;
  _writeRaw: (data: string, encoding: BufferEncoding) => void;
};

/** Sends a 1xx interim response. Node 22 has no public writeInformation, so it writes the head as writeEarlyHints does. */
export const writeInformation = (response: ServerResponse, statusCode: number, headers: OutgoingHttpHeaders) => {
  const target = response as InformationResponse;
  if (target.writeInformation) {
    target.writeInformation(statusCode, headers);
    return;
  }
  let head = `HTTP/1.1 ${statusCode} ${STATUS_CODES[statusCode] ?? ''}\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    for (const item of [value ?? []].flat()) {
      validateHeaderName(name);
      validateHeaderValue(name, String(item));
      head += `${name}: ${item}\r\n`;
    }
  }
  target._writeRaw(head + '\r\n', 'latin1');
};

export const respondWithCookie = <T>(res: Response, body: T, { isSecure, values, rememberMe }: CookieResponse) => {
  const defaults: CookieOptions = {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: isSecure,
    maxAge: AUTH_COOKIE_MAX_AGE,
  };

  const authentication = { ...defaults, maxAge: rememberMe === false ? undefined : defaults.maxAge };

  const cookieOptions: Record<AuthCookie, CookieOptions> = {
    [AuthCookie.AuthType]: authentication,
    [AuthCookie.AccessToken]: authentication,
    [AuthCookie.MaintenanceToken]: { ...defaults, maxAge: DAY_IN_MILLISECONDS },
    [AuthCookie.OAuthState]: defaults,
    [AuthCookie.OAuthCodeVerifier]: defaults,
    // no httpOnly so that the client can know the auth state
    [AuthCookie.IsAuthenticated]: { ...authentication, httpOnly: false },
    [AuthCookie.SharedLinkToken]: { ...defaults, maxAge: DAY_IN_MILLISECONDS },
  };

  for (const { key, value } of values) {
    const options = cookieOptions[key];
    res.cookie(key, value, options);
  }
  if (values.some(({ key }) => key === AuthCookie.AccessToken)) {
    clearBrowserCache(res);
  }

  return body;
};

export const respondWithoutCookie = <T>(res: Response, body: T, cookies: AuthCookie[]) => {
  for (const cookie of cookies) {
    res.clearCookie(cookie);
  }
  if (cookies.includes(AuthCookie.AccessToken)) {
    clearBrowserCache(res);
  }

  return body;
};

/**
 * FL-137: whenever someone signs in or out, the browser drops every response it cached for this server.
 * Thumbnails and originals are cached privately for a day (`CacheControl.PrivateWithCache`), and on a
 * shared browser the next person signed in must never be answered from the previous person's cache.
 */
const clearBrowserCache = (res: Response) => {
  res.setHeader('Clear-Site-Data', '"cache"');
};
