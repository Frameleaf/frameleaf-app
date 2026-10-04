// FL-330: every default machine-learning model the server asks for must resolve on the model source the ML service
// downloads from by default. Run with `pnpm exec vitest run --config test/vitest.config.model-mirror.mjs`; it calls
// the Frameleaf model mirror, so it lives outside the offline unit suite and runs in the model-mirror-defaults workflow.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaults } from 'src/config.js';

const MODEL_SOURCE_ORG = 'frameleaf';

const readDefaultModelSource = () => {
  const config = readFileSync(resolve(import.meta.dirname, '../../../machine-learning/immich_ml/config.py'), 'utf8');
  const match = /^DEFAULT_MODEL_SOURCE_URL = "(https:\/\/[^"]+)"$/m.exec(config);
  if (!match) {
    throw new Error('DEFAULT_MODEL_SOURCE_URL not found in machine-learning/immich_ml/config.py');
  }
  return match[1].replace(/\/+$/, '');
};

const source = process.env.FRAMELEAF_MODEL_MIRROR_URL?.replace(/\/+$/, '') || readDefaultModelSource();

const { clip, facialRecognition, ocr } = defaults.machineLearning;
const models = [
  { task: 'smart search (clip)', name: clip.modelName },
  { task: 'facial recognition', name: facialRecognition.modelName },
  { task: 'ocr', name: ocr.modelName },
];

describe('default models on the model mirror', () => {
  it('uses the Frameleaf model mirror by default', () => {
    expect(readDefaultModelSource()).toBe('https://models.frameleaf.cloud');
  });

  it.each(models)('serves the default $task model $name', async ({ name }) => {
    const url = `${source}/api/models/${MODEL_SOURCE_ORG}/${encodeURIComponent(name)}/revision/main`;
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    expect(response.status, `${url} must answer 200; publish the model on the mirror before making it a default`).toBe(
      200,
    );
    const listing = (await response.json()) as { siblings?: Array<{ rfilename: string }> };
    const files = (listing.siblings ?? []).map(({ rfilename }) => rfilename);
    expect(
      files.some((file) => file.endsWith('model.onnx')),
      `${name} lists no ONNX model file`,
    ).toBe(true);
  });
});
