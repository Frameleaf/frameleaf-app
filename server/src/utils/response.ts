import { CookieOptions, Response } from 'express';
import { Duration } from 'luxon';
import { Writable } from 'node:stream';
import { CookieResponse } from 'src/dtos/auth.dto.js';
import { ImmichCookie } from 'src/enum.js';

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
    maxAge: Duration.fromObject({ days: 400 }).toMillis(),
  };

  const authentication = { ...defaults, maxAge: rememberMe === false ? undefined : defaults.maxAge };

  const cookieOptions: Record<ImmichCookie, CookieOptions> = {
    [ImmichCookie.AuthType]: authentication,
    [ImmichCookie.AccessToken]: authentication,
    [ImmichCookie.MaintenanceToken]: { ...defaults, maxAge: Duration.fromObject({ days: 1 }).toMillis() },
    [ImmichCookie.OAuthState]: defaults,
    [ImmichCookie.OAuthCodeVerifier]: defaults,
    // no httpOnly so that the client can know the auth state
    [ImmichCookie.IsAuthenticated]: { ...authentication, httpOnly: false },
    [ImmichCookie.SharedLinkToken]: { ...defaults, maxAge: Duration.fromObject({ days: 1 }).toMillis() },
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
