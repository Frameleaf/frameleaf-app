import { PassThrough, type Readable, pipeline } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrokerAccessToken } from 'src/import-connectors/broker-sign-in.js';
import { RemoteSourceAuthError, RemoteSourceError } from 'src/import-connectors/remote-source.js';

/**
 * The request loop OneDrive and Google Drive share (FL-972, FL-974), with the rules Dropbox set: a
 * refused token is renewed once, rate limits and passing failures are retried a bounded number of
 * times, `Retry-After` holds every request of the account, and redirects are never followed. What a
 * provider says in an error is never passed on.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_STALL_MS = 3 * 60_000;
/** Tries of one request through rate limits and passing failures. */
const MAX_ATTEMPTS = 6;
/** The longest wait the job sits through. A longer one fails the request and the pause still holds. */
const MAX_WAIT_MS = 15 * 60_000;

export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>;
export type ProviderHttpOptions = {
  http?: ProviderFetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};
export type ProviderSendOptions = {
  /** A download: its body outlives the request deadline and is watched for stalls instead. */
  stream?: boolean;
  /** False for a pre-signed address, which must never receive the account's token. */
  authorized?: boolean;
  /** Whether an answer that is not a 429 is still the provider asking to slow down. */
  limited?: (response: Response) => Promise<boolean>;
};

/** Until when a provider asked an account to wait: every source of that account in this process honours it. */
const pausedUntil = new Map<string, number>();
export const forgetProviderPauses = () => pausedUntil.clear();

export const discard = async (response: Response) => {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing more is wanted from this answer.
  }
};

/** `Retry-After` in seconds or as an HTTP date; undefined when it is absent or unreadable. */
export const retryAfterMs = (header: string | null, now: number) => {
  const value = header?.trim();
  if (!value) {
    return;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

/** Fails a download that stops sending, which would otherwise hold its job for ever. */
export const watchedDownload = (body: Readable, label: string) => {
  let timer: NodeJS.Timeout | undefined;
  const output = new PassThrough();
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => output.destroy(new RemoteSourceError(`${label} stopped sending the file`)),
      DOWNLOAD_STALL_MS,
    );
    timer.unref();
  };
  const counter = new PassThrough();
  counter.on('data', arm);
  arm();
  pipeline(body, counter, output, () => clearTimeout(timer));
  return output;
};

export class ProviderHttp {
  private http: ProviderFetch;
  private wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private now: () => number;
  private pauseKey: string;

  constructor(
    private label: string,
    private tokens: Pick<BrokerAccessToken, 'get'>,
    accountId: string,
    options: ProviderHttpOptions = {},
  ) {
    this.http = options.http ?? ((url, init) => fetch(url, init));
    this.wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }).then(() => {}));
    this.now = options.now ?? Date.now;
    this.pauseKey = `${label}:${accountId}`;
  }

  private async honourPause(signal: AbortSignal) {
    const until = pausedUntil.get(this.pauseKey);
    if (until === undefined) {
      return;
    }
    const remaining = until - this.now();
    if (remaining <= 0) {
      pausedUntil.delete(this.pauseKey);
      return;
    }
    if (remaining > MAX_WAIT_MS) {
      throw new RemoteSourceError(`${this.label} asked Frameleaf to slow down. Try again later.`);
    }
    await this.wait(remaining, signal);
  }

  private pause(response: Response, attempt: number) {
    const delay = retryAfterMs(response.headers.get('retry-after'), this.now()) ?? 2 ** attempt * 1000;
    const until = this.now() + delay;
    pausedUntil.set(this.pauseKey, Math.max(until, pausedUntil.get(this.pauseKey) ?? 0));
  }

  async send(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    { stream = false, authorized = true, limited }: ProviderSendOptions = {},
  ): Promise<Response> {
    let refused: string | undefined;
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      await this.honourPause(signal);
      const token = authorized ? await this.tokens.get(refused) : undefined;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.http(url, {
          ...init,
          headers: { ...init.headers, ...(token && { Authorization: `Bearer ${token}` }) },
          // A redirect comes back as an answer: nothing is sent to an address that was not checked.
          redirect: 'manual',
          signal: stream
            ? AbortSignal.any([signal, deadline.signal])
            : AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch {
        signal.throwIfAborted();
        if (attempt >= MAX_ATTEMPTS) {
          throw new RemoteSourceError(`${this.label} could not be reached`);
        }
        await this.wait(2 ** attempt * 1000, signal);
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 401 && authorized) {
        await discard(response);
        if (refused) {
          throw new RemoteSourceAuthError(`${this.label} no longer accepts this sign-in. Sign in again.`);
        }
        refused = token;
        continue;
      }
      const slowDown = response.status === 429 || (!!limited && (await limited(response)));
      if (slowDown || response.status >= 500) {
        const paused = slowDown || response.headers.has('retry-after');
        if (paused) {
          this.pause(response, attempt);
        }
        await discard(response);
        if (attempt >= MAX_ATTEMPTS) {
          throw new RemoteSourceError(
            paused
              ? `${this.label} asked Frameleaf to slow down. Try again later.`
              : `${this.label} is not answering right now`,
          );
        }
        if (!paused) {
          await this.wait(2 ** attempt * 1000, signal);
        }
        continue;
      }
      return response;
    }
  }
}
