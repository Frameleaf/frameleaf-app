// S3 for tests. Also used by Manager's Server Backup tests.
import { createHash, randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Enough of S3 to be honest: objects, ranges, paged listing, multipart, and refusals on demand. */
export function standIn(options: { bucket?: string; accessKeyId?: string } = {}) {
  const bucketName = options.bucket ?? 'bucket';
  const accessKeyId = options.accessKeyId ?? 'key';
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer[]>();
  const seen: { method: string; path: string; query: string; token: string | undefined }[] = [];
  const forced: { status: number; code: string }[] = [];
  const state = {
    objects,
    uploads,
    seen,
    forced,
    server: undefined as Server | undefined,
    /** Refuses the requests it picks, every time, until cleared. */
    refuseWhen: undefined as ((query: string) => { status: number; code: string } | undefined) | undefined,
  };
  const xml = (response: import('node:http').ServerResponse, status: number, body: string, headers = {}) => {
    response.writeHead(status, { 'content-type': 'application/xml', ...headers });
    response.end(body);
  };
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    try {
      for await (const part of request) {
        parts.push(part as Buffer);
      }
    } catch {
      // The sender went away mid-request, as a stopped run does.
      return;
    }
    const body = Buffer.concat(parts);
    const url = new URL(request.url!, 'http://stand-in');
    seen.push({
      method: request.method!,
      path: url.pathname,
      query: url.search,
      token: request.headers['x-amz-security-token'] as string | undefined,
    });
    const refusal = state.refuseWhen?.(url.search) ?? forced.shift();
    if (refusal) {
      return xml(response, refusal.status, `<Error><Code>${refusal.code}</Code></Error>`);
    }
    if (
      !request.headers.authorization?.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKeyId}/`) ||
      request.headers['x-amz-content-sha256'] !== sha256(body)
    ) {
      return xml(response, 403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
    }
    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
    const key = rest.join('/');
    if (bucket !== bucketName) {
      return xml(response, 404, '<Error><Code>NoSuchBucket</Code></Error>');
    }
    const query = url.searchParams;
    if (request.method === 'GET' && !key) {
      const keys = [...objects.keys()].filter((name) => name.startsWith(query.get('prefix') ?? '')).sort();
      const from = Number(query.get('continuation-token') ?? 0);
      const page = keys.slice(from, from + 2);
      const more = from + 2 < keys.length;
      return xml(
        response,
        200,
        `<ListBucketResult><IsTruncated>${more}</IsTruncated>${page
          .map(
            (name) =>
              `<Contents><Key>${name}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>${objects.get(name)!.length}</Size></Contents>`,
          )
          .join('')}${more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ''}</ListBucketResult>`,
      );
    }
    const uploadId = query.get('uploadId');
    if (request.method === 'POST' && query.has('uploads')) {
      const id = randomBytes(6).toString('hex');
      uploads.set(id, []);
      return xml(
        response,
        200,
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (request.method === 'PUT' && uploadId) {
      uploads.get(uploadId)![Number(query.get('partNumber')) - 1] = body;
      return xml(response, 200, '', { etag: `"${sha256(body).slice(0, 8)}"` });
    }
    if (request.method === 'POST' && uploadId) {
      objects.set(key, Buffer.concat(uploads.get(uploadId)!));
      uploads.delete(uploadId);
      return xml(response, 200, '<CompleteMultipartUploadResult></CompleteMultipartUploadResult>', {
        'x-amz-version-id': `version-of-${key}`,
      });
    }
    if (request.method === 'DELETE' && uploadId) {
      uploads.delete(uploadId);
      return xml(response, 204, '');
    }
    if (request.method === 'PUT') {
      objects.set(key, body);
      return xml(response, 200, '', { etag: '"whole"', 'x-amz-version-id': `version-of-${key}` });
    }
    if (request.method === 'DELETE') {
      objects.delete(key);
      return xml(response, 204, '');
    }
    const stored = objects.get(key);
    if (!stored) {
      return xml(response, 404, '<Error><Code>NoSuchKey</Code></Error>');
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    const slice = !range
      ? stored
      : range[1] === ''
        ? stored.subarray(Math.max(0, stored.length - Number(range[2])))
        : stored.subarray(Number(range[1]), Number(range[2]) + 1);
    response.writeHead(range ? 206 : 200);
    response.end(slice);
  });
  state.server = server;
  return state as typeof state & { server: Server };
}
