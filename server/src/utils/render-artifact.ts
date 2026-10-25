import { BadRequestException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { close as closeFile, constants, createWriteStream, fsync, open as openFile, write, writev } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

export type RenderArtifact = { outputPath: string; outputChecksum: Buffer; sizeInBytes: number };
export type ArtifactAccessCheck = () => Promise<void>;

export async function closeArtifactFile(file: { close: () => Promise<void> }) {
  await file.close().catch(() => {
    throw new Error('artifact_close_unconfirmed');
  });
}

/** Streams a declared finite body with backpressure; a worker never chooses a filesystem path. */
export async function receiveRenderArtifact(
  folder: string,
  input: Readable,
  expected: { checksum: string; sizeInBytes: string },
  check: ArtifactAccessCheck,
  commit: (artifact: RenderArtifact) => Promise<boolean | 'duplicate'>,
  options: { allowEmpty?: boolean; signal?: AbortSignal } = {},
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
  let commitUncertain = false;
  let closeUnconfirmed = false;
  const filesystem = {
    open: openFile,
    write,
    writev,
    fsync,
    close(fd: number, callback: (error: NodeJS.ErrnoException | null) => void) {
      closeFile(fd, (error) => {
        if (error) closeUnconfirmed = true;
        callback(error ? new Error('artifact_close_unconfirmed') : null);
      });
    },
  };
  const output = createWriteStream(partial, { flags: 'wx', mode: 0o600, flush: true, fs: filesystem });
  const closed = new Promise<void>((resolve, reject) =>
    output.once('close', () => (closeUnconfirmed ? reject(new Error('artifact_close_unconfirmed')) : resolve())),
  );
  void closed.catch(() => {});
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
      { signal: options.signal },
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
      await closeArtifactFile(directory);
    }
    const artifact = { outputPath, outputChecksum: checksum, sizeInBytes: size };
    // Independently open and hash the actual regular file before recording completion.
    const verified = await openRenderArtifact(folder, artifact, check, { start: size });
    // Finish the EOF stream so its verified descriptor is closed before publication.
    try {
      await finished(verified.resume());
    } finally {
      await verified.descriptorClosed;
    }
    options.signal?.throwIfAborted();
    commitUncertain = true;
    const outcome = await commit(artifact);
    commitUncertain = false;
    accepted = outcome === true;
    return accepted || outcome === 'duplicate';
  } catch (error) {
    if (error instanceof Error && error.message === 'artifact_close_unconfirmed') commitUncertain = true;
    throw error;
  } finally {
    // pipeline may reject before an asynchronous open settles. Close before unlinking so a late
    // open cannot recreate a partial after cleanup, including when the input disconnects.
    output.destroy();
    await closed;
    // A thrown commit or unconfirmed descriptor close retains ownership and its original failure.
    if (!accepted && !commitUncertain) {
      await rm(partial, { force: true });
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
): Promise<Readable & { descriptorClosed: Promise<void> }> {
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
      autoClose: false,
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
    const descriptorClosed = new Promise<void>((resolve, reject) => {
      stream.once('close', () => {
        source.destroy();
        void closeArtifactFile(file).then(resolve).catch(reject);
      });
    });
    // Existing stream-only consumers do not observe descriptor settlement separately.
    void descriptorClosed.catch(() => {});
    source.once('error', (error) => stream.destroy(error));
    return Object.assign(stream, { descriptorClosed });
  } catch (error) {
    await closeArtifactFile(file);
    throw error;
  }
}
