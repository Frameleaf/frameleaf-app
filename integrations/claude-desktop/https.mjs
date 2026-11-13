import { message } from './messages.mjs';
import { getCACertificates } from 'node:tls';
import { Agent, fetch } from 'undici';
import { AdapterError } from './oauth.mjs';

export function libraryHttps(resource) {
  const dispatcher = new Agent({
    connect: {
      ca: [...new Set([...getCACertificates('default'), ...getCACertificates('system')])],
      rejectUnauthorized: true,
    },
  });

  return {
    fetch(url, options) {
      if (new URL(url).origin !== resource.origin) {
        throw new AdapterError(message('unexpectedAddress'));
      }
      return fetch(url, { ...options, dispatcher, redirect: 'error' });
    },
    close: () => dispatcher.close(),
  };
}
