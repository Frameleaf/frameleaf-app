import {
  type LockedKeyFile,
  type WrapKind,
  WrongSecretError,
  isLockedFile,
  keyId,
  openDecrypt,
  readHeader,
  unwrapKey,
} from '@frameleaf/locked-crypto';
import { Command, CommanderError } from 'commander';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';

/** Offline recovery of encrypted Locked files (FL-721): no server, no database, no login. */

const KEY_DIRECTORY = 'locked-keys';
const TEMP_SUFFIX = '.fllk.tmp';

/** A problem with the arguments, the key file or the secret. The command exits with `exitCode`. */
export class LockedCliError extends Error {
  constructor(
    message: string,
    public exitCode = 2,
  ) {
    super(message);
    this.name = 'LockedCliError';
  }
}

export interface LockedDecryptOptions {
  library: string;
  to: string;
  user?: string;
  all?: boolean;
  /** Tests only: skips the hidden prompt. */
  secret?: string;
}

export interface LockedDecryptResult {
  written: number;
  failed: string[];
  /** Symbolic links found in the library; they are never followed. Only set when there were some. */
  skippedLinks?: number;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const readLine = (question: string): Promise<string> =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    process.stderr.write(question);
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
    rl.once('close', () => resolve(''));
  });

/** Reads a line without echoing it. Piped input is read as a plain line. */
const readHidden = (question: string): Promise<string> => {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    return readLine(question);
  }
  return new Promise((resolve, reject) => {
    stderr.write(question);
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stderr.write('\n');
    };
    const onEnd = () => {
      finish();
      reject(new LockedCliError('No secret was entered'));
    };
    const onData = (chunk: Buffer) => {
      // arrow keys and other escape sequences are not part of the secret
      // eslint-disable-next-line no-control-regex
      const text = chunk.toString('utf8').replaceAll(/\u{1B}(?:\[[\d;?]*[ -/]*[@-~]|O.)?/gu, '');
      for (const char of text) {
        if (['\r', '\n', '\u{4}'].includes(char)) {
          finish();
          return resolve(value);
        }
        if (char === '\u{3}') {
          finish();
          return reject(new LockedCliError('Cancelled', 2));
        }
        if (char === '\u{7F}' || char === '\b') {
          value = [...value].slice(0, -1).join('');
        } else {
          value += char;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.once('end', onEnd);
  });
};

const loadKeyFiles = async (library: string): Promise<LockedKeyFile[]> => {
  const directory = path.join(library, KEY_DIRECTORY);
  let names: string[];
  try {
    const entries = await readdir(directory);
    names = entries.filter((name) => name.endsWith('.json')).toSorted();
  } catch {
    throw new LockedCliError(`No key files found: ${directory} does not exist. Is --library the library folder?`);
  }
  const files: LockedKeyFile[] = [];
  for (const name of names) {
    try {
      const file = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as LockedKeyFile;
      if (file.format === 'frameleaf-locked-key/1') {
        files.push(file);
      }
    } catch {
      // not a key file we can read; ignore it
    }
  }
  if (files.length === 0) {
    throw new LockedCliError(`No key files found in ${directory}`);
  }
  return files;
};

const chooseKeyFile = async (files: LockedKeyFile[], user?: string): Promise<LockedKeyFile> => {
  if (user) {
    const wanted = user.toLowerCase();
    const byId = files.filter((file) => file.userId.toLowerCase() === wanted);
    const matches = byId.length > 0 ? byId : files.filter((file) => file.label.toLowerCase() === wanted);
    if (matches.length === 1) {
      return matches[0];
    }
    const known = files.map((file) => `${file.label} (${file.userId})`).join(', ');
    throw new LockedCliError(
      matches.length === 0
        ? `No key file matches "${user}". Available: ${known}`
        : `"${user}" matches several key files; use the user ID. Available: ${known}`,
    );
  }
  if (files.length === 1) {
    return files[0];
  }
  if (!process.stdin.isTTY) {
    throw new LockedCliError('Several people have key files here; choose one with --user <name or ID>');
  }
  process.stderr.write('Whose files do you want to decrypt?\n');
  for (const [index, file] of files.entries()) {
    process.stderr.write(`  ${index + 1}. ${file.label}\n`);
  }
  const reply = await readLine('Number: ');
  const answer = Number(reply.trim());
  if (!Number.isSafeInteger(answer) || answer < 1 || answer > files.length) {
    throw new LockedCliError('That is not one of the numbers listed');
  }
  return files[answer - 1];
};

/** The private key, opened by the key file's PIN or passphrase, or else by its recovery key. */
const openKey = async (file: LockedKeyFile, secret: string): Promise<Buffer> => {
  const primary: WrapKind = file.mode === 'advanced' ? 'passphrase' : 'pin';
  for (const kind of [primary, 'recovery'] as const) {
    if (file.wraps.every((wrap) => wrap.kind !== kind)) {
      continue;
    }
    try {
      return await unwrapKey(file, kind, secret);
    } catch (error) {
      if (!(error instanceof WrongSecretError)) {
        throw new LockedCliError(messageOf(error));
      }
    }
  }
  throw new LockedCliError(
    `That ${primary === 'pin' ? 'PIN' : 'passphrase'} or recovery key doesn't open ${file.label}'s key file`,
  );
};

const realpathOfExisting = async (target: string): Promise<string> => {
  const resolved = path.resolve(target);
  try {
    return await realpath(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) {
      return resolved;
    }
    return path.join(await realpathOfExisting(parent), path.basename(resolved));
  }
};

const isInside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  if (path.isAbsolute(relative)) {
    return false;
  }
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
};

interface WalkReport {
  links: number;
  failed: string[];
}

async function* walkFiles(directory: string, skip: string, report: WalkReport): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    report.failed.push(`${directory}: ${messageOf(error)}`);
    return;
  }
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (full === skip) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      report.links++;
    } else if (entry.isDirectory()) {
      yield* walkFiles(full, skip, report);
    } else if (entry.isFile() && !entry.name.endsWith(TEMP_SUFFIX)) {
      yield full;
    }
  }
}

const isPresent = async (target: string) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** The file name from the (unauthenticated-by-path) info JSON, reduced to one safe path segment. */
const safeBaseName = (fileName: unknown): string => {
  const base = typeof fileName === 'string' ? path.basename(fileName.replaceAll('\\', '/')) : '';
  if (base === '' || base === '.' || base === '..' || base.includes('\0')) {
    throw new Error('The file has no usable original file name');
  }
  return base;
};

/** `name.ext`, then `name (2).ext`, `name (3).ext` ... for names already written or present. */
const freeName = async (directory: string, base: string, taken: Set<string>): Promise<string> => {
  const extension = path.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  for (let counter = 1; ; counter++) {
    const candidate = path.join(directory, counter === 1 ? base : `${stem} (${counter})${extension}`);
    if (!taken.has(candidate) && !(await isPresent(candidate))) {
      taken.add(candidate);
      return candidate;
    }
  }
};

export async function lockedDecrypt(options: LockedDecryptOptions): Promise<LockedDecryptResult> {
  if (!options.library || !options.to) {
    throw new LockedCliError('--library and --to are required');
  }
  const library = path.resolve(options.library);
  const to = path.resolve(options.to);
  if (isInside(await realpathOfExisting(to), await realpathOfExisting(library))) {
    throw new LockedCliError('--to must be a folder outside --library; nothing is ever written into the library');
  }

  const keyFile = await chooseKeyFile(await loadKeyFiles(library), options.user);
  const secret = options.secret ?? (await readHidden(`PIN, passphrase or recovery key for ${keyFile.label}: `));
  const privateKey = await openKey(keyFile, secret);
  const myKeyId = keyId(Buffer.from(keyFile.publicKey, 'base64'));

  try {
    await mkdir(to, { recursive: true });
    const taken = new Set<string>();
    const report: WalkReport = { links: 0, failed: [] };
    let written = 0;

    for await (const file of walkFiles(library, path.join(library, KEY_DIRECTORY), report)) {
      const temp = path.join(to, `.${randomUUID()}${TEMP_SUFFIX}`);
      try {
        if (!(await isLockedFile(file))) {
          continue;
        }
        const header = await readHeader(file);
        if (header.keyIds.every((id) => !id.equals(myKeyId))) {
          continue;
        }

        const { stream, info } = await openDecrypt(file, privateKey);
        const isOriginal = info.kind === 'original';
        if (!isOriginal && !options.all) {
          (stream as NodeJS.ReadableStream & { destroy(): void }).destroy();
          continue;
        }
        try {
          if (typeof info.assetId !== 'string' || !UUID.test(info.assetId)) {
            throw new Error('The file has no valid item ID');
          }
          const name = safeBaseName(info.originalFileName);
          const directory = isOriginal ? to : path.join(to, 'derived', info.assetId);
          await pipeline(stream, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
          await mkdir(directory, { recursive: true });
          const target = await freeName(directory, isOriginal ? name : `${info.kind} - ${name}`, taken);
          if (!isInside(path.resolve(target), to)) {
            throw new Error('The output path would leave the destination folder');
          }
          await rename(temp, target);
          written++;
        } finally {
          (stream as NodeJS.ReadableStream & { destroy(): void }).destroy();
        }
      } catch (error) {
        try {
          await unlink(temp);
        } catch {
          // nothing was written yet
        }
        report.failed.push(`${file}: ${messageOf(error)}`);
      }
    }
    return { written, failed: report.failed, ...(report.links > 0 && { skippedLinks: report.links }) };
  } finally {
    privateKey.fill(0);
  }
}

/** Runs the command for the terminal and returns the exit code: 0 all good, 1 some failed, 2 cannot start. */
export async function runLockedDecrypt(options: LockedDecryptOptions): Promise<number> {
  try {
    const { written, failed, skippedLinks } = await lockedDecrypt(options);
    console.log(`Decrypted ${written} file${written === 1 ? '' : 's'} to ${path.resolve(options.to)}`);
    if (skippedLinks) {
      console.error(`${skippedLinks} link${skippedLinks === 1 ? '' : 's'} skipped`);
    }
    if (failed.length > 0) {
      console.error(
        `${failed.length} file${failed.length === 1 ? '' : 's'} could not be decrypted and ${failed.length === 1 ? 'was' : 'were'} skipped:`,
      );
      for (const line of failed) {
        console.error(`  ${line}`);
      }
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(messageOf(error));
    return error instanceof LockedCliError ? error.exitCode : 2;
  }
}

/** The `locked decrypt` command. Bad arguments exit 2; `--help` exits 0. `exit` is replaceable for tests. */
export const buildLockedDecryptCommand = (exit: (code: number) => never = process.exit): Command =>
  new Command('decrypt')
    .description('Decrypt encrypted Locked files from a copy of the library (offline; no server or login needed)')
    .requiredOption('--library <directory>', 'The library folder (the one holding locked-keys/)')
    .requiredOption('--to <directory>', 'Where to write the decrypted files (must be outside the library)')
    .option('--user <name or ID>', "Whose files to decrypt (asked when there's more than one)")
    .option('--all', 'Also decrypt thumbnails, previews and other derived files into derived/<item ID>/', false)
    .exitOverride((error: CommanderError) => exit(error.exitCode === 0 ? 0 : 2))
    .action(async (options) => {
      process.exitCode = await runLockedDecrypt(options);
    });
