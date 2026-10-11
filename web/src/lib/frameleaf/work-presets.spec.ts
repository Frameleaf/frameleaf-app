import { QueueName } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { JOB_QUEUES } from '$lib/frameleaf/job-queues';
import {
  applyPreset,
  AT_ONCE_MOST,
  presetNumbers,
  presetOf,
  TUNABLE_WORK,
  WORK_PRESETS,
  type WorkNumbers,
} from '$lib/frameleaf/work-presets';

/** The server's own defaults (`server/src/dtos/config.dto.ts`, `job`). */
const SERVER_DEFAULTS: Record<string, number> = {
  thumbnailGeneration: 3,
  metadataExtraction: 5,
  videoConversion: 1,
  faceDetection: 2,
  smartSearch: 2,
  videoDuplicateDetection: 1,
  backgroundTask: 5,
  migration: 5,
  search: 5,
  sidecar: 5,
  library: 5,
  notifications: 5,
  ocr: 1,
  imageEnrichment: 2,
  imageDescription: 2,
  nsfwDetection: 2,
  mediaHealth: 2,
  workflow: 5,
  editor: 2,
  integrityCheck: 1,
  petRecognition: 1,
};

const numbers = (values: Record<string, number>): WorkNumbers =>
  Object.fromEntries(Object.entries(values).map(([name, concurrency]) => [name, { concurrency }]));

describe('work presets', () => {
  it('covers the 21 kinds of work the server lets be set, and no others', () => {
    expect([...TUNABLE_WORK].sort()).toEqual(Object.keys(SERVER_DEFAULTS).sort());
    // The four the server always runs one at a time are not offered.
    const fixed = JOB_QUEUES.map(({ name }) => name).filter((name) => !(TUNABLE_WORK as QueueName[]).includes(name));
    expect(fixed.sort()).toEqual(
      [
        QueueName.BackupDatabase,
        QueueName.DuplicateDetection,
        QueueName.FacialRecognition,
        QueueName.StorageTemplateMigration,
      ].sort(),
    );
  });

  it('Balanced is exactly the server defaults, so a fresh server shows as Balanced', () => {
    expect(presetNumbers('balanced')).toEqual(SERVER_DEFAULTS);
    expect(presetOf(numbers(SERVER_DEFAULTS))).toBe('balanced');
  });

  it('never asks for less on Fast or more on Light than Balanced, and stays within what the page offers', () => {
    const light = presetNumbers('light');
    const balanced = presetNumbers('balanced');
    const fast = presetNumbers('fast');
    for (const name of TUNABLE_WORK) {
      expect(light[name]).toBeGreaterThanOrEqual(1);
      expect(light[name]).toBeLessThanOrEqual(balanced[name]);
      expect(fast[name]).toBeGreaterThanOrEqual(balanced[name]);
      expect(fast[name]).toBeLessThanOrEqual(AT_ONCE_MOST);
    }
    expect(light).not.toEqual(balanced);
    expect(fast).not.toEqual(balanced);
  });

  it('keeps the small work people notice at the same number on every choice', () => {
    for (const preset of WORK_PRESETS) {
      const values = presetNumbers(preset);
      expect(values[QueueName.BackgroundTask]).toBe(5);
      expect(values[QueueName.Search]).toBe(5);
      expect(values[QueueName.Notifications]).toBe(5);
      expect(values[QueueName.Workflow]).toBe(5);
    }
  });

  it('writes a preset into the numbers and reads it back', () => {
    const draft = numbers(SERVER_DEFAULTS);
    applyPreset(draft, 'fast');
    expect(presetOf(draft)).toBe('fast');
    expect(draft.thumbnailGeneration?.concurrency).toBe(6);
    applyPreset(draft, 'light');
    expect(presetOf(draft)).toBe('light');
    expect(draft.videoConversion?.concurrency).toBe(1);
  });

  it('shows any other set of numbers as the server’s own', () => {
    expect(presetOf(numbers({ ...SERVER_DEFAULTS, thumbnailGeneration: 4 }))).toBeUndefined();
    expect(presetOf(numbers({ ...SERVER_DEFAULTS, ocr: 40 }))).toBeUndefined();
    expect(presetOf(undefined)).toBeUndefined();
    expect(presetOf({})).toBeUndefined();
  });

  it('leaves a kind the server does not offer alone, and still recognises the preset', () => {
    const { petRecognition: _, ...older } = SERVER_DEFAULTS;
    const draft = numbers(older);
    expect(presetOf(draft)).toBe('balanced');
    applyPreset(draft, 'fast');
    expect(draft.petRecognition).toBeUndefined();
    expect(presetOf(draft)).toBe('fast');
  });
});
