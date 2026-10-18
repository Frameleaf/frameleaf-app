import z from 'zod';

const score = z.number().finite().min(0).max(1);
const schema = z
  .strictObject({
    imageWidth: z.number().int().positive().max(65_536),
    imageHeight: z.number().int().positive().max(65_536),
    ocr: z.strictObject({
      box: z.array(score).max(4096 * 8),
      boxScore: z.array(score).max(4096),
      text: z.array(z.string().min(1).max(16_384)).max(4096),
      textScore: z.array(score).max(4096),
    }),
  })
  .refine(
    ({ imageWidth, imageHeight, ocr }) =>
      imageWidth * imageHeight <= 16 * 1024 * 1024 &&
      ocr.box.length === ocr.text.length * 8 &&
      ocr.boxScore.length === ocr.text.length &&
      ocr.textScore.length === ocr.text.length,
  );

/** OCR boxes are normalized; an empty detection is valid, mismatched arrays never are. */
export const parseBoundOcrResult = (value: unknown) => schema.parse(value);
