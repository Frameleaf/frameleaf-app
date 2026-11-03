/** Pinned dotLottie v1/v2 packaging; byte reads reuse the bounded bundle reader. */
import { tryPromise } from 'src/utils/promise.js';
import { StudioImportRefusal } from 'src/utils/studio-imports.js';
import { readZipDirectory, readZipEntry } from 'src/utils/studio-zip-reader.js';

const MAX_BYTES = 16 * 1024 * 1024;
const fail = (): never => {
  throw new StudioImportRefusal('Lottie archive refused');
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return fail();
  return value;
};
/** Duplicate-key rejection precedes JSON.parse, which would otherwise discard evidence. */
export function parseArchiveJson(text: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).length > MAX_BYTES) return fail();
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  let cursor = 0;
  const value = (depth: number): void => {
    if (depth > 64) return fail();
    const token = tokens[cursor++];
    if (token === '{') {
      const keys = new Set<string>();
      if (tokens[cursor] === '}') {
        cursor++;
        return;
      }
      do {
        const key: unknown = JSON.parse(tokens[cursor++] ?? '');
        if (typeof key !== 'string' || keys.has(key) || tokens[cursor++] !== ':') return fail();
        keys.add(key);
        value(depth + 1);
        if (tokens[cursor] === '}') {
          cursor++;
          return;
        }
      } while (tokens[cursor++] === ',');
      return fail();
    }
    if (token === '[') {
      if (tokens[cursor] === ']') {
        cursor++;
        return;
      }
      do {
        value(depth + 1);
        if (tokens[cursor] === ']') {
          cursor++;
          return;
        }
      } while (tokens[cursor++] === ',');
      return fail();
    }
    if (token === undefined || ['}', ']', ':', ','].includes(token)) return fail();
  };
  value(0);
  if (cursor !== tokens.length) return fail();
  return record(JSON.parse(text));
}
export type LottieArchive = {
  files: Record<string, Uint8Array>;
  animations: Array<{
    id: string;
    entry: string;
    document: Record<string, unknown>;
    themes?: string[];
    initialTheme?: string;
  }>;
  themes: Map<string, string>;
  defaultAnimationId: string;
};

/** Expressions have no established closed-resource execution contract in this flow. */
export function assertArchiveExpressionsAbsent(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertArchiveExpressionsAbsent(item);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'x' && typeof child === 'string' && child.length > 0) return fail();
    assertArchiveExpressionsAbsent(child);
  }
}

export async function readLottieArchive(bytes: Uint8Array): Promise<LottieArchive> {
  const files: Record<string, Uint8Array> = Object.create(null);
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const source = {
      size: buffer.length,
      read: (offset: number, length: number) => tryPromise(() => buffer.subarray(offset, offset + length)),
    };
    const directory = await readZipDirectory(source, {
      strictPaths: true,
      maxBytes: MAX_BYTES,
      maxEntries: 256,
      maxDirectoryBytes: 1024 * 1024,
      maxUncompressedBytes: MAX_BYTES,
      documentLimit: () => MAX_BYTES,
      allowZip64: false,
    });
    const aliases = new Set<string>();
    for (const entry of directory.entries) {
      // UTF-8 names (bit 11), data descriptors (bit 3) and deflate level hints (bits 1-2) are safe.
      if (aliases.has(entry.name.toLowerCase()) || (entry.flags ?? 0) & ~0x8_0e) return fail();
      aliases.add(entry.name.toLowerCase());
      files[entry.name] = await readZipEntry(source, entry, MAX_BYTES);
    }
    return describeLottieArchive(files);
  } catch {
    for (const file of Object.values(files)) if (file.buffer !== bytes.buffer) file.fill(0);
    // This in-memory parser maps malformed ZIP/UTF-8/JSON to the existing import refusal.
    return fail();
  }
}
/** Manifest paths are exact; aliases, fallback and unvalidated active content are refused. */
export function describeLottieArchive(files: Record<string, Uint8Array>): LottieArchive {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const read = (name: string) => {
    if (!files[name]) return fail();
    return parseArchiveJson(decoder.decode(files[name]));
  };
  const manifest = read('manifest.json');
  if (manifest.version !== undefined && manifest.version !== '1' && manifest.version !== '2') return fail();
  if (manifest.stateMachines !== undefined || (manifest.initial && record(manifest.initial).stateMachine !== undefined))
    return fail();
  if (!Array.isArray(manifest.animations) || manifest.animations.length === 0 || manifest.animations.length > 128)
    return fail();
  const prefix = manifest.version === '2' ? 'a' : 'animations';
  const known = new Set(['manifest.json']),
    ids = new Set<string>();
  const animations = manifest.animations.map((raw) => {
    const item = record(raw),
      animationId = id(item.id),
      entry = `${prefix}/${animationId}.json`;
    if (ids.has(animationId)) return fail();
    ids.add(animationId);
    known.add(entry);
    const document = read(entry);
    assertArchiveExpressionsAbsent(document);
    if (typeof document.v !== 'string' || !Array.isArray(document.layers)) return fail();
    if (item.themes !== undefined && !Array.isArray(item.themes)) return fail();
    return {
      id: animationId,
      entry,
      document,
      ...(Array.isArray(item.themes) && { themes: item.themes.map((value) => id(value)) }),
      ...(item.initialTheme !== undefined && { initialTheme: id(item.initialTheme) }),
    };
  });
  const initialAnimation = manifest.initial ? record(manifest.initial).animation : undefined;
  const defaultAnimationId = initialAnimation === undefined ? animations[0]!.id : id(initialAnimation);
  if (!ids.has(defaultAnimationId)) return fail();
  const themes = new Map<string, string>();
  if (manifest.themes !== undefined && !Array.isArray(manifest.themes)) return fail();
  for (const raw of (manifest.themes ?? []) as unknown[]) {
    const themeId = id(record(raw).id),
      entry = `t/${themeId}.json`;
    if (themes.has(themeId)) return fail();
    const theme = read(entry);
    validateArchiveTheme(theme, ids);
    themes.set(themeId, JSON.stringify(theme));
    known.add(entry);
  }
  for (const raw of manifest.animations) {
    const item = record(raw);
    if (
      item.initialTheme !== undefined &&
      (!themes.has(id(item.initialTheme)) || (Array.isArray(item.themes) && !item.themes.includes(item.initialTheme)))
    )
      return fail();
    if (item.themes !== undefined && (!Array.isArray(item.themes) || item.themes.some((t) => !themes.has(id(t)))))
      return fail();
  }
  for (const name of Object.keys(files)) {
    if (known.has(name)) continue;
    if (
      !new RegExp(`^${manifest.version === '2' ? 'i' : 'images'}/[A-Za-z0-9_.-]+$`).test(name) &&
      !/^f\/[A-Za-z0-9_.-]+$/.test(name)
    )
      return fail();
  }
  return { files, animations, themes, defaultAnimationId };
}
/** Pinned core theme.rs static, resource-free subset. Other branches remain explicit refusals. */
export function validateArchiveTheme(theme: Record<string, unknown>, animations: Set<string>): void {
  if (Object.keys(theme).some((k) => k !== 'rules') || !Array.isArray(theme.rules) || theme.rules.length > 1024)
    return fail();
  const seen = new Set<string>();
  for (const raw of theme.rules) {
    const rule = record(raw),
      slot = id(rule.id);
    if (seen.has(slot) || Object.keys(rule).some((k) => !['id', 'type', 'animations', 'value'].includes(k)))
      return fail();
    seen.add(slot);
    if (
      rule.animations !== undefined &&
      (!Array.isArray(rule.animations) || rule.animations.some((a) => !animations.has(id(a))))
    )
      return fail();
    switch (rule.type) {
      case 'Scalar': {
        if (typeof rule.value !== 'number' || !Number.isFinite(rule.value)) return fail();

        break;
      }
      case 'Color':
      case 'Vector': {
        if (
          !Array.isArray(rule.value) ||
          !(rule.type === 'Color' ? [3, 4] : [2]).includes(rule.value.length) ||
          rule.value.some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
          (rule.type === 'Color' && rule.value.some((v) => v < 0 || v > 1))
        )
          return fail();

        break;
      }
      case 'Text': {
        const value = record(rule.value);
        if (
          Object.keys(value).some((k) => k !== 'text') ||
          typeof value.text !== 'string' ||
          value.text.length > 10_000
        )
          return fail();

        break;
      }
      default: {
        return fail();
      }
    }
  }
}
export function selectArchiveAnimation(archive: LottieArchive, requested?: string) {
  const animation = archive.animations.find((a) => a.id === (requested ?? archive.defaultAnimationId));
  if (!animation) return fail();
  return animation;
}
