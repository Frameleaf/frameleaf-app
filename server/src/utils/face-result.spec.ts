import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { parseBoundFaceResult } from 'src/utils/face-result.js';
import { canonicalJson } from 'src/utils/object.js';

const profile = () => JSON.parse(readFileSync('test/fixtures/desktop-face-profile.json', 'utf8'));
it('admits both exact face engines and validates their 512-value producer output', () => {
  const value = profile();
  const catalogue = parseDesktopModelCatalogue({ schemaVersion: 1, epoch: 5, profiles: [value] });
  expect(catalogue.profiles[0].workload).toBe('face');
  const result = parseBoundFaceResult(value.spec.expectedOutput);
  expect(result['facial-recognition']).toHaveLength(1);
  expect(JSON.parse(result['facial-recognition'][0].embedding)).toHaveLength(512);
  expect(
    parseBoundFaceResult({ ...value.spec.expectedOutput, 'facial-recognition': [] })['facial-recognition'],
  ).toEqual([]);
});
it.each(['vector', 'score', 'box', 'dimensions', 'extra'])('refuses malformed %s face output', (mode) => {
  const result = profile().spec.expectedOutput;
  const face = result['facial-recognition'][0];
  switch (mode) {
    case 'vector': {
      face.embedding = JSON.stringify([1, 2]);
      break;
    }
    case 'score': {
      face.score = NaN;
      break;
    }
    case 'box': {
      face.boundingBox.x2 = face.boundingBox.x1;
      break;
    }
    case 'dimensions': {
      result.imageWidth = 0;
      break;
    }
    case 'extra': {
      face.path = '/untrusted';
      // No default
      break;
    }
  }
  expect(() => parseBoundFaceResult(result)).toThrow();
});

it.each(['engine', 'task', 'role', 'weights', 'dimension', 'options', 'fixture'])(
  'refuses a face catalogue %s change even with a newly sealed logical identity',
  (change) => {
    const value = profile();
    switch (change) {
      case 'engine': {
        value.spec.models.pop();
        break;
      }
      case 'task': {
        value.spec.models[1].task = 'ocr';
        break;
      }
      case 'role': {
        value.spec.models[1].type = 'detection';
        break;
      }
      case 'weights': {
        value.spec.models[1].artifacts['recognition/model.onnx'] = 'f'.repeat(64);
        break;
      }
      case 'dimension': {
        value.embeddingDimensions = 768;
        break;
      }
      case 'options': {
        value.spec.entries['facial-recognition'].detection.options.extra = true;
        break;
      }
      case 'fixture': {
        value.spec.expectedOutput['facial-recognition'] = [];
        // No default
        break;
      }
    }
    const { protocolVersion, entries, models, preprocessingSha256 } = value.spec;
    value.modelKey = value.spec.modelKey =
      'face:' +
      createHash('sha256')
        .update(canonicalJson({ protocolVersion, entries, models, preprocessingSha256 }))
        .digest('hex');
    expect(() => parseDesktopModelCatalogue({ schemaVersion: 1, epoch: 5, profiles: [value] })).toThrow();
  },
);
