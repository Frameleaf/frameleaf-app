#!/usr/bin/env node
/**
 * Frameleaf acknowledgements (FL-86, owner decisions FL-146 2026-09-25).
 *
 * `licenses/acknowledgements.json` is the one list of every third-party engine, model, voice, font
 * and asset Frameleaf uses that needs credit: name, author, licence, link, how it reaches people
 * (bundled, downloaded at run time, loaded from a service) and the licence texts that ship with it.
 * This script keeps it honest and publishes it:
 *
 * - **Coverage.** Every resource in `studio/dependency-attribution.json` and every model the photo
 *   library's machine learning service can load (`machine-learning/immich_ml/models/constants.py`,
 *   the description model lists and the server defaults) must be credited by some entry.
 * - **Notices.** Every engine and model must name at least one licence text that exists in the
 *   repository and ships with the product (`studio/notices`, `licenses/texts`). Retrieved texts are
 *   pinned by SHA-256, and Freecut's notice must be byte-identical to the pinned upstream LICENSE.
 * - **Documents.** It writes `docs/docs/overview/acknowledgements.md` and
 *   `licenses/THIRD-PARTY-NOTICES.md` (every licence text, verbatim) from the list.
 *
 *   node scripts/frameleaf-acknowledgements.mjs           verify (CI)
 *   node scripts/frameleaf-acknowledgements.mjs --write   regenerate the two documents
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ACKNOWLEDGEMENTS_PATH = 'licenses/acknowledgements.json';
export const DOCS_PATH = 'docs/docs/overview/acknowledgements.md';
export const NOTICES_PATH = 'licenses/THIRD-PARTY-NOTICES.md';
const ATTRIBUTION_PATH = 'studio/dependency-attribution.json';
const PROVENANCE_PATH = 'studio/freecut-provenance.json';
const ML_CONSTANTS_PATH = 'machine-learning/immich_ml/models/constants.py';
const ML_DESCRIPTION_PATH = 'machine-learning/immich_ml/models/image_description.py';
const SERVER_CONFIG_PATH = 'server/src/dtos/config.dto.ts';
const GENERATOR = 'scripts/frameleaf-acknowledgements.mjs';

/** Groups whose entries are code or weights: each must ship a licence text. */
export const NOTICE_REQUIRED_GROUPS = new Set(['studio-editor', 'studio-models', 'library-models']);
const SHIPPED = new Set(['bundled', 'downloaded', 'user', 'administrator-installed']);
const STATUS = new Set(['recorded', 'looked-up', 'to-confirm']);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Quoted strings in one Python set/dict literal, e.g. `_INSIGHTFACE_MODELS = { ... }`. */
const pythonCollection = (source, name, keysOnly = false) => {
  const match = new RegExp(`^${name} = \\{([\\s\\S]*?)^\\}`, 'm').exec(source);
  if (!match) {
    throw new Error(`${name} was not found`);
  }
  const pattern = keysOnly ? /^\s*"([^"]+)":/gm : /^\s*"([^"]+)",?\s*$/gm;
  return [...match[1].matchAll(pattern)].map((entry) => entry[1]);
};

/** Every model id the photo library's machine learning can load, as `ml:<family>:<name>`. */
export const libraryModelIds = ({ constants, description, serverConfig }) => {
  const ids = [
    ...pythonCollection(constants, '_OPENCLIP_MODELS').map((name) => `ml:clip:${name}`),
    ...pythonCollection(constants, '_MCLIP_MODELS').map((name) => `ml:mclip:${name}`),
    ...pythonCollection(constants, '_INSIGHTFACE_MODELS').map((name) => `ml:insightface:${name}`),
    ...pythonCollection(constants, '_PADDLE_MODELS').map((name) => `ml:paddle:${name}`),
    ...pythonCollection(description, 'OPENVINO_MODEL_ALIASES', true).map((name) => `ml:description:${name}`),
    ...pythonCollection(description, 'FLORENCE_MODEL_NAMES').map((name) => `ml:description:${name}`),
  ];
  const description_ = /const imageDescriptionDefaults = \{[\s\S]*?modelName: '([^']+)',\s*fallbackModelName: '([^']+)'/.exec(
    serverConfig,
  );
  const nsfw = /const nsfwDetectionDefaults = \{[\s\S]*?modelName: '([^']+)'/.exec(serverConfig);
  if (!description_ || !nsfw) {
    throw new Error(`${SERVER_CONFIG_PATH}: the default description and NSFW model names were not found`);
  }
  ids.push(`ml:description:${description_[1]}`, `ml:description:${description_[2]}`, `ml:nsfw:${nsfw[1]}`);
  return [...new Set(ids)].sort();
};

const matches = (pattern, id) =>
  new RegExp(`^${pattern.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(id);

/** Check the list; returns the problems found (empty when all is well). */
export const checkAcknowledgements = ({ acknowledgements, attribution, provenance, libraryIds, files }) => {
  const problems = [];
  const entries = acknowledgements.components ?? [];
  const seen = new Set();
  for (const entry of entries) {
    const label = entry?.id ?? JSON.stringify(entry);
    if (seen.has(entry.id)) {
      problems.push(`${label}: duplicate entry`);
    }
    seen.add(entry.id);
    for (const key of ['id', 'group', 'name', 'author', 'licence', 'source']) {
      if (typeof entry[key] !== 'string' || entry[key].trim().length === 0) {
        problems.push(`${label}: ${key} is required`);
      }
    }
    if (!Object.hasOwn(acknowledgements.groups ?? {}, entry.group)) {
      problems.push(`${label}: unknown group ${entry.group}`);
    }
    if (!SHIPPED.has(entry.shipped)) {
      problems.push(`${label}: shipped must be one of ${[...SHIPPED].join(', ')}`);
    }
    if (!STATUS.has(entry.status)) {
      problems.push(`${label}: status must be one of ${[...STATUS].join(', ')}`);
    }
    if (!Array.isArray(entry.noticeFiles) || !Array.isArray(entry.covers)) {
      problems.push(`${label}: noticeFiles and covers must be lists`);
      continue;
    }
    if (NOTICE_REQUIRED_GROUPS.has(entry.group) && entry.noticeFiles.length === 0) {
      problems.push(`${label}: no licence text ships with this engine or model`);
    }
    for (const file of entry.noticeFiles) {
      if (!files.has(file)) {
        problems.push(`${label}: notice file ${file} does not exist`);
      } else if (files.get(file).length === 0) {
        problems.push(`${label}: notice file ${file} is empty`);
      }
    }
  }

  // Every retrieved licence text is pinned to the bytes that were reviewed.
  for (const text of acknowledgements.texts ?? []) {
    if (!files.has(text.file)) {
      problems.push(`${text.file}: listed licence text does not exist`);
    } else if (sha256(files.get(text.file)) !== text.sha256) {
      problems.push(`${text.file}: changed since it was retrieved from ${text.source}`);
    }
  }

  // Freecut's notice is its own LICENSE, byte for byte, at the pinned revision.
  const freecut = entries.find((entry) => entry.id === 'freecut');
  // `licensePath` is recorded from the studio folder (`vendor/freecut/LICENSE`); file paths are the snapshot's.
  const licensePath = String(provenance.licensePath ?? '').replace(/^vendor\/freecut\//, '');
  const upstreamLicense = provenance.files.find((file) => file.path === licensePath);
  if (!freecut || !upstreamLicense) {
    problems.push('freecut: the Freecut entry and its pinned LICENSE are required');
  } else if (!files.has('studio/notices/freecut.txt') || sha256(files.get('studio/notices/freecut.txt')) !== upstreamLicense.sha256) {
    problems.push('freecut: studio/notices/freecut.txt is not the pinned upstream LICENSE');
  }

  // Coverage: everything the product can load is credited somewhere.
  const patterns = [
    ...entries.flatMap((entry) => entry.covers ?? []),
    ...(acknowledgements.fonts?.covers ?? []),
  ];
  const required = [...attribution.resources.map((resource) => resource.id), ...libraryIds];
  for (const id of required) {
    if (!patterns.some((pattern) => matches(pattern, id))) {
      problems.push(`${id}: not credited in ${ACKNOWLEDGEMENTS_PATH}`);
    }
  }
  const fontIds = new Set(attribution.resources.filter((resource) => resource.kind === 'font').map((r) => r.locator));
  const families = new Set((acknowledgements.fonts?.families ?? []).map((family) => family.name));
  for (const font of fontIds) {
    if (!families.has(font)) {
      problems.push(`font:${font}: no designer and licence recorded`);
    }
  }
  for (const file of acknowledgements.fonts?.noticeFiles ?? []) {
    if (!files.has(file)) {
      problems.push(`fonts: notice file ${file} does not exist`);
    }
  }
  return problems;
};

/* ------------------------------------------------------------------ */
/* Documents                                                            */
/* ------------------------------------------------------------------ */

/** MDX treats `<` and `{` as syntax; prose that contains them is escaped. */
const mdx = (text) => String(text).replaceAll('\\', '\\\\').replaceAll('<', '\\<').replaceAll('{', '\\{').replaceAll('|', '\\|');
/**
 * A markdown table laid out the way prettier lays it out (padded cells, dashes to the column
 * width), so the docs format check accepts the generated page as it is.
 */
const width = (text) => [...text].reduce((total, char) => total + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1), 0);
const table = (headers, rows) => {
  const widths = headers.map((header, column) => Math.max(3, width(header), ...rows.map((row) => width(row[column]))));
  const line = (cells) => `| ${cells.map((cell, column) => cell + ' '.repeat(widths[column] - width(cell))).join(' | ')} |`;
  return [line(headers), `| ${widths.map((size) => '-'.repeat(size)).join(' | ')} |`, ...rows.map((row) => line(row))];
};
const link = (label, url) => (url ? `[${mdx(label)}](${url})` : mdx(label));
const repositoryUrl = (file) => `https://github.com/Frameleaf/frameleaf-app/blob/fork/main/${file}`;

/** Attachment A of an Open RAIL-M licence: the use restrictions that must be passed on. */
export const railUseRestrictions = (text) => {
  const start = text.indexOf('Attachment A');
  return start === -1 ? null : text.slice(start).trim();
};

export const buildDocs = (acknowledgements, files) => {
  const entries = acknowledgements.components;
  const freecutText = files.get('studio/notices/freecut.txt').toString('utf8').trim();
  const rail = files.get('licenses/texts/supertonic-3-openrail-m.txt');
  const restrictions = rail ? railUseRestrictions(rail.toString('utf8')) : null;
  const lines = [
    '---',
    'sidebar_position: 7',
    '---',
    '',
    '# Acknowledgements',
    '',
    '<!-- Generated by scripts/frameleaf-acknowledgements.mjs from licenses/acknowledgements.json. Do not edit. -->',
    '',
    'Frameleaf is built on the work of other open-source projects and model authors. The full licence texts ship with the application (Support and feedback → Third-party notices), in every server image under `/licenses`, next to the Studio editor at `/studio-engine/notices`, and in the repository (`licenses/THIRD-PARTY-NOTICES.md`).',
    '',
    '## Immich',
    '',
    'Frameleaf is built on [Immich](https://github.com/immich-app/immich), the open-source, self-hosted photo and video backup solution, and is distributed under its AGPL-3.0 licence.',
    '',
  ];
  for (const [group, title] of Object.entries(acknowledgements.groups)) {
    if (group === 'fonts') {
      continue;
    }
    const members = entries.filter((entry) => entry.group === group);
    if (members.length === 0) {
      continue;
    }
    lines.push(
      `## ${mdx(title)}`,
      '',
      ...table(
        ['Name', 'Author', 'Licence', 'How it reaches you'],
        members.map((entry) => [
          link(entry.name, entry.link),
          mdx(entry.author),
          `${mdx(entry.licence)}${entry.status === 'to-confirm' ? ' (to confirm)' : ''}`,
          mdx(entry.shipped),
        ]),
      ),
      '',
    );
    for (const entry of members.filter((member) => member.notice)) {
      lines.push(`- **${mdx(entry.name)}:** ${mdx(entry.notice)}`);
    }
    for (const entry of members.filter((member) => member.voices?.length)) {
      lines.push(`- **${mdx(entry.name)} voices:** ${entry.voices.map((voice) => `\`${voice}\``).join(', ')}.`);
    }
    if (members.some((member) => member.notice || member.voices?.length)) {
      lines.push('');
    }
  }
  lines.push(
    `## ${mdx(acknowledgements.groups.fonts)}`,
    '',
    `Title fonts come from [Google Fonts](https://fonts.google.com) and are ${mdx(acknowledgements.fonts.shipped)}. Designers and licences: ${mdx(acknowledgements.fonts.source)}.`,
    '',
    ...table(
      ['Family', 'Designer', 'Licence'],
      acknowledgements.fonts.families.map((family) => [
        link(family.name, family.link),
        mdx(family.designer),
        `[${family.licence}](${family.licenceFile})`,
      ]),
    ),
    '',
    '## Freecut licence',
    '',
    'Studio’s editor is Freecut. Its licence, as shipped (`studio/notices/freecut.txt`):',
    '',
    '```text',
    freecutText,
    '```',
    '',
  );
  if (restrictions) {
    lines.push(
      '## Supertonic-3 use restrictions',
      '',
      'Supertonic-3 and its voices are licensed under the BigScience Open RAIL-M License. These use restrictions apply to you and to anyone you share the model or its output with:',
      '',
      '```text',
      restrictions,
      '```',
      '',
    );
  }
  lines.push(
    '## Licence texts',
    '',
    ...[...new Set([...entries.flatMap((entry) => entry.noticeFiles), ...acknowledgements.fonts.noticeFiles])]
      .sort()
      .map((file) => `- [\`${file}\`](${repositoryUrl(file)})`),
    '',
  );
  return lines.join('\n');
};

export const buildNotices = (acknowledgements, files) => {
  const lines = [
    '# Frameleaf third-party notices',
    '',
    `Generated by \`${GENERATOR}\` from \`${ACKNOWLEDGEMENTS_PATH}\`. Do not edit.`,
    '',
    'Frameleaf is built on Immich (AGPL-3.0; see `/licenses/LICENSE.txt`). The components below are credited with their authors and licences, followed by every licence text verbatim.',
    '',
  ];
  for (const [group, title] of Object.entries(acknowledgements.groups)) {
    if (group === 'fonts') {
      continue;
    }
    lines.push(`## ${title}`, '');
    for (const entry of acknowledgements.components.filter((member) => member.group === group)) {
      lines.push(
        `- **${entry.name}** — ${entry.author}. Licence: ${entry.licence}${entry.status === 'to-confirm' ? ' (to confirm)' : ''}.${entry.link ? ` ${entry.link}` : ''}`,
      );
      if (entry.notice) {
        lines.push(`  ${entry.notice}`);
      }
      if (entry.voices?.length) {
        lines.push(`  Voices: ${entry.voices.join(', ')}.`);
      }
      if (entry.noticeFiles.length > 0) {
        lines.push(`  Licence texts: ${entry.noticeFiles.join(', ')}.`);
      }
    }
    lines.push('');
  }
  lines.push(`## ${acknowledgements.groups.fonts}`, '', `${acknowledgements.fonts.source}; ${acknowledgements.fonts.shipped}.`, '');
  for (const family of acknowledgements.fonts.families) {
    lines.push(`- ${family.name} — ${family.designer}. ${family.licence}. ${family.licenceFile}`);
  }
  lines.push('', '# Licence texts', '');
  const texts = [...new Set([...acknowledgements.components.flatMap((entry) => entry.noticeFiles), ...acknowledgements.fonts.noticeFiles])].sort();
  for (const file of texts) {
    const pinned = acknowledgements.texts.find((text) => text.file === file);
    lines.push(`## ${file}`, '');
    if (pinned) {
      lines.push(`Source: ${pinned.source} (retrieved ${pinned.retrievedOn}, SHA-256 ${pinned.sha256}).`, '');
    }
    lines.push('```text', files.get(file).toString('utf8').replace(/\s+$/, ''), '```', '');
  }
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

export async function load(root) {
  const read = (file) => readFile(path.join(root, file));
  const acknowledgements = JSON.parse((await read(ACKNOWLEDGEMENTS_PATH)).toString('utf8'));
  const attribution = JSON.parse((await read(ATTRIBUTION_PATH)).toString('utf8'));
  const provenance = JSON.parse((await read(PROVENANCE_PATH)).toString('utf8'));
  const libraryIds = libraryModelIds({
    constants: (await read(ML_CONSTANTS_PATH)).toString('utf8'),
    description: (await read(ML_DESCRIPTION_PATH)).toString('utf8'),
    serverConfig: (await read(SERVER_CONFIG_PATH)).toString('utf8'),
  });
  const wanted = new Set([
    ...acknowledgements.components.flatMap((entry) => entry.noticeFiles ?? []),
    ...(acknowledgements.fonts?.noticeFiles ?? []),
    ...(acknowledgements.texts ?? []).map((text) => text.file),
    'studio/notices/freecut.txt',
  ]);
  const files = new Map();
  for (const file of wanted) {
    const bytes = await read(file).catch(() => null);
    if (bytes) {
      files.set(file, bytes);
    }
  }
  return { acknowledgements, attribution, provenance, libraryIds, files };
}

export async function main(argv, root) {
  const inputs = await load(root);
  const problems = checkAcknowledgements(inputs);
  if (problems.length > 0) {
    process.stderr.write(`Acknowledgements are incomplete:\n  ${problems.join('\n  ')}\n`);
    return 1;
  }
  const outputs = {
    [DOCS_PATH]: buildDocs(inputs.acknowledgements, inputs.files),
    [NOTICES_PATH]: buildNotices(inputs.acknowledgements, inputs.files),
  };
  const stale = [];
  for (const [file, expected] of Object.entries(outputs)) {
    if (argv.includes('--write')) {
      await writeFile(path.join(root, file), expected);
    } else if ((await readFile(path.join(root, file), 'utf8').catch(() => null)) !== expected) {
      stale.push(file);
    }
  }
  if (stale.length > 0) {
    process.stderr.write(`Acknowledgement documents are stale:\n  ${stale.join('\n  ')}\nRun: node ${GENERATOR} --write\n`);
    return 1;
  }
  const toConfirm = inputs.acknowledgements.components.filter((entry) => entry.status === 'to-confirm');
  process.stdout.write(
    `Acknowledgements verified: ${inputs.acknowledgements.components.length} components, ${inputs.acknowledgements.fonts.families.length} font families, ${inputs.libraryIds.length} library model ids; to confirm: ${toConfirm.map((entry) => entry.id).join(', ') || 'none'}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), fileURLToPath(new URL('..', import.meta.url)));
}
