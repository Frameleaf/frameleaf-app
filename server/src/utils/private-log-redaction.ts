const REDACTED = '[redacted]';
// eslint-disable-next-line no-control-regex -- keep stored messages on one safe JSONL line
const control = /[\u{0}-\u{1F}\u{7F}]+/gu;
const secretParts =
  /authorization|cookies?|password|passphrase|pincode|token|secret|apikey|privatekey|sessionkey|codeverifier|licen[cs]ekey|linkcode|recovery(?:key|code|kit|phrase|seed)|keyring|(?:wrap(?:ping)?|bucket|encryption|master|root)key/;
const exactNames = new Set(['key', 'keys', 'code', 'state', 'slug', 'appleid', 'pin']);
const secretName = (name: string) => {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return secretParts.test(normalized) || exactNames.has(normalized);
};

/** The persistent log accepts text only. It never serializes a request, error object or stack. */
export const redactPrivateLog = (message: string): string => {
  if (message.length > 16_384) return '[oversized log message omitted]';

  return message
    .replaceAll(
      /-----BEGIN [^\r\n-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\r\n-]*PRIVATE KEY-----|$)/giu,
      () => REDACTED,
    )
    .replaceAll(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/giu, () => REDACTED)
    .replaceAll(/\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/giu, () => `Bearer ${REDACTED}`)
    .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, () => REDACTED)
    .replaceAll(/\b(?:https?|postgres(?:ql)?|s3):\/\/[^\s"'<>]+/giu, () => REDACTED)
    .replaceAll(
      /(?<![\w.-])(["']?[\w.-]{1,128}["']?)(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s&,;]+)/gu,
      (match, key: string, delimiter: string) => (secretName(key) ? `${key}${delimiter}${REDACTED}` : match),
    )
    .replaceAll(
      /(?<![\p{L}\p{N}.!#$%&\u{27}*+/=?^_`{|}~-])[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]{1,128}@[\p{L}\p{N}.-]+\.[\p{L}\p{N}-]+/gu,
      () => REDACTED,
    )
    .replaceAll(control, ' ')
    .slice(0, 4096);
};
