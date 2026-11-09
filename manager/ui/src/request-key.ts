// getRandomValues remains available on HTTP home-lab origins; randomUUID does not.
export function requestKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One key per reviewed start (FL-1323): a retry after a lost response reuses it, so Manager answers with the
 * operation it already started instead of refusing a second one. Forget the key once the start succeeds or the
 * review is closed.
 */
export function startKey(keys: Map<string, string>, reviewId: string): string {
  let key = keys.get(reviewId);
  if (!key) {
    key = requestKey();
    keys.set(reviewId, key);
  }
  return key;
}
