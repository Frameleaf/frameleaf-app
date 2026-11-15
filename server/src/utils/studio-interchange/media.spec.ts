import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  InterchangeCandidate,
  interchangeMediaFiles,
  matchInterchangeFile,
  scoreCandidate,
} from 'src/utils/studio-interchange/media.js';
import { readFcpxml } from 'src/utils/studio-interchange/readers/fcpxml.js';

const fixtures = fileURLToPath(new URL('../../../test/fixtures/studio-interchange/', import.meta.url));
const project = readFcpxml(readFileSync(join(fixtures, 'lake-day.fcpxml')));
const lake = {
  key: 'lake',
  name: 'Lake morning.mov',
  kind: 'video' as const,
  durationSeconds: 60,
  width: 3840,
  height: 2160,
  clips: 1,
};
const candidate = (overrides: Partial<InterchangeCandidate>): InterchangeCandidate => ({
  id: '0198a1c2-0000-4000-8000-000000000001',
  name: 'Lake morning.mov',
  kind: 'video',
  durationSeconds: 60,
  width: 3840,
  height: 2160,
  ...overrides,
});

describe('interchangeMediaFiles', () => {
  it('lists each file once with what the project knew of it, nests included', () => {
    const files = interchangeMediaFiles(project);
    expect(files.map((file) => [file.name, file.clips])).toEqual([
      ['Lake morning.mov', 1],
      ['Kayak.mp4', 1],
      ['Ridge.jpg', 1],
      ['Campfire.wav', 1],
    ]);
    expect(files[0]).toMatchObject({ kind: 'video', durationSeconds: 60, width: 3840, height: 2160 });
    expect(files[3]).toMatchObject({ kind: 'audio' });
  });
});

describe('matchInterchangeFile', () => {
  it('finds a file with the same name, length and picture size', () => {
    expect(matchInterchangeFile(lake, [candidate({})])).toMatchObject({ status: 'found', confidence: 1 });
  });

  it('offers a likely match when the length or size differs, and a re-encoded copy as possible', () => {
    expect(matchInterchangeFile(lake, [candidate({ width: 1920, height: 1080 })])).toMatchObject({ status: 'likely' });
    expect(matchInterchangeFile(lake, [candidate({ durationSeconds: 60.5 })])).toMatchObject({ status: 'very-likely' });
    expect(
      matchInterchangeFile(lake, [candidate({ name: 'Lake morning.mp4', width: 1920, height: 1080 })]),
    ).toMatchObject({
      status: 'possible',
    });
  });

  it('never uses one of two equally good copies without asking', () => {
    const twins = [candidate({}), candidate({ id: '0198a1c2-0000-4000-8000-000000000002' })];
    expect(matchInterchangeFile(lake, twins).status).toBe('likely');
  });

  it('says missing when nothing is named like it or the kind is wrong', () => {
    expect(matchInterchangeFile(lake, [candidate({ name: 'Other.mov' })])).toEqual({
      status: 'missing',
      assetId: null,
      assetName: null,
      confidence: 0,
    });
    expect(scoreCandidate(lake, candidate({ kind: 'image', durationSeconds: null }))).toBeLessThan(0.3);
    // Sound taken from a video's soundtrack is a fair match for a sound file of the same name.
    expect(
      scoreCandidate({ ...lake, kind: 'audio', width: undefined, height: undefined }, candidate({})),
    ).toBeGreaterThan(0.8);
  });
});
