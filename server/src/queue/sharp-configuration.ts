export function sharpConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  };
  return {
    workers: integer('FRAMELEAF_SHARP_WORKERS', 2, 1, 8),
    pending: integer('FRAMELEAF_SHARP_PENDING', 8, 0, 64),
    maxBytes: integer('FRAMELEAF_SHARP_MAX_BUFFER_BYTES', 1024 ** 3, 64 * 1024 ** 2, 8 * 1024 ** 3),
    pendingBytes: integer('FRAMELEAF_SHARP_PENDING_BYTES', 1024 ** 3, 64 * 1024 ** 2, 4 * 1024 ** 3),
    maxPixels: integer('FRAMELEAF_SHARP_MAX_PIXELS', 200_000_000, 1_000_000, 1_000_000_000),
  };
}
