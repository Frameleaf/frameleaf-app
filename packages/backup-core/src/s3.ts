import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ByteRange, Store, StoredObject } from './store.js';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3Options {
  /** The provider's address, used path-style: `<endpoint>/<bucket>/<key>`. */
  endpoint: string;
  region: string;
  bucket: string;
  /** Put in front of every object name, for example `r/v1/<vault>/`. */
  prefix?: string;
  /**
   * Asked before every request, so credentials that last minutes serve runs that last days.
   * `renew` is true when the provider has just said the last ones expired.
   */
  credentials: (renew: boolean) => Promise<S3Credentials>;
  /** Bytes per second to send at most, or null for no limit. Read as the upload goes, so it can change mid-run. */
  uploadLimit?: () => number | null;
  /** Waits between tries after a network error, 429 or 5xx. */
  retryDelaysMs?: number[];
  /** Objects larger than this are sent as multipart uploads in parts of this size. */
  partSize?: number;
  /** A connection that sends and receives nothing for this long is given up on. */
  idleTimeoutMs?: number;
}

export class S3Error extends Error {
  override name = 'S3Error';
  constructor(
    message: string,
    /** Null when the provider could not be reached at all. */
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
  }
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const SLICE = 64 * 1024;
const EXPIRED = new Set(['ExpiredToken', 'InvalidToken', 'RequestExpired', 'InvalidAccessKeyId']);

const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const encode = (value: string) =>
  encodeURIComponent(value).replaceAll(/[!'()*]/g, (char) => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`);
const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? null;

/**
 * AWS Signature Version 4 for S3: the headers to send, without `host`.
 * A copy of the photo server's `signS3Request`, checked against the same AWS example; the server's
 * copy goes when the server uses this package.
 */
export function signS3Request(request: {
  method: string;
  host: string;
  canonicalUri: string;
  query: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now: Date;
}): Record<string, string> {
  const amzDate = request.now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = request.body ? sha256Hex(request.body) : EMPTY_SHA256;
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value])),
    host: request.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(request.sessionToken ? { 'x-amz-security-token': request.sessionToken } : {}),
  };
  const signedNames = Object.keys(headers).toSorted(byCodeUnits);
  const canonicalRequest = [
    request.method,
    request.canonicalUri,
    request.query,
    signedNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join(''),
    signedNames.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${request.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${request.secretAccessKey}`, dateStamp), request.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const { host: _host, ...sent } = headers;
  sent.authorization = `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
  return sent;
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** A repository in an S3 bucket: Wasabi through Frameleaf Cloud, or a bucket the owner brings. */
export function s3Store(options: S3Options): Store {
  const endpoint = new URL(options.endpoint);
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const prefix = options.prefix ?? '';
  const retryDelays = options.retryDelaysMs ?? [1000, 4000];
  const partSize = options.partSize ?? 8 * 1024 * 1024;
  const idleTimeout = options.idleTimeoutMs ?? 60_000;

  /** One request on the wire. The body goes out in slices, held back to the speed limit. */
  const exchange = (url: URL, method: string, headers: Record<string, string>, body?: Buffer) =>
    new Promise<Answer>((resolve, reject) => {
      const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        { method, headers: body ? { ...headers, 'content-length': String(body.length) } : headers },
        (incoming) => {
          const parts: Buffer[] = [];
          incoming.on('data', (part: Buffer) => parts.push(part));
          incoming.on('error', reject);
          incoming.on('end', () =>
            resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(parts) }),
          );
        },
      );
      outgoing.setTimeout(idleTimeout, () => outgoing.destroy(new Error('The connection went quiet')));
      outgoing.on('error', reject);
      if (!body) {
        outgoing.end();
        return;
      }
      const started = Date.now();
      let allowance = 0;
      (async () => {
        for (let at = 0; at < body.length; at += SLICE) {
          const slice = body.subarray(at, at + SLICE);
          if (!outgoing.write(slice)) {
            await once(outgoing, 'drain');
          }
          const limit = options.uploadLimit?.();
          if (limit && limit > 0) {
            // Each slice earns the time it should have taken; sleeping off the surplus holds the average.
            allowance += (slice.length / limit) * 1000;
            const ahead = started + allowance - Date.now();
            if (ahead > 0) {
              await sleep(ahead);
            }
          } else {
            allowance = Date.now() - started;
          }
        }
        outgoing.end();
      })().catch((error: Error) => outgoing.destroy(error));
    });

  const sendOnce = async (
    renew: boolean,
    method: string,
    key: string | null,
    query: Record<string, string>,
    headers: Record<string, string>,
    body?: Buffer,
  ) => {
    const objectPath = key === null ? '' : `/${(prefix + key).split('/').map(encode).join('/')}`;
    const canonicalUri = `${basePath}/${encode(options.bucket)}${objectPath || '/'}`;
    const queryString = Object.entries(query)
      .map(([name, value]) => [encode(name), encode(value)] as const)
      .toSorted(([a, aValue], [b, bValue]) => byCodeUnits(a, b) || byCodeUnits(aValue, bValue))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');
    const credentials = await options.credentials(renew);
    const signed = signS3Request({
      method,
      host: endpoint.host,
      canonicalUri,
      query: queryString,
      headers,
      body,
      region: options.region,
      now: new Date(),
      ...credentials,
    });
    const what = `${method} ${key ?? 'the bucket'}`;
    let answer: Answer;
    try {
      answer = await exchange(
        new URL(`${endpoint.origin}${canonicalUri}${queryString ? `?${queryString}` : ''}`),
        method,
        signed,
        body,
      );
    } catch {
      throw new S3Error(`The storage provider could not be reached (${what})`, null, null);
    }
    if (answer.status < 200 || answer.status >= 300) {
      const code = tag(answer.body.toString(), 'Code');
      // Never a header and never a key: only the status and the provider's short code.
      throw new S3Error(
        `The storage provider refused ${what}: ${answer.status}${code ? ` ${code.replaceAll(/[^\w.-]/g, '')}` : ''}`,
        answer.status,
        code,
      );
    }
    return answer;
  };

  const send = async (
    method: string,
    key: string | null,
    query: Record<string, string> = {},
    headers: Record<string, string> = {},
    body?: Buffer,
  ) => {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await sendOnce(renewed, method, key, query, headers, body);
      } catch (error) {
        if (!(error instanceof S3Error)) {
          throw error;
        }
        // Expired credentials are asked for again once; that doesn't count as a retry.
        if (error.code && EXPIRED.has(error.code) && !renewed) {
          renewed = true;
          attempt--;
          continue;
        }
        const transient = error.status === null || error.status === 429 || error.status >= 500;
        if (!transient || attempt >= retryDelays.length) {
          throw error;
        }
        await sleep(retryDelays[attempt]);
      }
    }
  };

  const etag = (answer: Answer) => {
    const value = answer.headers.etag;
    if (typeof value !== 'string') {
      throw new S3Error('The storage provider did not confirm an upload', answer.status, null);
    }
    return value;
  };

  return {
    async put(key, body) {
      if (body.length <= partSize) {
        await send('PUT', key, {}, {}, body);
        return;
      }
      const uploadId = tag((await send('POST', key, { uploads: '' })).body.toString(), 'UploadId');
      if (!uploadId) {
        throw new S3Error('The storage provider did not start an upload', null, null);
      }
      try {
        const parts: string[] = [];
        for (let at = 0; at < body.length; at += partSize) {
          const query = { partNumber: String(parts.length + 1), uploadId };
          parts.push(etag(await send('PUT', key, query, {}, body.subarray(at, at + partSize))));
        }
        const list = parts
          .map((value, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${value}</ETag></Part>`)
          .join('');
        const done = await send(
          'POST',
          key,
          { uploadId },
          {},
          Buffer.from(`<CompleteMultipartUpload>${list}</CompleteMultipartUpload>`),
        );
        // S3 can answer 200 and still report a failure in the body.
        if (tag(done.body.toString(), 'Code')) {
          throw new S3Error(
            'The storage provider could not finish an upload',
            done.status,
            tag(done.body.toString(), 'Code'),
          );
        }
      } catch (error) {
        // Parts of an upload that never finishes are billed until removed.
        await send('DELETE', key, { uploadId }).catch(() => undefined);
        throw error;
      }
    },

    async get(key, range?: ByteRange) {
      if (range && !('suffix' in range) && range.end <= range.start) {
        return Buffer.alloc(0);
      }
      const header: Record<string, string> = !range
        ? {}
        : { range: 'suffix' in range ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end - 1}` };
      return (await send('GET', key, {}, header)).body;
    },

    async list(listPrefix) {
      const found: StoredObject[] = [];
      let token: string | null = null;
      do {
        const query: Record<string, string> = { 'list-type': '2', prefix: prefix + listPrefix };
        if (token) {
          query['continuation-token'] = token;
        }
        const xml = (await send('GET', null, query)).body.toString();
        // Object names here are letters, digits, `-`, `_` and `/`, so nothing in them needs XML decoding.
        for (const [, item] of xml.matchAll(/<Contents>(.*?)<\/Contents>/gs)) {
          const key = tag(item!, 'Key');
          if (key?.startsWith(prefix)) {
            found.push({
              key: key.slice(prefix.length),
              size: Number(tag(item!, 'Size') ?? 0),
              modified: new Date(tag(item!, 'LastModified') ?? 0),
            });
          }
        }
        token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : null;
      } while (token);
      return found;
    },

    async delete(key) {
      await send('DELETE', key);
    },
  };
}
