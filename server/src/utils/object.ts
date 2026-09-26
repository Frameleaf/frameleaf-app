import { isEqual, isPlainObject } from 'lodash-es';

/**
 * Deeply clones and converts a class instance to a plain object.
 */
export function toPlainObject<T extends object>(obj: T): T {
  return isPlainObject(obj) ? obj : structuredClone(obj);
}

/**
 * Performs a deep comparison between objects, converting them to plain objects first if needed.
 */
export function isEqualObject(value: object, other: object): boolean {
  return isEqual(toPlainObject(value), toPlainObject(other));
}

/**
 * Serialises a value with object keys sorted and undefined properties left out, so equal values
 * always produce the same text whatever their key order. Used for revision digests (FL-77, FL-66).
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
};
