import { CookieOptions, Response } from 'express';
import { Writable } from 'node:stream';
import { CookieResponse } from 'src/dtos/auth.dto.js';
import { ImmichCookie } from 'src/enum.js';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const AUTH_COOKIE_MAX_AGE = 400 * DAY_IN_MILLISECONDS;

export class ClientDisconnectedError extends Error {}

export const waitForDrain = (response: Writable) =>
  new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
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
    response.once('error', onError);

    // 'close' may already have fired
    if (response.destroyed) {
      onClose();
    }
  });

export const respondWithCookie = <T>(res: Response, body: T, { isSecure, values, rememberMe }: CookieResponse) => {
  const defaults: CookieOptions = {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: isSecure,
    maxAge: AUTH_COOKIE_MAX_AGE,
  };

  const authentication = { ...defaults, maxAge: rememberMe === false ? undefined : defaults.maxAge };

  const cookieOptions: Record<ImmichCookie, CookieOptions> = {
    [ImmichCookie.AuthType]: authentication,
    [ImmichCookie.AccessToken]: authentication,
    [ImmichCookie.MaintenanceToken]: { ...defaults, maxAge: DAY_IN_MILLISECONDS },
    [ImmichCookie.OAuthState]: defaults,
    [ImmichCookie.OAuthCodeVerifier]: defaults,
    // no httpOnly so that the client can know the auth state
    [ImmichCookie.IsAuthenticated]: { ...authentication, httpOnly: false },
    [ImmichCookie.SharedLinkToken]: { ...defaults, maxAge: DAY_IN_MILLISECONDS },
  };

  for (const { key, value } of values) {
    const options = cookieOptions[key];
    res.cookie(key, value, options);
  }
  if (values.some(({ key }) => key === ImmichCookie.AccessToken)) {
    clearBrowserCache(res);
  }

  return body;
};

export const respondWithoutCookie = <T>(res: Response, body: T, cookies: ImmichCookie[]) => {
  for (const cookie of cookies) {
    res.clearCookie(cookie);
  }
  if (cookies.includes(ImmichCookie.AccessToken)) {
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
