/**
 * A version 4 UUID for idempotency keys and local ids. `crypto.randomUUID` only exists on secure
 * origins, and many home servers are reached over plain http, so the key falls back to
 * `getRandomValues`, which works everywhere.
 */
export const newRequestKey = (): string => {
  const native = globalThis.crypto?.randomUUID?.();
  if (native) {
    return native;
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
