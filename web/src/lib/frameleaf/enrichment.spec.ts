import {
  EnrichmentStage,
  MediaOperationStatus,
  MlDestinationHealth,
  MlDestinationKind,
  type EnrichmentDestinationOptionDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  captionRequestCount,
  destinationChoices,
  formatMomentTime,
  initialStages,
  lastPlanKey,
  neededBy,
  newRequestKey,
  parseMomentTime,
  planPollDelay,
  reasonKey,
  toggleStage,
  withRequiredStages,
} from '$lib/frameleaf/enrichment';

const destination = (
  id: string,
  enrichment: EnrichmentDestinationOptionDto['enrichment'],
): EnrichmentDestinationOptionDto => ({
  id,
  name: id,
  kind: MlDestinationKind.Local,
  cloud: false,
  health: MlDestinationHealth.Healthy,
  enrichment,
  search: { admitted: true, refusal: null },
});

describe('stages', () => {
  it('pulls in the reusable frames when the moment index or captions are ticked', () => {
    expect(toggleStage([], EnrichmentStage.MomentIndex, true)).toEqual([
      EnrichmentStage.Frames,
      EnrichmentStage.MomentIndex,
    ]);
    expect(withRequiredStages([EnrichmentStage.MomentCaptions])).toEqual([
      EnrichmentStage.Frames,
      EnrichmentStage.MomentCaptions,
    ]);
  });

  it('unticks the stages that need a stage when it is unticked', () => {
    const selected = [EnrichmentStage.Frames, EnrichmentStage.Description, EnrichmentStage.MomentIndex];
    expect(toggleStage(selected, EnrichmentStage.Frames, false)).toEqual([EnrichmentStage.Description]);
  });

  it('keeps frames when one of two stages needing them is unticked', () => {
    const selected = [EnrichmentStage.Frames, EnrichmentStage.MomentIndex, EnrichmentStage.MomentCaptions];
    expect(toggleStage(selected, EnrichmentStage.MomentCaptions, false)).toEqual([
      EnrichmentStage.Frames,
      EnrichmentStage.MomentIndex,
    ]);
    expect(neededBy(selected, EnrichmentStage.Frames)).toEqual([
      EnrichmentStage.MomentIndex,
      EnrichmentStage.MomentCaptions,
    ]);
  });

  it('never starts a plan with moment captions and leaves out switched-off features', () => {
    const defaults = [EnrichmentStage.LockedCheck, EnrichmentStage.Description, EnrichmentStage.MomentCaptions];
    expect(initialStages(defaults, { description: true, lockedCheck: false, search: true })).toEqual([
      EnrichmentStage.Description,
    ]);
  });

  it('counts the extra requests captions add', () => {
    expect(captionRequestCount(3, 6)).toBe(18);
    expect(captionRequestCount(0, 6)).toBe(0);
  });
});

describe('destinations', () => {
  it('offers a destination that allows the work even if it is unhealthy now, and never one that does not', () => {
    const choices = destinationChoices(
      [
        destination('ok', { admitted: true, refusal: null }),
        destination('asleep', { admitted: false, refusal: 'destination-unhealthy' }),
        destination('not-allowed', { admitted: false, refusal: 'workload-not-allowed' }),
        destination('no-consent', { admitted: false, refusal: 'consent-missing' }),
      ],
      'enrichment',
    );
    expect(choices.map(({ id }) => id)).toEqual(['ok', 'asleep']);
  });
});

describe('plans', () => {
  it('polls while a plan runs and stops once it has finished', () => {
    expect(planPollDelay(MediaOperationStatus.Rendering)).toBe(2000);
    expect(planPollDelay(MediaOperationStatus.Paused)).toBe(5000);
    expect(planPollDelay(MediaOperationStatus.Completed)).toBeNull();
    expect(planPollDelay(MediaOperationStatus.Cancelled)).toBeNull();
  });

  it('never shows a raw reason code', () => {
    expect(reasonKey('dependency-failed')).toBe('frameleaf_enrichment_reason_dependency_failed');
    expect(reasonKey('something-new')).toBe('frameleaf_enrichment_reason_other');
    expect(reasonKey(null)).toBeNull();
  });
});

describe('moment times', () => {
  it('formats and parses times in a video', () => {
    expect(formatMomentTime(65_400)).toBe('1:05');
    expect(formatMomentTime(3_725_000)).toBe('1:02:05');
    expect(parseMomentTime('1:05')).toBe(65_000);
    expect(parseMomentTime('1:02:05')).toBe(3_725_000);
    expect(parseMomentTime('12.5')).toBe(12_500);
    expect(parseMomentTime('abc')).toBeNull();
    expect(parseMomentTime('')).toBeNull();
  });
});

describe('newRequestKey', () => {
  it('always makes a version 4 UUID the server accepts', () => {
    expect(newRequestKey()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  });
});

describe('lastPlanKey', () => {
  it('keeps each account to its own last plan in this browser', () => {
    expect(lastPlanKey('user-a')).not.toBe(lastPlanKey('user-b'));
  });
});
