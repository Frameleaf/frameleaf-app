// Wire errors are sanitized here; node entry points wrap them in NodeOperationError.
/* eslint-disable @n8n/community-nodes/require-node-api-error */
import { createHash } from 'node:crypto';
import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';
import { origin, SafeMessageError } from '../../credentials/connection';
export { origin, SafeMessageError, fail, validateConnection } from '../../credentials/connection';

// Shared across concurrent nodes in this n8n process; contains no credentials.
const backoffs = new Map<string, { until: number; statusCode: number }>();

export type Request = (options: IHttpRequestOptions) => Promise<unknown>;
export interface Album {
	id: string;
	name: string;
	workspace: string;
	canRead: boolean;
	canWrite: boolean;
}
export interface Capabilities {
	protocolVersion: number;
	scopes: string[];
	albums: Album[];
	limits: { maxUploadBytes: number; maxAppendBytes: number; originalsAllowed?: boolean };
	supportedTypes: { upload: Record<string, string[]> };
}
interface Receipt {
	assetId: string;
	status: string;
	sha256: string;
}
interface UploadState {
	id: string;
	offset: number;
	size: number;
	state: string;
	receipt?: Receipt;
}
interface UploadInput {
	requestId: string;
	albumId: string;
	workspace: 'photo' | 'design';
	filename: string;
	contentType: string;
	sourceDate: string;
}

export function sourceRequestId(
	workflow: string | undefined,
	node: string,
	operation: string,
	source: string,
): string {
	if (!workflow || !node || !source.trim())
		throw new SafeMessageError(
			'Save the workflow and map a stable Source ID before creating or uploading.',
		);
	return createHash('sha256')
		.update(JSON.stringify([workflow, node, operation, source]))
		.digest('hex');
}
export function uuid(value: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
		throw new SafeMessageError('Enter a valid Frameleaf album, asset, or upload ID.');
	return value;
}
function status(error: unknown): number {
	const value = error as {
		statusCode?: number;
		httpCode?: string;
		response?: { status?: number; statusCode?: number };
	};
	return Number(
		value?.statusCode ??
			value?.httpCode ??
			value?.response?.status ??
			value?.response?.statusCode ??
			0,
	);
}
export class ConnectError extends SafeMessageError {
	constructor(
		public readonly statusCode: number,
		message: string,
	) {
		super(message);
	}
}
export class ConnectClient {
	private readonly base: string;
	constructor(
		base: string,
		private readonly request: Request,
		private readonly signal?: AbortSignal,
	) {
		this.base = origin(base);
	}
	async json<T = IDataObject>(
		method: IHttpRequestOptions['method'],
		path: string,
		body?: IDataObject,
		qs?: IDataObject,
	): Promise<T> {
		return (await this.send({
			method,
			url: path,
			body,
			qs,
			json: true,
			maxResponseBodyBytes: 8 * 1024 * 1024,
		})) as T;
	}
	private async send(options: IHttpRequestOptions): Promise<unknown> {
		if (!/^\/(albums|assets|uploads|capabilities)(\/[-a-zA-Z0-9]+)*$/.test(options.url))
			throw new SafeMessageError('Unsupported Connect request path.');
		this.signal?.throwIfAborted();
		const now = Date.now();
		for (const [key, value] of backoffs) if (value.until <= now) backoffs.delete(key);
		const pending = backoffs.get(this.base);
		if (pending)
			throw new ConnectError(
				pending.statusCode,
				`Frameleaf is temporarily limiting requests. Retry after at least ${Math.ceil((pending.until - now) / 1000)} seconds.`,
			);
		try {
			return await this.request({
				...options,
				url: `${this.base}/api/connect${options.url}`,
				disableFollowRedirect: true,
				skipSslCertificateValidation: false,
				timeout: 60000,
				abortSignal: this.signal,
			});
		} catch (error) {
			const code = status(error);
			const headers =
				(
					error as {
						response?: { headers?: Record<string, string> };
						headers?: Record<string, string>;
					}
				)?.response?.headers ?? (error as { headers?: Record<string, string> })?.headers;
			const raw = headers?.['retry-after'];
			const seconds = raw
				? /^\d+$/.test(raw)
					? Number(raw)
					: Math.max(0, Math.ceil((Date.parse(raw) - Date.now()) / 1000))
				: undefined;
			if ([429, 503].includes(code) && Number.isFinite(seconds) && seconds! > 0) {
				const until = Date.now() + seconds! * 1000;
				if (until > (backoffs.get(this.base)?.until ?? 0))
					backoffs.set(this.base, { until, statusCode: code });
			}
			const retry = Number.isFinite(seconds) ? ` Retry after at least ${seconds} seconds.` : '';
			const message =
				code === 401
					? 'Frameleaf access expired or was revoked. Reconnect the credential.'
					: code === 409
						? 'Frameleaf returned 409. Check that the Source ID, content, and destination are unchanged before retrying.'
						: `Frameleaf request failed${code ? ` (HTTP ${code})` : ''}.${retry} Retry with the same Source ID and input.`;
			throw new ConnectError(code, message);
		}
	}
	async capabilities(): Promise<Capabilities> {
		const result = await this.json<Capabilities>('GET', '/capabilities');
		if (result.protocolVersion !== 1)
			throw new SafeMessageError('This Library does not support Connect protocol version 1.');
		return result;
	}
	async download(
		assetId: string,
		variant: string,
		maximumBytes: number,
	): Promise<{ body: Buffer; headers: Record<string, string> }> {
		if (!['thumbnail', 'preview', 'display', 'original'].includes(variant))
			throw new SafeMessageError('Choose a supported rendition.');
		if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
			throw new SafeMessageError('Set a positive download size limit.');
		if (variant === 'original' && !(await this.capabilities()).limits.originalsAllowed)
			throw new SafeMessageError(
				'Original downloads require download consent and permission for this connection.',
			);
		const response = (await this.send({
			method: 'GET',
			url: `/assets/${uuid(assetId)}/rendition`,
			qs: { variant },
			encoding: 'arraybuffer',
			returnFullResponse: true,
			maxResponseBodyBytes: maximumBytes,
		})) as { body: Buffer; headers: Record<string, string> };
		if (!Buffer.isBuffer(response.body) || response.body.length > maximumBytes)
			throw new SafeMessageError('The rendition exceeds the configured download limit.');
		return response;
	}
	async upload(bytes: Buffer, input: UploadInput): Promise<Receipt> {
		const capabilities = await this.capabilities();
		const requiredScope = input.workspace === 'photo' ? 'photos:upload' : 'boards:upload';
		const destination = capabilities.albums.find(
			(a) => a.id === input.albumId && a.workspace === input.workspace && a.canWrite,
		);
		if (!capabilities.scopes.includes(requiredScope) || !destination)
			throw new SafeMessageError(
				'The selected upload destination is outside this connection’s permissions.',
			);
		if (!Number.isFinite(Date.parse(input.sourceDate)))
			throw new SafeMessageError('Map a valid, stable Source Date from the source event.');
		const date = new Date(input.sourceDate).toISOString();
		const digest = createHash('sha256').update(bytes).digest('hex');
		let state = await this.json<UploadState>('POST', '/uploads', {
			requestId: input.requestId,
			albumId: uuid(input.albumId),
			workspace: input.workspace,
			filename: input.filename,
			size: bytes.length,
			sha256: digest,
			contentType: input.contentType,
			fileCreatedAt: date,
			fileModifiedAt: date,
		});
		if (state.state === 'published' && state.receipt) return state.receipt;
		if (!bytes.length || bytes.length > capabilities.limits.maxUploadBytes)
			throw new SafeMessageError('The file exceeds the Library’s current upload limit.');
		if (!capabilities.supportedTypes.upload[input.workspace]?.includes(input.contentType))
			throw new SafeMessageError(
				'The Library does not accept this file type in the selected destination.',
			);
		const path = `/uploads/${uuid(state.id)}`;
		const chunkSize = Math.min(capabilities.limits.maxAppendBytes, 8 * 1024 * 1024);
		if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
			throw new SafeMessageError('The Library currently cannot accept upload bytes.');
		let recoveries = 0;
		while (state.state === 'receiving' && state.offset < bytes.length) {
			if (!Number.isSafeInteger(state.offset) || state.offset < 0 || state.size !== bytes.length)
				throw new SafeMessageError('The Library returned an invalid upload offset.');
			const end = Math.min(state.offset + chunkSize, bytes.length);
			const prior = state.offset;
			try {
				state = (await this.send({
					method: 'PATCH',
					url: path,
					body: bytes.subarray(prior, end),
					json: false,
					headers: {
						'Content-Type': 'application/partial-upload',
						'Upload-Draft-Interop-Version': '9',
						'Upload-Offset': String(prior),
						'Upload-Length': String(bytes.length),
						'Upload-Complete': end === bytes.length ? '?1' : '?0',
						'Repr-Digest': `sha-256=:${Buffer.from(digest, 'hex').toString('base64')}:`,
					},
					encoding: 'json',
					maxResponseBodyBytes: 1024 * 1024,
				})) as UploadState;
			} catch (error) {
				if (
					!(error instanceof ConnectError) ||
					![0, 500, 502, 504].includes(error.statusCode) ||
					++recoveries > 2
				)
					throw error;
				state = await this.json<UploadState>('GET', path);
				if (state.offset === prior) throw error;
			}
			if (state.offset <= prior || state.offset > end)
				throw new SafeMessageError('The Library returned an invalid upload offset.');
		}
		if (state.state === 'published' && state.receipt) return state.receipt;
		if (state.state !== 'verified')
			throw new SafeMessageError(
				'The upload is not ready to publish. Retry with the same Source ID after processing finishes.',
			);
		try {
			return await this.json<Receipt>('POST', `${path}/commit`, {
				requestId: input.requestId,
				sha256: digest,
			});
		} catch (error) {
			if (error instanceof ConnectError && [0, 500, 502, 504].includes(error.statusCode)) {
				const recovered = await this.json<UploadState>('GET', path);
				if (recovered.state === 'published' && recovered.receipt) return recovered.receipt;
			}
			throw error;
		}
	}
}
