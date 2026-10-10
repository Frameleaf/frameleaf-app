import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
// Standalone image worker has no application alias loader.
// eslint-disable-next-line no-restricted-imports
import { SharpResourceLimitError } from './sharp-protocol.js';

export type { ImageEncodingInfo } from 'src/dtos/image-encoding.dto.js';
import type { ImageEncodingInfo } from 'src/dtos/image-encoding.dto.js';

export type LinearHdrImage = { data: Buffer; width: number; height: number; gamut: 0 | 1 | 2; referenceWhite: 203 };
export type PairedHdrImage = LinearHdrImage & { sdr: Buffer; sdrGamut: 0 | 1 | 2 };
export type HdrCodecCapabilities = {
  libheif: string;
  libultrahdr: string;
  heicDecoder: boolean;
  avifDecoder: boolean;
  appleGainMapDecoder?: boolean;
  isoGainMapDecoder?: boolean;
  renderer?: string;
  heicPqEncoder?: boolean;
};
type NativeCodec = {
  capabilities(): HdrCodecCapabilities;
  inspect(input: Buffer, maxPixels: number, maxBytes: number): ImageEncodingInfo;
  decode(input: Buffer, maxPixels: number, maxBytes: number): LinearHdrImage;
  decodePaired(input: Buffer, maxPixels: number, maxBytes: number): PairedHdrImage;
  encodePaired(
    input: Buffer,
    width: number,
    height: number,
    gamut: 0 | 1 | 2,
    maxPixels: number,
    maxBytes: number,
    sdr: Buffer,
    sdrGamut: 0 | 1 | 2,
  ): Buffer;
  encode(input: Buffer, width: number, height: number, gamut: 0 | 1 | 2, maxPixels: number, maxBytes: number): Buffer;
  encodeHeic(
    input: Buffer,
    width: number,
    height: number,
    gamut: 0 | 1 | 2,
    maxPixels: number,
    maxBytes: number,
  ): Buffer;
};
let codec: NativeCodec | undefined;
function binding(): NativeCodec {
  if (!codec) {
    codec = createRequire(import.meta.url)(
      process.env.FRAMELEAF_HDR_BINDING ?? '/usr/local/lib/frameleaf/image-hdr.node',
    ) as NativeCodec;
  }
  return codec;
}

/** Codec failures carry stable classifications; native diagnostics never include source paths or EXIF. */
export function imageHdrOperation<T>(operation: (codec: NativeCodec) => T): T {
  try {
    return operation(binding());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'RESOURCE_LIMIT') {
      throw new SharpResourceLimitError('HDR surfaces exceed the image worker budget');
    }
    throw error;
  }
}

export async function imageHdrInput(input: string | Buffer, maximum: number): Promise<Buffer> {
  const limit = Math.min(maximum, 128 * 1024 * 1024);
  if (Buffer.isBuffer(input)) {
    if (input.length > limit) throw new SharpResourceLimitError('HDR encoded input is too large');
    return input;
  }
  const file = await open(input, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new SharpResourceLimitError('HDR encoded input is too large');
    const data = Buffer.alloc(stat.size);
    let read = 0;
    while (read < data.length) {
      const { bytesRead } = await file.read(data, read, data.length - read, read);
      if (bytesRead === 0) throw new Error('IMAGE_SOURCE_CHANGED');
      read += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await file.read(extra, 0, 1, read)).bytesRead !== 0) throw new Error('IMAGE_SOURCE_CHANGED');
    return data;
  } finally {
    await file.close();
  }
}
