// Register claim-granted font bytes so installed fonts cannot choose the title face.
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { deriveClaimFonts, verifyFontBytes } from './render-worker-font-inputs.mjs';
import { BundledRefusal } from './bundled-worker-recipe.mjs';

export async function prepareClaimFonts(claim, downloaded, signal) {
  try {
    const faces = deriveClaimFonts(claim);
    const granted = new Set(faces.map((face) => face.inputId));
    if (faces.length > 64) throw new Error('FONT_BYTES_REFUSED');
    const verified = [...faces];
    for (const input of claim.inputs) {
      if (input.kind !== 'font' || granted.has(input.inputId)) continue;
      // Expanded families retain the old regular-face grant alongside their per-file grants.
      const resource = claim.snapshot.studio.resources.find(
        (resource) =>
          resource.kind === 'font' &&
          resource.files &&
          resource.key === input.inputId &&
          resource.id === input.resourceId &&
          resource.checksum === input.checksum,
      );
      const face = resource && faces.find((face) => face.family === resource.id && face.checksum === resource.checksum);
      if (!face) throw new Error('FONT_INPUT_UNLISTED');
      verified.push({ ...face, inputId: input.inputId, legacyAlias: true });
      granted.add(input.inputId);
    }
    let remaining = 16 * 1024 * 1024;
    const fonts = [];
    for (const face of verified) {
      signal?.throwIfAborted();
      const file = downloaded.get(face.inputId);
      if (!file) throw new Error('FONT_INPUT_MISSING');
      remaining -= (await stat(file)).size;
      if (remaining < 0) throw new Error('FONT_BYTES_REFUSED');
      const bytes = verifyFontBytes(face, await readFile(file, { signal }));
      if (!face.legacyAlias)
        fonts.push({
          family: face.family,
          weight: face.weight,
          style: face.style,
          subset: face.subset,
          base64: bytes.toString('base64'),
        });
    }
    signal?.throwIfAborted();
    return fonts;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new BundledRefusal('font_refused', 'The export font grant or its bytes changed; export again.');
  }
}

export function requireGraphFonts(graph, fonts) {
  const families = new Set(fonts.map((face) => face.family));
  for (const timeline of [graph.timeline, ...(graph.timeline?.compositions ?? [])]) {
    for (const item of timeline?.items ?? []) {
      if (item.type !== 'text' && item.type !== 'subtitle') continue;
      const spans = item.textSpans?.length ? item.textSpans : [{}];
      const required = spans.map((span) => span.fontFamily ?? item.fontFamily ?? 'Inter');
      if (required.some((family) => !families.has(family)))
        throw new BundledRefusal('font_missing', 'A title uses a font this export was not granted.');
    }
  }
}

export async function registerClaimFonts(page, fonts) {
  if (!fonts.length) return;
  await page.evaluate(async (faces) => {
    // Add Latin last so it wins where subset character coverage overlaps.
    for (const font of [
      ...faces.filter((face) => face.subset !== 'latin'),
      ...faces.filter((face) => face.subset === 'latin'),
    ]) {
      const bytes = Uint8Array.from(atob(font.base64), (char) => char.charCodeAt(0));
      const face = new FontFace(font.family, bytes.buffer, {
        weight: String(font.weight),
        style: font.style,
      });
      document.fonts.add(await face.load());
    }
  }, fonts);
}

// Only the native admission probe reads this build-pinned private face; claims use their own grants.
export async function loadAdmissionFonts(directory, signal) {
  try {
    signal?.throwIfAborted();
    if (!path.isAbsolute(directory)) throw new Error('FONT_PATH_INVALID');
    const manifest = path.join(directory, 'admission-font.json');
    if ((await stat(manifest)).size > 4096) throw new Error('FONT_MANIFEST_INVALID');
    const identity = JSON.parse(await readFile(manifest, { encoding: 'utf8', signal }));
    if (
      identity.schemaVersion !== 1 ||
      identity.sourceFile !== 'inter-latin-400-normal.ttf' ||
      !/^[a-f0-9]{64}$/.test(identity.sha256 ?? '')
    )
      throw new Error('FONT_MANIFEST_INVALID');
    const inputId = 'font:Inter';
    return await prepareClaimFonts(
      {
        snapshot: {
          studio: {
            resources: [
              {
                kind: 'font',
                key: inputId,
                id: 'Inter',
                grant: 'render',
                checksum: identity.sha256,
              },
            ],
          },
        },
        inputs: [
          {
            kind: 'font',
            inputId,
            resourceId: 'Inter',
            checksum: identity.sha256,
          },
        ],
      },
      new Map([[inputId, path.join(directory, 'admission-font.ttf')]]),
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new BundledRefusal('font_refused', 'The private admission font is missing or changed; repair this runtime.');
  }
}
