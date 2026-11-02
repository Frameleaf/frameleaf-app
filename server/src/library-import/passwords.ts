import { compare, hash } from 'bcrypt';
import { createHash, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { SALT_ROUNDS } from 'src/constants.js';

const prefix = '$flimport$1$';
const derivePbkdf2 = promisify(pbkdf2);
const bcryptPattern = /^\$2[ab]\$(?:0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/;
const saltPattern = /^\$2[ab]\$(?:0[4-9]|1[0-6])\$[./A-Za-z0-9]{22}$/;
export type ImportedPasswordFormat = 'bcrypt' | 'photoprism-bcrypt' | 'django-pbkdf2-sha256';
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
const envelope = z.discriminatedUnion('format', [
  bcryptSettings.extend({ verifier: z.string().regex(bcryptPattern) }),
  djangoSettings.extend({ verifier: z.string().regex(bcryptPattern) }),
]);
type Settings = z.infer<typeof bcryptSettings> | z.infer<typeof djangoSettings>;
const refused = (): never => {
  throw new Error('Imported password refused: SOURCE_PASSWORD_UNSUPPORTED');
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
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
  if (settings.format === 'django-pbkdf2-sha256') {
    const [iterations, salt] = settings.settings;
    const bytes = await derivePbkdf2(password, salt, iterations, 32, 'sha256');
    return `pbkdf2_sha256$${iterations}$${salt}$${bytes.toString('base64')}`;
  }
  // Go's strings.TrimSpace includes NEL and excludes BOM, unlike JavaScript trim().
  const input = settings.format === 'photoprism-bcrypt' ? trimSourceSpace(password) : password;
  if (settings.format === 'photoprism-bcrypt' && input.length === 0) return refused();
  return hash(input, settings.settings);
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
    const parsed = contextSchema.safeParse(input);
    if (!parsed.success) return refused();
    const context = parsed.data;
    const { settings, canonical } = sourceSettings(format, encoded);
    // Wrapping the old verifier raises storage protection to the destination policy without knowing plaintext.
    // Public, unique operation/owner IDs make its salt stable on resume without exposing a source-hash fingerprint.
    const verifier = await hash(digest(canonical), targetSalt(context, format));
    const value = envelope.parse({ ...settings, verifier });
    return new ImportedPassword(context, prefix + Buffer.from(JSON.stringify(value)).toString('base64url'));
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
    const payload = encoded.slice(prefix.length);
    if (payload.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(payload)) return false;
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) return false;
    const settings = envelope.parse(JSON.parse(bytes.toString('utf8')));
    const candidate = await sourceHash(password, settings);
    return await compare(digest(candidate), settings.verifier);
  } catch {
    return false;
  }
}
