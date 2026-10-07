import { createHash } from 'node:crypto';

export const HDR_RENDITION_RENDERER_VERSION = 'frameleaf-hdr-rendition/1';

export const imageRenditionIdentity = (input: {
  sourceChecksum: Buffer;
  editRevision: number;
  rendererVersion: string;
  width: number;
  height: number;
  gamut: 0 | 1 | 2;
  dynamicRange: 'sdr' | 'hdr';
}): string => {
  if (
    ![20, 32].includes(input.sourceChecksum.length) ||
    [input.editRevision, input.width, input.height].some((value) => !Number.isSafeInteger(value)) ||
    input.editRevision < 0 ||
    input.width < 1 ||
    input.height < 1 ||
    !input.rendererVersion ||
    input.rendererVersion.length > 120 ||
    ![0, 1, 2].includes(input.gamut)
  ) {
    throw new Error('INVALID_RENDITION_IDENTITY');
  }
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.sourceChecksum.toString('hex'),
        input.editRevision,
        input.rendererVersion,
        input.width,
        input.height,
        input.gamut,
        input.dynamicRange,
      ]),
    )
    .digest('hex');
};
