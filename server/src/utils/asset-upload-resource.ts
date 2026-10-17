import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import z from 'zod';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { AssetMediaCreateDto } from 'src/dtos/asset-media.dto.js';

/**
 * FL-296: the iCloud item an upload is, so the server can record its source identity once the digest
 * checks out, and refuse it while another path holds the item's claim.
 */
export const UploadSourceIdentitySchema = z
  .object({
    kind: z.literal('icloud'),
    cloudIdentifier: z.string().min(1).max(512),
    role: z.enum(['original', 'live-motion', 'raw-alternate', 'edit-render']),
    editVersion: z.string().min(1).max(256).optional(),
    claimId: z.uuid().optional(),
    deviceKey: z.uuid().optional(),
  })
  .strict()
  .refine((value) => (value.role === 'edit-render') === !!value.editVersion, {
    message: 'An edit render, and only one, names its edit version',
  });
export type UploadSourceIdentity = z.infer<typeof UploadSourceIdentitySchema>;
export type AssetUploadMetadata = AssetMediaCreateDto & {
  publication?: 'live-photo';
  sourceIdentity?: UploadSourceIdentity;
};

export const ASSET_UPLOAD_LIMITS = { maxSize: 2 ** 31, maxAppendSize: 64 * 2 ** 20, maxAge: 86_400, maxActive: 4 };
export type AssetUploadPart = { path: string; size: number; interrupted: boolean };

export function parseAssetUploadHeaders(headers: IncomingHttpHeaders) {
  const header = (name: string) => {
    const value = headers[name];
    if (Array.isArray(value)) {
      throw new BadRequestException(`Ambiguous ${name}`);
    }
    return value;
  };
  if (header('upload-draft-interop-version') !== '9') {
    throw new BadRequestException('Unsupported upload draft interop version');
  }
  if (header('content-encoding') && header('content-encoding') !== 'identity') {
    throw new BadRequestException('Encoded uploads are not supported');
  }
  const complete = header('upload-complete');
  if (complete !== '?0' && complete !== '?1') {
    throw new BadRequestException('Upload-Complete is required');
  }
  const digest = /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(header('repr-digest') ?? '');
  if (!digest) {
    throw new BadRequestException('One SHA-256 Repr-Digest is required');
  }
  const checksum = Buffer.from(digest[1], 'base64');
  if (checksum.length !== 32 || checksum.toString('base64') !== digest[1]) {
    throw new BadRequestException('Invalid SHA-256');
  }
  const encoded = header('asset-metadata') ?? '';
  if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new BadRequestException('Invalid Asset-Metadata');
  }
  let metadata: AssetUploadMetadata;
  try {
    const buffer = Buffer.from(encoded, 'base64url');
    if (buffer.toString('base64url') !== encoded) {
      throw new Error('Invalid encoding');
    }
    const text = buffer.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buffer)) {
      throw new Error('Invalid UTF-8');
    }
    const decoded: unknown = JSON.parse(text);
    const allowed = new Set([
      'publication',
      'filename',
      'fileCreatedAt',
      'fileModifiedAt',
      'duration',
      'isFavorite',
      'visibility',
      'metadata',
      'sourceIdentity',
    ]);
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      Object.keys(decoded).some((key) => !allowed.has(key))
    ) {
      throw new Error('Unsupported metadata');
    }
    const value = { ...decoded } as Record<string, unknown>;
    if (value.metadata !== undefined) {
      if (!Array.isArray(value.metadata)) {
        throw new TypeError('Metadata must be an array');
      }
      value.metadata = JSON.stringify(value.metadata);
    }
    // FL-218: Asset-Metadata is JSON, so `isFavorite` is naturally a boolean (the OpenAPI type). The shared
    // multipart schema reads form strings, so pass a JSON boolean on as its 'true' / 'false' form; the
    // strings stay accepted for existing clients, and anything else is still refused by the schema.
    if (typeof value.isFavorite === 'boolean') {
      value.isFavorite = String(value.isFavorite);
    }
    if (value.publication !== undefined && value.publication !== 'live-photo') {
      throw new Error('Unsupported publication');
    }
    const sourceIdentity =
      value.sourceIdentity === undefined ? undefined : UploadSourceIdentitySchema.parse(value.sourceIdentity);
    delete value.sourceIdentity;
    metadata = {
      ...AssetMediaCreateDto.schema.parse(value),
      ...(value.publication === 'live-photo' && { publication: 'live-photo' as const }),
      ...(sourceIdentity && { sourceIdentity }),
    };
    if (!metadata.filename) {
      throw new Error('Filename is required');
    }
  } catch {
    throw new BadRequestException('Invalid Asset-Metadata');
  }
  const length = header('upload-length');
  const size = length === undefined ? undefined : Number(length);
  if (
    length !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(length) ||
      !Number.isSafeInteger(size) ||
      size! < 1 ||
      size! > ASSET_UPLOAD_LIMITS.maxSize)
  ) {
    throw new BadRequestException('Invalid Upload-Length');
  }
  const contentType = header('content-type');
  if (!contentType || !/^(image|video|audio)\/[a-zA-Z0-9.+-]+$/.test(contentType)) {
    throw new BadRequestException('A media Content-Type is required');
  }
  return { checksum, metadata, size, complete: complete === '?1', contentType };
}

/** Each request owns an immutable file: a disconnected/losing writer never mutates acknowledged bytes. */
export async function writeAssetUploadPart(folder: string, input: Readable, limit: number): Promise<AssetUploadPart> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${randomUUID()}.part`);
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let size = 0;
  let interrupted = false;
  let retained = false;
  try {
    const iterator = input[Symbol.asyncIterator]();
    while (true) {
      let next: IteratorResult<Buffer>;
      try {
        next = await iterator.next();
      } catch {
        interrupted = true;
        break;
      }
      if (next.done) {
        break;
      }
      const bytes = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (size + bytes.length > limit) {
        throw new PayloadTooLargeException('Upload part exceeds its limit');
      }
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, size);
        if (result.bytesWritten === 0) {
          throw new Error('Upload write made no progress');
        }
        written += result.bytesWritten;
        size += result.bytesWritten;
      }
    }
    await file.sync();
    const directory = await open(folder, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    retained = true;
    return { path, size, interrupted };
  } finally {
    await file.close();
    if (!retained) {
      input.destroy();
      await rm(path, { force: true });
    }
  }
}

/** Hash the complete, immutable acknowledged representation before any publication. */
export async function assembleAssetUploadParts(
  folder: string,
  parts: Array<AssetUploadPart & { offset: number }>,
  expectedSize: number,
  expectedHash: Buffer,
  extension: string,
) {
  if (!/^\.[a-zA-Z0-9]+$/.test(extension)) {
    throw new BadRequestException('Invalid upload extension');
  }
  const path = join(folder, `${randomUUID()}${extension}`);
  const output = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const sha256 = createHash('sha256');
  const sha1 = createHash('sha1');
  let offset = 0;
  let retained = false;
  try {
    for (const part of parts) {
      if (
        part.offset !== offset ||
        part.size === 0 ||
        dirname(resolve(part.path)) !== resolve(folder) ||
        !/^[a-f0-9-]{36}\.part$/.test(basename(part.path))
      ) {
        throw new BadRequestException('Invalid upload manifest');
      }
      const source = await open(part.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await source.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== part.size) {
          throw new BadRequestException('Upload part changed');
        }
        for await (const chunk of source.createReadStream({ autoClose: false })) {
          const bytes = Buffer.from(chunk);
          sha256.update(bytes);
          sha1.update(bytes);
          let written = 0;
          while (written < bytes.length) {
            const result = await output.write(bytes, written, bytes.length - written, offset);
            if (!result.bytesWritten) {
              throw new Error('Assembly write made no progress');
            }
            written += result.bytesWritten;
            offset += result.bytesWritten;
          }
          if (offset > expectedSize) {
            throw new BadRequestException('Upload length changed');
          }
        }
      } finally {
        await source.close();
      }
    }
    const digest = sha256.digest();
    if (offset !== expectedSize || !digest.equals(expectedHash)) {
      throw new BadRequestException('Representation SHA-256 does not match');
    }
    await output.sync();
    const directory = await open(folder, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    retained = true;
    return { path, size: offset, sha256: digest, sha1: sha1.digest() };
  } finally {
    await output.close();
    if (!retained) {
      await rm(path, { force: true });
    }
  }
}
