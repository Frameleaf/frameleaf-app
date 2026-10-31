import { BadRequestException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type RenderArtifact = { outputPath: string; outputChecksum: Buffer; sizeInBytes: number };
export type ArtifactAccessCheck = () => Promise<void>;

/** Streams a declared finite body with backpressure; a worker never chooses a filesystem path. */
export async function receiveRenderArtifact(
  folder: string,
  input: Readable,
  expected: { checksum: string; sizeInBytes: string },
  check: ArtifactAccessCheck,
  commit: (artifact: RenderArtifact) => Promise<boolean | 'duplicate'>,
  options: { allowEmpty?: boolean } = {},
): Promise<boolean> {
  const size = Number(expected.sizeInBytes);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    (size === 0 && !options.allowEmpty) ||
    !/^[a-f\d]{64}$/i.test(expected.checksum)
  ) {
    throw new BadRequestException('Invalid artifact size or SHA-256');
  }
  await check();
  await mkdir(folder, { recursive: true });
  const outputPath = join(folder, `${randomUUID()}.artifact`);
  const partial = `${outputPath}.partial`;
  let accepted = false;
  const output = createWriteStream(partial, { flags: 'wx', mode: 0o600, flush: true });
  const closed = new Promise<void>((resolve) => output.once('close', resolve));
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    let checkedAt = Date.now();
    await pipeline(
      input,
      async function* (source) {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > size) {
            throw new BadRequestException('Artifact exceeds its declared size');
          }
          if (Date.now() - checkedAt >= 1000) {
            await check();
            checkedAt = Date.now();
          }
          hash.update(buffer);
          yield buffer;
        }
      },
      output,
    );
    const checksum = hash.digest();
    if (bytes !== size || !checksum.equals(Buffer.from(expected.checksum, 'hex'))) {
      throw new BadRequestException('Artifact size or SHA-256 does not match');
    }
    await check();
    await rename(partial, outputPath);
    // Persist the directory entry before the durable checkpoint points at it.
    const directory = await open(folder, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const artifact = { outputPath, outputChecksum: checksum, sizeInBytes: size };
    // Independently open and hash the actual regular file before recording completion.
    const verified = await openRenderArtifact(folder, artifact, check);
    verified.destroy();
    const outcome = await commit(artifact);
    accepted = outcome === true;
    return accepted || outcome === 'duplicate';
  } finally {
    // pipeline may reject before an asynchronous open settles. Close before unlinking so a late
    // open cannot recreate a partial after cleanup, including when the input disconnects.
    output.destroy();
    await closed;
    await rm(partial, { force: true });
    if (!accepted) {
      await rm(outputPath, { force: true });
    }
  }
}

/** Keeps the verified descriptor open: senders cannot swap the path after verification. */
export async function openRenderArtifact(
  folder: string,
  artifact: RenderArtifact,
  check: ArtifactAccessCheck,
  options: { publishedName?: string; start?: number; end?: number; checkEachChunk?: boolean } = {},
): Promise<Readable> {
  await check();
  if (
    dirname(resolve(artifact.outputPath)) !== resolve(folder) ||
    (options.publishedName
      ? basename(artifact.outputPath) !== options.publishedName ||
        !/^(?:[a-f\d-]{36}|[a-f\d]{64})\.srt$/.test(options.publishedName)
      : !/^[a-f\d-]{36}\.artifact$/.test(basename(artifact.outputPath)))
  ) {
    throw new BadRequestException('Artifact is not server-staged');
  }
  const file = await open(artifact.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!file) {
    throw new BadRequestException('Artifact is missing or unavailable');
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== artifact.sizeInBytes) {
      throw new BadRequestException('Artifact is not a matching regular file');
    }
    const hash = createHash('sha256');
    let checkedAt = Date.now();
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
      hash.update(chunk);
      if (Date.now() - checkedAt >= 1000) {
        await check();
        checkedAt = Date.now();
      }
    }
    const after = await file.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      !hash.digest().equals(artifact.outputChecksum)
    ) {
      throw new BadRequestException('Artifact SHA-256 does not match');
    }
    await check();
    const source = file.createReadStream({
      start: options.start ?? 0,
      ...(options.end !== undefined && { end: options.end }),
      autoClose: true,
    });
    const stream = Readable.from(
      (async function* () {
        let checkedAt = Date.now();
        try {
          for await (const chunk of source) {
            if (options.checkEachChunk || Date.now() - checkedAt >= 1000) {
              await check();
              checkedAt = Date.now();
            }
            yield chunk;
          }
          await check();
        } finally {
          source.destroy();
        }
      })(),
    );
    stream.once('close', () => source.destroy());
    source.once('error', (error) => stream.destroy(error));
    return stream;
  } catch (error) {
    await file.close();
    throw error;
  }
}
