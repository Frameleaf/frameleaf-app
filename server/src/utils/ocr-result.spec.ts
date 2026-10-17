import { parseBoundOcrResult } from 'src/utils/ocr-result.js';

const result = () => ({
  imageWidth: 768,
  imageHeight: 320,
  ocr: { box: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9], boxScore: [0.9], text: ['Frameleaf'], textScore: [0.9] },
});
it('keeps normalized OCR arrays aligned and permits empty detections', () => {
  expect(parseBoundOcrResult(result()).ocr.text).toEqual(['Frameleaf']);
  expect(
    parseBoundOcrResult({ imageWidth: 768, imageHeight: 320, ocr: { box: [], boxScore: [], text: [], textScore: [] } })
      .ocr.text,
  ).toEqual([]);
});
it('rejects invalid dimensions, boxes, confidence, text and parallel array lengths', () => {
  for (const change of [
    (v: ReturnType<typeof result>) => {
      v.imageWidth = 0;
    },
    (v: ReturnType<typeof result>) => {
      v.imageWidth = v.imageHeight = 65_536;
    },
    (v: ReturnType<typeof result>) => {
      v.ocr.box[0] = -0.1;
    },
    (v: ReturnType<typeof result>) => {
      v.ocr.box[0] = 1.1;
    },
    (v: ReturnType<typeof result>) => {
      v.ocr.boxScore[0] = NaN;
    },
    (v: ReturnType<typeof result>) => {
      v.ocr.text[0] = '';
    },
    (v: ReturnType<typeof result>) => {
      v.ocr.textScore.pop();
    },
  ]) {
    const value = result();
    change(value);
    expect(() => parseBoundOcrResult(value)).toThrow();
  }
});
