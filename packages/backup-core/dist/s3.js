import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
export class S3Error extends Error {
    status;
    code;
    name = 'S3Error';
    constructor(message, status, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const SLICE = 64 * 1024;
const EXPIRED = new Set(['ExpiredToken', 'InvalidToken', 'RequestExpired', 'InvalidAccessKeyId']);
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const encode = (value) => encodeURIComponent(value).replaceAll(/[!'()*]/g, (char) => `%${char.codePointAt(0).toString(16).toUpperCase()}`);
const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? null;
export function signS3Request(request) {
    const amzDate = request.now
        .toISOString()
        .replaceAll(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = request.body ? sha256Hex(request.body) : EMPTY_SHA256;
    const headers = {
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
        signedNames.map((name) => `${name}:${headers[name].trim()}\n`).join(''),
        signedNames.join(';'),
        payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${request.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${request.secretAccessKey}`, dateStamp), request.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const { host: _host, ...sent } = headers;
    sent.authorization = `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
    return sent;
}
export function s3Store(options) {
    const endpoint = new URL(options.endpoint);
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    const prefix = options.prefix ?? '';
    const retryDelays = options.retryDelaysMs ?? [1000, 4000];
    const partSize = options.partSize ?? 8 * 1024 * 1024;
    const idleTimeout = options.idleTimeoutMs ?? 60_000;
    const exchange = (url, method, headers, body) => new Promise((resolve, reject) => {
        const outgoing = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: body ? { ...headers, 'content-length': String(body.length) } : headers }, (incoming) => {
            const parts = [];
            incoming.on('data', (part) => parts.push(part));
            incoming.on('error', reject);
            incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(parts) }));
        });
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
                    allowance += (slice.length / limit) * 1000;
                    const ahead = started + allowance - Date.now();
                    if (ahead > 0) {
                        await sleep(ahead);
                    }
                }
                else {
                    allowance = Date.now() - started;
                }
            }
            outgoing.end();
        })().catch((error) => outgoing.destroy(error));
    });
    const sendOnce = async (renew, method, key, query, headers, body) => {
        const objectPath = key === null ? '' : `/${(prefix + key).split('/').map(encode).join('/')}`;
        const canonicalUri = `${basePath}/${encode(options.bucket)}${objectPath || '/'}`;
        const queryString = Object.entries(query)
            .map(([name, value]) => [encode(name), encode(value)])
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
        let answer;
        try {
            answer = await exchange(new URL(`${endpoint.origin}${canonicalUri}${queryString ? `?${queryString}` : ''}`), method, signed, body);
        }
        catch {
            throw new S3Error(`The storage provider could not be reached (${what})`, null, null);
        }
        if (answer.status < 200 || answer.status >= 300) {
            const code = tag(answer.body.toString(), 'Code');
            throw new S3Error(`The storage provider refused ${what}: ${answer.status}${code ? ` ${code.replaceAll(/[^\w.-]/g, '')}` : ''}`, answer.status, code);
        }
        return answer;
    };
    const send = async (method, key, query = {}, headers = {}, body) => {
        let renewed = false;
        for (let attempt = 0;; attempt++) {
            try {
                return await sendOnce(renewed, method, key, query, headers, body);
            }
            catch (error) {
                if (!(error instanceof S3Error)) {
                    throw error;
                }
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
    const etag = (answer) => {
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
                const parts = [];
                for (let at = 0; at < body.length; at += partSize) {
                    const query = { partNumber: String(parts.length + 1), uploadId };
                    parts.push(etag(await send('PUT', key, query, {}, body.subarray(at, at + partSize))));
                }
                const list = parts
                    .map((value, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${value}</ETag></Part>`)
                    .join('');
                const done = await send('POST', key, { uploadId }, {}, Buffer.from(`<CompleteMultipartUpload>${list}</CompleteMultipartUpload>`));
                if (tag(done.body.toString(), 'Code')) {
                    throw new S3Error('The storage provider could not finish an upload', done.status, tag(done.body.toString(), 'Code'));
                }
            }
            catch (error) {
                await send('DELETE', key, { uploadId }).catch(() => undefined);
                throw error;
            }
        },
        async get(key, range) {
            if (range && !('suffix' in range) && range.end <= range.start) {
                return Buffer.alloc(0);
            }
            const header = !range
                ? {}
                : { range: 'suffix' in range ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end - 1}` };
            return (await send('GET', key, {}, header)).body;
        },
        async list(listPrefix) {
            const found = [];
            let token = null;
            do {
                const query = { 'list-type': '2', prefix: prefix + listPrefix };
                if (token) {
                    query['continuation-token'] = token;
                }
                const xml = (await send('GET', null, query)).body.toString();
                for (const [, item] of xml.matchAll(/<Contents>(.*?)<\/Contents>/gs)) {
                    const key = tag(item, 'Key');
                    if (key?.startsWith(prefix)) {
                        found.push({
                            key: key.slice(prefix.length),
                            size: Number(tag(item, 'Size') ?? 0),
                            modified: new Date(tag(item, 'LastModified') ?? 0),
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
