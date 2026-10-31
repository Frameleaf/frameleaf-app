import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  prepareClaimFonts,
  loadAdmissionFonts,
  requireGraphFonts,
  registerClaimFonts,
} from './bundled-worker-fonts.mjs';

const bytes = Buffer.from('\x00\x01\x00\x00font fixture');
const checksum = createHash('sha256').update(bytes).digest('hex');
const input = {
  inputId: 'font:Inter',
  kind: 'font',
  resourceId: 'Inter',
  checksum,
};
const claim = () => ({
  snapshot: {
    studio: {
      resources: [
        {
          kind: 'font',
          key: input.inputId,
          id: 'Inter',
          grant: 'render',
          checksum,
        },
      ],
    },
  },
  inputs: [input],
});

test('claim fonts carry only verified granted bytes and reject changed or unlisted files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fl-fonts-'));
  try {
    const file = path.join(root, 'font');
    await writeFile(file, bytes);
    const fonts = await prepareClaimFonts(claim(), new Map([[input.inputId, file]]));
    assert.equal(fonts[0].base64, bytes.toString('base64'));
    assert.equal(fonts[0].family, 'Inter');
    await writeFile(file, Buffer.from('changed font'));
    await assert.rejects(prepareClaimFonts(claim(), new Map([[input.inputId, file]])), { code: 'font_refused' });
    const extra = claim();
    extra.snapshot.studio.resources = [];
    await assert.rejects(prepareClaimFonts(extra, new Map([[input.inputId, file]])), { code: 'font_refused' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('text defaults, spans and nested compositions require a granted family', () => {
  const graph = {
    timeline: {
      items: [{ type: 'text', text: 'Title' }],
      compositions: [
        {
          items: [
            {
              type: 'text',
              fontFamily: 'Inter',
              textSpans: [{ text: 'x', fontFamily: 'Other' }],
            },
          ],
        },
      ],
    },
  };
  assert.throws(() => requireGraphFonts(graph, []), { code: 'font_missing' });
  assert.throws(() => requireGraphFonts(graph, [{ family: 'Inter' }]), {
    code: 'font_missing',
  });
  assert.doesNotThrow(() => requireGraphFonts(graph, [{ family: 'Inter' }, { family: 'Other' }]));
  assert.doesNotThrow(() =>
    requireGraphFonts(
      {
        timeline: {
          items: [
            {
              type: 'text',
              textSpans: [{ text: 'only', fontFamily: 'Other' }],
            },
          ],
        },
      },
      [{ family: 'Other' }],
    ),
  );
});

test('browser receives real bytes, never local font names or remote URLs, and awaits loading', async () => {
  const added = [];
  const page = {
    evaluate: async (fn, args) => {
      const previousFace = globalThis.FontFace,
        previousDocument = globalThis.document;
      globalThis.FontFace = class {
        constructor(family, data, options) {
          this.family = family;
          this.data = data;
          this.options = options;
        }
        async load() {
          this.loaded = true;
          return this;
        }
      };
      globalThis.document = { fonts: { add: (face) => added.push(face) } };
      try {
        return await fn(args);
      } finally {
        globalThis.FontFace = previousFace;
        globalThis.document = previousDocument;
      }
    },
  };
  await registerClaimFonts(page, [
    {
      family: 'Inter',
      weight: 400,
      style: 'normal',
      subset: 'latin',
      base64: bytes.toString('base64'),
    },
  ]);
  assert.equal(added.length, 1);
  assert.equal(added[0].loaded, true);
  assert.deepEqual(Buffer.from(added[0].data), bytes);
  assert.equal(added[0].family, 'Inter');
});

test('font loading respects cancellation and bounds bytes before reading the file', async () => {
  const reason = new Error('WORKER_STOPPED');
  await assert.rejects(prepareClaimFonts(claim(), new Map(), AbortSignal.abort(reason)), (error) => error === reason);
  const root = await mkdtemp(path.join(os.tmpdir(), 'fl-font-limit-'));
  try {
    const file = path.join(root, 'font');
    await writeFile(file, bytes);
    await truncate(file, 16 * 1024 * 1024 + 1);
    await assert.rejects(prepareClaimFonts(claim(), new Map([[input.inputId, file]])), { code: 'font_refused' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('admission font identity comes from its private manifest and never falls back', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fl-admission-font-'));
  try {
    await writeFile(path.join(root, 'admission-font.ttf'), bytes);
    await writeFile(
      path.join(root, 'admission-font.json'),
      JSON.stringify({
        schemaVersion: 1,
        sourceFile: 'inter-latin-400-normal.ttf',
        sha256: checksum,
      }),
    );
    const fonts = await loadAdmissionFonts(root);
    assert.equal(fonts[0].family, 'Inter');
    assert.equal(fonts[0].base64, bytes.toString('base64'));
    await writeFile(path.join(root, 'admission-font.ttf'), 'changed font');
    await assert.rejects(loadAdmissionFonts(root), { code: 'font_refused' });
    await rm(path.join(root, 'admission-font.json'));
    await assert.rejects(loadAdmissionFonts(root), { code: 'font_refused' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native authoring stages the catalog-pinned admission face', async () => {
  const { stageAdmissionFont } = await import('./bundled-worker-package.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'fl-stage-admission-'));
  try {
    await stageAdmissionFont(root);
    const fonts = await loadAdmissionFonts(path.join(root, 'studio/runtime'));
    assert.equal(fonts.length, 1);
    assert.equal(fonts[0].family, 'Inter');
    assert.ok(Buffer.from(fonts[0].base64, 'base64').length > 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expanded font families accept only their checksum-bound legacy alias without registering it twice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fl-font-alias-'));
  try {
    const file = path.join(root, 'font');
    await writeFile(file, bytes);
    const prepared = claim();
    const fileInput = {
      ...input,
      inputId: 'font:Inter#inter-latin-400-normal.ttf',
    };
    prepared.snapshot.studio.resources[0].files = [
      {
        file: 'inter-latin-400-normal.ttf',
        inputId: fileInput.inputId,
        format: 'ttf',
        weight: 400,
        style: 'normal',
        subset: 'latin',
        checksum,
      },
    ];
    prepared.inputs.push(fileInput);
    const downloaded = new Map([
      [input.inputId, file],
      [fileInput.inputId, file],
    ]);
    const fonts = await prepareClaimFonts(prepared, downloaded);
    assert.equal(fonts.length, 1);
    assert.equal(fonts[0].base64, bytes.toString('base64'));
    prepared.inputs[0] = { ...input, checksum: '0'.repeat(64) };
    await assert.rejects(prepareClaimFonts(prepared, downloaded), {
      code: 'font_refused',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
