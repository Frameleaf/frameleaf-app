import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { type Readable, type Writable } from 'node:stream';
import { Refusal } from '#library-import-transfer/contracts';
import {
  encodeImportSourceAuthorityRequest,
  parseImportSourceAuthorityResponse,
  type ImportSourceAuthorityAction,
  type ImportSourceAuthoritySeal,
} from '#library-import-transfer/import-source-authority';

/** The Manager owns live fencing; a bundle or earlier approval never authorizes a later boundary. */
export async function requestImportSourceAuthority(
  action: ImportSourceAuthorityAction,
  seal: ImportSourceAuthoritySeal,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const nonce = randomUUID();
  const challenge = encodeImportSourceAuthorityRequest(action, seal, nonce);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    let writing = false;
    let writeFailed = false;
    let reader: ReturnType<typeof createInterface> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = input as Readable & { ref?: () => void; unref?: () => void };
    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off('data', bounded);
      input.off('error', refused);
      input.off('end', refused);
      if (!writing && !writeFailed) output.off('error', outputFailed);
      reader?.removeAllListeners('line');
      reader?.removeAllListeners('close');
      reader?.close();
      input.pause();
      stream.unref?.();
      if (allowed) resolve();
      else reject(new Refusal('import_source_authority_unavailable'));
    };
    const refused = () => finish(false);
    const outputFailed = () => {
      writeFailed = true;
      refused();
    };
    const bounded = (chunk: Buffer | string) => {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > 65536) refused();
    };
    if (input.destroyed || input.readableEnded || output.destroyed) return refused();
    stream.ref?.();
    input.on('data', bounded);
    input.once('error', refused);
    input.once('end', refused);
    output.once('error', outputFailed);
    reader = createInterface({ input, crlfDelay: Infinity });
    reader.once('close', refused);
    reader.once('error', refused);
    reader.once('line', (line) => {
      try {
        parseImportSourceAuthorityResponse(line, nonce);
        finish(true);
      } catch {
        refused();
      }
    });
    timer = setTimeout(refused, 120_000);
    try {
      writing = true;
      output.write(challenge, (error) => {
        writing = false;
        if (error) outputFailed();
        else if (settled) output.off('error', outputFailed);
      });
    } catch {
      writing = false;
      refused();
    }
  });
}
