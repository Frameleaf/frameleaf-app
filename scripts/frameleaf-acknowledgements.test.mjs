import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DOCS_PATH,
  NOTICES_PATH,
  buildDocs,
  buildNotices,
  checkAcknowledgements,
  libraryModelIds,
  load,
  railUseRestrictions,
} from './frameleaf-acknowledgements.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));

test('every engine, model, voice, font and asset is credited and ships a licence text (FL-86)', async () => {
  const inputs = await load(repository);
  assert.deepEqual(checkAcknowledgements(inputs), []);
  // The owner's named credits are present (FL-146, 2026-09-25).
  const ids = new Set(inputs.acknowledgements.components.map((entry) => entry.id));
  for (const id of [
    'freecut',
    'insightface',
    'openai-clip',
    'siglip',
    'nllb-clip',
    'm-clip',
    'pp-ocrv5',
    'whisper',
    'parakeet-tdt',
    'supertonic-3',
    'lfm2.5-vl',
    'kokoro',
    'moss-tts-nano',
    'all-minilm-l6-v2',
    'gemma-4',
    'rife',
    'clap-htsat-unfused',
    'musicgen-small',
    'lottiefiles',
  ]) {
    assert.ok(ids.has(id), id);
  }
  assert.equal(inputs.acknowledgements.fonts.families.length, 121);
});

test('the published documents are current', async () => {
  const inputs = await load(repository);
  assert.equal(await readFile(path.join(repository, DOCS_PATH), 'utf8'), buildDocs(inputs.acknowledgements, inputs.files));
  assert.equal(await readFile(path.join(repository, NOTICES_PATH), 'utf8'), buildNotices(inputs.acknowledgements, inputs.files));
});

test('the docs page reproduces Freecut’s licence and the Open RAIL-M use restrictions verbatim', async () => {
  const docs = await readFile(path.join(repository, DOCS_PATH), 'utf8');
  const freecut = await readFile(path.join(repository, 'studio/notices/freecut.txt'), 'utf8');
  assert.ok(docs.includes(freecut.trim()));
  const rail = await readFile(path.join(repository, 'licenses/texts/supertonic-3-openrail-m.txt'), 'utf8');
  const restrictions = railUseRestrictions(rail);
  assert.ok(restrictions && restrictions.startsWith('Attachment A'));
  assert.ok(docs.includes(restrictions));
  const notices = await readFile(path.join(repository, NOTICES_PATH), 'utf8');
  assert.ok(notices.includes(freecut.trim()));
});

test('a bundled engine or model without a shipped notice file fails the check', async () => {
  const inputs = await load(repository);
  const acknowledgements = structuredClone(inputs.acknowledgements);
  acknowledgements.components.find((entry) => entry.id === 'rife').noticeFiles = [];
  acknowledgements.components.find((entry) => entry.id === 'kokoro').noticeFiles = ['licenses/texts/missing.txt'];
  const problems = checkAcknowledgements({ ...inputs, acknowledgements });
  assert.ok(problems.includes('rife: no licence text ships with this engine or model'));
  assert.ok(problems.includes('kokoro: notice file licenses/texts/missing.txt does not exist'));
});

test('an uncredited model, a changed licence text or a retyped Freecut licence fails the check', async () => {
  const inputs = await load(repository);
  const uncredited = checkAcknowledgements({ ...inputs, libraryIds: [...inputs.libraryIds, 'ml:clip:NewModel__unknown'] });
  assert.ok(uncredited.includes('ml:clip:NewModel__unknown: not credited in licenses/acknowledgements.json'));

  const files = new Map(inputs.files);
  files.set('licenses/texts/apache-2.0.txt', Buffer.from('Apache, roughly'));
  files.set('studio/notices/freecut.txt', Buffer.from('MIT License\n\nCopyright (c) Freecut\n'));
  const tampered = checkAcknowledgements({ ...inputs, files });
  assert.ok(tampered.some((problem) => problem.startsWith('licenses/texts/apache-2.0.txt: changed since it was retrieved')));
  assert.ok(tampered.includes('freecut: studio/notices/freecut.txt is not the pinned upstream LICENSE'));
});

test('library model ids come from the machine learning service and the server defaults', async () => {
  const ids = libraryModelIds({
    constants: '_OPENCLIP_MODELS = {\n    "ViT-B-32__openai",\n}\n_MCLIP_MODELS = {\n    "LABSE-Vit-L-14",\n}\n_INSIGHTFACE_MODELS = {\n    "buffalo_l",\n}\n_PADDLE_MODELS = {\n    "PP-OCRv5_mobile",\n}\n',
    description:
      'OPENVINO_MODEL_ALIASES = {\n    "Qwen/Qwen2.5-VL-3B-Instruct": "llmware/qwen2.5-vl-3b-ov",\n}\nFLORENCE_MODEL_NAMES = {\n    "microsoft/Florence-2-base",\n}\n',
    serverConfig:
      "const imageDescriptionDefaults = {\n  modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',\n  fallbackModelName: 'microsoft/Florence-2-base-ft',\n};\nconst nsfwDetectionDefaults = {\n  modelName: 'onnx-community/nsfw_image_detection-ONNX',\n};",
  });
  assert.deepEqual(ids, [
    'ml:clip:ViT-B-32__openai',
    'ml:description:Qwen/Qwen2.5-VL-3B-Instruct',
    'ml:description:microsoft/Florence-2-base',
    'ml:description:microsoft/Florence-2-base-ft',
    'ml:insightface:buffalo_l',
    'ml:mclip:LABSE-Vit-L-14',
    'ml:nsfw:onnx-community/nsfw_image_detection-ONNX',
    'ml:paddle:PP-OCRv5_mobile',
  ]);
});
