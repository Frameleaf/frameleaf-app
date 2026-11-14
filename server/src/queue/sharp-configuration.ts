import { availableParallelism, totalmem } from 'node:os';

/**
 * Default image children: one per two cores and per 4 GiB of the container's memory (its cgroup limit when it has
 * one), between 2 and 8. Each active child can hold its own 1 GiB+ budget, so a small NAS keeps 2 while a large
 * server stops funnelling every thumbnail, metadata read and render of a big import through two cores.
 */
export const automaticSharpWorkers = (cpus = availableParallelism(), memory = containerMemory()) =>
  Math.min(8, Math.max(2, Math.min(Math.floor(cpus / 2), Math.floor(memory / (4 * 1024 ** 3)))));

const containerMemory = () => {
  const limit = process.constrainedMemory?.() ?? 0;
  return limit > 0 && limit < totalmem() ? limit : totalmem();
};

export function sharpConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  };
  return {
    workers: integer('FRAMELEAF_SHARP_WORKERS', automaticSharpWorkers(), 1, 8),
    pending: integer('FRAMELEAF_SHARP_PENDING', 8, 0, 64),
    maxBytes: integer('FRAMELEAF_SHARP_MAX_BUFFER_BYTES', 1024 ** 3, 64 * 1024 ** 2, 8 * 1024 ** 3),
    pendingBytes: integer('FRAMELEAF_SHARP_PENDING_BYTES', 1024 ** 3, 64 * 1024 ** 2, 4 * 1024 ** 3),
    maxPixels: integer('FRAMELEAF_SHARP_MAX_PIXELS', 200_000_000, 1_000_000, 1_000_000_000),
  };
}
