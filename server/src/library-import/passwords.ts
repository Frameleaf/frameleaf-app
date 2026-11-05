import { hashRaw as hashArgonRaw, parseOptions as parseArgonOptions } from '@node-rs/argon2';
import AsyncLock from 'async-lock';
import { compare, hash } from 'bcrypt';
import { createHash, pbkdf2 } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { SALT_ROUNDS } from 'src/constants.js';

const prefix = '$flimport$1$';
// Version 1's qualified storage floor stays stable when the default password cost increases.
const retainedMinimumRounds = 10;
const derivePbkdf2 = promisify(pbkdf2);
// The binding declares const enums; value maps also work with isolated TypeScript compilation.
const argonAlgorithms = { argon2i: 1, argon2id: 2 } as const;
const argonVersions = { 16: 0, 19: 1 } as const;
// Keep memory-hard verification independent of the server's general worker-pool size.
const expensivePasswordLock = new AsyncLock({ maxPending: 8, timeout: 10_000 });
const bcryptPattern = /^\$2[ab]\$(?:0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/;
const saltPattern = /^\$2[ab]\$(?:0[4-9]|1[0-6])\$[./A-Za-z0-9]{22}$/;
export type ImportedPasswordFormat =
  | 'bcrypt'
  | 'photoprism-bcrypt'
  | 'django-pbkdf2-sha256'
  | 'django-password'
  | 'php-password'
  | 'nextcloud-password'
  | 'piwigo-password';
const contextSchema = z.strictObject({
  operationId: z.uuid().transform((value) => value.toLowerCase()),
  sourceUserId: z.string().min(1).max(1024),
  destinationUserId: z.uuid().transform((value) => value.toLowerCase()),
});
export type ImportedPasswordContext = z.infer<typeof contextSchema>;
const bcryptSettings = z.strictObject({
  format: z.enum(['bcrypt', 'photoprism-bcrypt']),
  settings: z.string().regex(saltPattern),
});
const djangoSettings = z.strictObject({
  format: z.literal('django-pbkdf2-sha256'),
  settings: z.tuple([z.number().int().min(1).max(5_000_000), z.string().min(1).max(256)]),
});
const phpassAlphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const phpassPattern = /^\$P\$[5-9A-G][./0-9A-Za-z]{8}$/;
const phpassSettings = z.strictObject({
  format: z.literal('piwigo-phpass'),
  settings: z.string().regex(phpassPattern),
});
const piwigoMd5Settings = z.strictObject({ format: z.literal('piwigo-md5'), settings: z.literal('') });
const phcBase64 = (bytes: Buffer) => bytes.toString('base64').replaceAll('=', '');
const argonSettings = z.strictObject({
  format: z.enum(['argon2i', 'argon2id']),
  settings: z
    .strictObject({
      version: z.union([z.literal(16), z.literal(19)]),
      // Django's Argon2PasswordHasher default (LibrePhotos 1.5.1) is 102,400 KiB; verification stays serialized.
      memoryCost: z.number().int().min(8).max(102_400),
      timeCost: z.number().int().min(1).max(10),
      parallelism: z.number().int().min(1).max(16),
      outputLen: z.number().int().min(16).max(64),
      salt: z
        .string()
        .regex(/^[A-Za-z0-9+/]{11,86}$/)
        .refine((salt) => {
          const bytes = Buffer.from(salt, 'base64');
          return bytes.length >= 8 && bytes.length <= 64 && phcBase64(bytes) === salt;
        }),
    })
    .refine((value) => value.memoryCost >= 8 * value.parallelism),
});
type ArgonSettings = z.infer<typeof argonSettings>;
const envelope = z.discriminatedUnion('format', [
  bcryptSettings.extend({ verifier: z.string().regex(bcryptPattern) }),
  djangoSettings.extend({ verifier: z.string().regex(bcryptPattern) }),
  piwigoMd5Settings.extend({ verifier: z.string().regex(bcryptPattern) }),
  phpassSettings.extend({ verifier: z.string().regex(bcryptPattern) }),
  argonSettings.extend({ verifier: z.string().regex(bcryptPattern) }),
]);
type Settings =
  | z.infer<typeof bcryptSettings>
  | z.infer<typeof djangoSettings>
  | ArgonSettings
  | z.infer<typeof phpassSettings>
  | z.infer<typeof piwigoMd5Settings>;
const refused = (): never => {
  throw new Error('Imported password refused: SOURCE_PASSWORD_UNSUPPORTED');
};
/** Capture the exact owner mapping before a source query can yield to its caller. */
export const captureImportedPasswordContext = (input: unknown): Readonly<ImportedPasswordContext> => {
  try {
    return Object.freeze(contextSchema.parse(input));
  } catch {
    return refused();
  }
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const argonPrefix = ({ format, settings }: ArgonSettings) =>
  `$${format}$v=${settings.version}$m=${settings.memoryCost},t=${settings.timeCost},p=${settings.parallelism}$${settings.salt}$`;
const argonSourceSettings = (encoded: string): { settings: ArgonSettings; canonical: string } => {
  try {
    const parts = encoded.split('$');
    if (parts.length !== 6 || !/^v=(16|19)$/.test(parts[2])) return refused();
    const options = parseArgonOptions(encoded);
    if (options.algorithm !== argonAlgorithms.argon2i && options.algorithm !== argonAlgorithms.argon2id)
      return refused();
    const parsed = argonSettings.safeParse({
      format: parts[1],
      settings: {
        version: options.version === argonVersions[16] ? 16 : 19,
        memoryCost: options.memoryCost,
        timeCost: options.timeCost,
        parallelism: options.parallelism,
        outputLen: options.outputLen,
        salt: parts[4],
      },
    });
    const hashBytes = Buffer.from(parts[5], 'base64');
    if (!parsed.success || hashBytes.length !== options.outputLen || phcBase64(hashBytes) !== parts[5])
      return refused();
    const canonical = argonPrefix(parsed.data) + parts[5];
    if (canonical !== encoded) return refused();
    return { settings: parsed.data, canonical };
  } catch {
    return refused();
  }
};
const targetSalt = (context: ImportedPasswordContext, format: ImportedPasswordFormat): string => {
  const bytes = createHash('sha256')
    .update(
      JSON.stringify([
        'frameleaf-import-password:v1',
        context.operationId,
        context.sourceUserId,
        context.destinationUserId,
        format,
      ]),
    )
    .digest()
    .subarray(0, 16);
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bcrypt = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const salt = [...bytes.toString('base64').slice(0, 22)]
    .map((character) => bcrypt[standard.indexOf(character)])
    .join('');
  return `$2b$${String(SALT_ROUNDS).padStart(2, '0')}$${salt}`;
};

const sourceSettings = (format: ImportedPasswordFormat, encoded: string): { settings: Settings; canonical: string } => {
  if (typeof encoded !== 'string' || encoded.length > 2048) return refused();
  if (format === 'piwigo-password') {
    if (/^[0-9a-f]{32}$/.test(encoded)) return { settings: { format: 'piwigo-md5', settings: '' }, canonical: encoded };
    const settings = encoded.slice(0, 12);
    const tail = encoded.slice(12);
    if (!phpassPattern.test(settings) || !/^[./0-9A-Za-z]{21}[./01]$/.test(tail)) return refused();
    return { settings: { format: 'piwigo-phpass', settings }, canonical: encoded };
  }
  if (format === 'nextcloud-password') {
    if (!/^[123]\|/.test(encoded)) return refused();
    return sourceSettings('php-password', encoded.slice(2));
  }
  if (format === 'django-password')
    // Django stores Argon2 as its algorithm name followed by the standard PHC string.
    return encoded.startsWith('argon2$argon2')
      ? argonSourceSettings(encoded.slice('argon2'.length))
      : sourceSettings('django-pbkdf2-sha256', encoded);
  if (format === 'php-password')
    return encoded.startsWith('$argon2') ? argonSourceSettings(encoded) : sourceSettings('bcrypt', encoded);
  if (format === 'bcrypt' || format === 'photoprism-bcrypt') {
    // Modern PHP's $2y$ format uses the corrected bcrypt semantics represented by $2b$ in Node.
    const canonical = encoded.replace(/^\$2y\$/, '$2b$');
    if (!bcryptPattern.test(canonical)) return refused();
    const alphabet = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    if (alphabet.indexOf(canonical[28]) % 16 !== 0 || alphabet.indexOf(canonical[59]) % 4 !== 0) return refused();
    return { settings: { format, settings: canonical.slice(0, 29) }, canonical };
  }
  if (format === 'django-pbkdf2-sha256') {
    const parts = encoded.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256' || !/^[1-9]\d{0,6}$/.test(parts[1])) return refused();
    const iterations = Number(parts[1]);
    const salt = parts[2];
    if (
      iterations > 5_000_000 ||
      !salt ||
      salt.length > 256 ||
      Buffer.from(parts[3], 'base64').length !== 32 ||
      Buffer.from(parts[3], 'base64').toString('base64') !== parts[3]
    )
      return refused();
    return { settings: { format, settings: [iterations, salt] }, canonical: encoded };
  }
  return refused();
};

const sourceSpace = /^\p{White_Space}$/u;
const trimSourceSpace = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && sourceSpace.test(value[start])) start++;
  while (end > start && sourceSpace.test(value[end - 1])) end--;
  return value.slice(start, end);
};

const sourceHash = async (password: string, settings: Settings): Promise<string> => {
  if (settings.format === 'piwigo-md5') {
    if (Buffer.byteLength(password, 'utf8') > 4096) return refused();
    return createHash('md5').update(password, 'utf8').digest('hex');
  }
  if (settings.format === 'piwigo-phpass') {
    const input = Buffer.from(password, 'utf8');
    if (input.length > 4096) return refused();
    return expensivePasswordLock.acquire('imported-password', async () => {
      let bytes = createHash('md5').update(settings.settings.slice(4)).update(input).digest();
      const rounds = 2 ** phpassAlphabet.indexOf(settings.settings[3]);
      for (let index = 0; index < rounds; index++) {
        bytes = createHash('md5').update(bytes).update(input).digest();
        // PHPass is iterative MD5, not PBKDF2; yield so imported logins cannot stall the event loop.
        if ((index + 1) % 1024 === 0) await setImmediate();
      }
      let encoded = '';
      for (let bit = 0; bit < 128; bit += 6) {
        const offset = Math.floor(bit / 8);
        const value = bytes[offset] | ((bytes[offset + 1] ?? 0) << 8);
        encoded += phpassAlphabet[(value >> (bit % 8)) & 63];
      }
      return settings.settings + encoded;
    });
  }
  if (settings.format === 'argon2i' || settings.format === 'argon2id') {
    const { salt, version, ...options } = settings.settings;
    const bytes = await expensivePasswordLock.acquire('imported-password', () =>
      hashArgonRaw(password, {
        ...options,
        salt: Buffer.from(salt, 'base64'),
        algorithm: argonAlgorithms[settings.format],
        version: argonVersions[version],
      }),
    );
    return argonPrefix(settings) + phcBase64(bytes);
  }
  if (settings.format === 'django-pbkdf2-sha256') {
    const [iterations, salt] = settings.settings;
    const bytes = await derivePbkdf2(password, salt, iterations, 32, 'sha256');
    return `pbkdf2_sha256$${iterations}$${salt}$${bytes.toString('base64')}`;
  }
  if (settings.format === 'bcrypt' || settings.format === 'photoprism-bcrypt') {
    // Go's strings.TrimSpace includes NEL and excludes BOM, unlike JavaScript trim().
    const input = settings.format === 'photoprism-bcrypt' ? trimSourceSpace(password) : password;
    if (settings.format === 'photoprism-bcrypt' && input.length === 0) return refused();
    return hash(input, settings.settings);
  }
  return refused();
};

const decodeImportedPassword = (encoded: string) => {
  const payload = encoded.slice(prefix.length);
  if (payload.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(payload)) return refused();
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.toString('base64url') !== payload) return refused();
  return envelope.parse(JSON.parse(bytes.toString('utf8')));
};

/** A private credential capability: serialization and inspection never reveal its stored verifier. */
export class ImportedPassword {
  readonly operationId: string;
  readonly sourceUserId: string;
  readonly destinationUserId: string;
  #encoded: string;
  private constructor(context: ImportedPasswordContext, encoded: string) {
    this.operationId = context.operationId;
    this.sourceUserId = context.sourceUserId;
    this.destinationUserId = context.destinationUserId;
    this.#encoded = encoded;
    Object.freeze(this);
  }
  static async fromSource(input: unknown, format: ImportedPasswordFormat, encoded: string): Promise<ImportedPassword> {
    const context = captureImportedPasswordContext(input);
    const { settings, canonical } = sourceSettings(format, encoded);
    // Wrapping the old verifier raises storage protection to the destination policy without knowing plaintext.
    // Public, unique operation/owner IDs make its salt stable on resume without exposing a source-hash fingerprint.
    const verifier = await hash(digest(canonical), targetSalt(context, format));
    const value = envelope.parse({ ...settings, verifier });
    return new ImportedPassword(context, prefix + Buffer.from(JSON.stringify(value)).toString('base64url'));
  }
  /** Private recovery only: the archive must independently establish retained-record integrity and source qualification. */
  static fromRetained(input: unknown, encoded: unknown): ImportedPassword {
    try {
      const context = contextSchema.parse(input);
      if (typeof encoded !== 'string' || !encoded.startsWith(prefix)) return refused();
      const value = decodeImportedPassword(encoded);
      if (Number(value.verifier.slice(4, 6)) < retainedMinimumRounds) return refused();
      const formats: ImportedPasswordFormat[] =
        value.format === 'bcrypt'
          ? ['bcrypt', 'php-password', 'nextcloud-password']
          : value.format === 'argon2i' || value.format === 'argon2id'
            ? ['php-password', 'nextcloud-password', 'django-password']
            : value.format === 'piwigo-md5' || value.format === 'piwigo-phpass'
              ? ['piwigo-password']
              : value.format === 'django-pbkdf2-sha256'
                ? ['django-pbkdf2-sha256', 'django-password']
                : [value.format];
      if (formats.every((format) => value.verifier.slice(7, 29) !== targetSalt(context, format).slice(7)))
        return refused();
      return new ImportedPassword(context, encoded);
    } catch {
      return refused();
    }
  }
  forImport(): string {
    return this.#encoded;
  }
  toJSON(): string {
    return '[imported password redacted]';
  }
  toString(): string {
    return this.toJSON();
  }
}

/** Undefined selects the existing native bcrypt path; malformed imported values fail closed. */
export async function verifyImportedPassword(password: string, encoded: string): Promise<boolean | undefined> {
  if (!encoded.startsWith(prefix)) return;
  try {
    const settings = decodeImportedPassword(encoded);
    const candidate = await sourceHash(password, settings);
    return await compare(digest(candidate), settings.verifier);
  } catch {
    return false;
  }
}
