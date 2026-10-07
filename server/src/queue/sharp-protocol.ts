import type { SharpOperations } from 'src/queue/sharp-operations.js';

export const SHARP_OPERATIONS = [
  'getHdrCodecCapabilities',
  'inspectImageEncoding',
  'decodeHdrImage',
  'encodeHdrImage',
  'generateHdrRenditions',
  'decodeImage',
  'generateImageThumbnails',
  'generateThumbnail',
  'writeCloudUpload',
  'writeStrippedStill',
  'composeImageGrid',
  'renderDevelopGeometry',
  'encodeDevelopOutput',
  'generateThumbhash',
  'normalizeDevelopArtifact',
  'decodeDevelopArtifact',
  'getImageMetadata',
  'getOrientedSize',
  'scoreThumbnailCandidate',
] as const;
export type SharpOperation = (typeof SHARP_OPERATIONS)[number];
export type SharpArguments<K extends SharpOperation> = Parameters<SharpOperations[K]>;
export type SharpResult<K extends SharpOperation> = Awaited<ReturnType<SharpOperations[K]>>;
export type SharpRequest = {
  id: number;
  operation: SharpOperation;
  args: unknown[];
  maxPixels: number;
  maxBytes: number;
};
export type SharpResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: number; completed: number }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'failure'; id: number; message: string; resourceLimit: boolean; decodeFailure?: boolean };

/** Only the initial decode of a thumbnail batch may fall back to the RAW sensor renderer. */
export class SharpDecodeError extends Error {}

export class SharpResourceLimitError extends Error {
  constructor(message: string) {
    super(`Sharp resource limit: ${message}`);
  }
}

/** Count IPC bytes without JSON-encoding or copying the image buffers. */
export function sharpPayloadBytes(value: unknown, depth = 0): number {
  if (depth > 20) {
    throw new SharpResourceLimitError('request nesting exceeds 20 levels');
  }
  if (Buffer.isBuffer(value)) {
    return value.byteLength;
  }
  if (typeof value === 'string') {
    return Buffer.byteLength(value);
  }
  if (Array.isArray(value)) {
    let bytes = 0;
    for (const item of value) {
      bytes += sharpPayloadBytes(item, depth + 1);
    }
    return bytes;
  }
  if (value && typeof value === 'object') {
    let bytes = 0;
    for (const [key, item] of Object.entries(value)) {
      bytes += Buffer.byteLength(key) + sharpPayloadBytes(item, depth + 1);
    }
    return bytes;
  }
  return 8;
}

export function assertSharpPixels(width: number, height: number, maximum: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > maximum
  ) {
    throw new SharpResourceLimitError(`image dimensions exceed ${maximum} pixels`);
  }
}
