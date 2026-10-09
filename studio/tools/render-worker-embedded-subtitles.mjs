import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Stream-copy only inside this export's owned folder; cancellation settles before cleanup. */
export async function muxEmbeddedSubtitles({
  input,
  folder,
  content,
  seal,
  maxBytes,
  maxMs,
  signal,
  assertLive,
  ffmpeg = 'ffmpeg',
}) {
  const require = createRequire(import.meta.url);
  const { superviseMediaProcess } = require('../../server/dist/queue/process-lifetime.js');
  const { StudioEmbeddedSubtitleSealSchema } = require('../../server/dist/utils/studio-embedded-subtitles.js');
  seal = StudioEmbeddedSubtitleSealSchema.parse(seal);
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 32 * 1024 * 1024, 'INVALID_MUX_BYTE_LIMIT');
  assert.ok(Number.isSafeInteger(maxMs) && maxMs > 0 && maxMs <= 60_000, 'INVALID_MUX_WALL_LIMIT');
  assert.equal(await realpath(folder), path.resolve(folder), 'MUX_FOLDER_ESCAPE');
  assert.equal(path.dirname(input), folder, 'MUX_INPUT_ESCAPE');
  const original = await lstat(input);
  assert.ok(original.isFile() && original.size > 0 && original.size <= maxBytes, 'INVALID_MUX_INPUT');
  assert.equal(await realpath(input), input, 'MUX_INPUT_ESCAPE');
  assert.equal(
    createHash('sha256').update(content, 'utf8').digest('hex'),
    seal.source.expectedSrtSha256,
    'SUBTITLE_BYTES_CHANGED',
  );
  assert.equal(String(Buffer.byteLength(content)), seal.source.sizeInBytes, 'SUBTITLE_BYTES_CHANGED');
  const srt = path.join(folder, 'embedded-captions.srt');
  const output = path.join(folder, 'embedded-output.mp4');
  const absent = async (file) => {
    try {
      await lstat(file);
      assert.fail('MUX_OUTPUT_EXISTS');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
  await absent(srt);
  await absent(output);
  await assertLive();
  signal?.throwIfAborted();
  let created = false;
  try {
    await writeFile(srt, content, { flag: 'wx', mode: 0o600 });
    created = true;
    await assertLive();
    const child = spawn(
      ffmpeg,
      [
        '-v',
        'error',
        '-nostdin',
        '-n',
        '-threads',
        '1',
        '-i',
        input,
        '-protocol_whitelist',
        'file',
        '-f',
        'srt',
        '-i',
        srt,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-map',
        '1:s:0',
        '-c:v',
        'copy',
        '-c:a',
        'copy',
        '-c:s',
        seal.codec,
        '-metadata:s:s:0',
        `language=${seal.language}`,
        '-disposition:s:0',
        'default',
        '-map_metadata',
        '0',
        '-fs',
        String(maxBytes),
        '-f',
        'mp4',
        output,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const lifetime = superviseMediaProcess(child, {
      signal,
      deadlineMs: maxMs,
    });
    let failure;
    let stderrBytes = 0;
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65_536) lifetime.stop(new Error('MUX_DIAGNOSTIC_LIMIT'));
    });
    child.on('error', (error) => {
      failure = error;
    });
    await new Promise((resolve, reject) =>
      child.once('close', (code) =>
        lifetime.error() || failure || code !== 0
          ? reject(lifetime.error() ?? failure ?? new Error('SUBTITLE_MUX_REFUSED'))
          : resolve(),
      ),
    );
    await assertLive();
    signal?.throwIfAborted();
    const current = await lstat(input);
    assert.ok(
      current.isFile() &&
        current.dev === original.dev &&
        current.ino === original.ino &&
        current.size === original.size &&
        current.mtimeMs === original.mtimeMs,
      'MUX_INPUT_CHANGED',
    );
    const final = await lstat(output);
    assert.ok(final.isFile() && final.size > 0 && final.size < maxBytes, 'MUX_OUTPUT_LIMIT');
    assert.equal(await realpath(output), output, 'MUX_OUTPUT_ESCAPE');
    await assertLive();
    await rename(output, input);
    return input;
  } finally {
    if (created) await rm(srt, { force: true });
    await rm(output, { force: true });
  }
}
