import z from 'zod';

const vector = z.array(z.number().finite()).length(512);
const embedding = z
  .string()
  .max(65_536)
  .refine((value) => {
    try {
      return vector.safeParse(JSON.parse(value)).success;
    } catch {
      return false;
    }
  });
const coordinate = z.number().finite();
const schema = z
  .strictObject({
    imageWidth: z.number().int().positive().max(65_536),
    imageHeight: z.number().int().positive().max(65_536),
    'facial-recognition': z
      .array(
        z.strictObject({
          boundingBox: z.strictObject({ x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate }),
          embedding,
          score: z.number().finite().min(0).max(1),
        }),
      )
      .max(4096),
  })
  .refine(
    (result) =>
      result.imageWidth * result.imageHeight <= 16 * 1024 * 1024 &&
      result['facial-recognition'].every(
        ({ boundingBox: box }) =>
          -result.imageWidth <= box.x1 &&
          box.x1 < box.x2 &&
          box.x2 <= 2 * result.imageWidth &&
          -result.imageHeight <= box.y1 &&
          box.y1 < box.y2 &&
          box.y2 <= 2 * result.imageHeight,
      ),
  );

export const parseBoundFaceResult = (value: unknown) => schema.parse(value);
