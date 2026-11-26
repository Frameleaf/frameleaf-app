import { MediaSubscriptionState, type MediaCreatorResponseDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { creatorStatus } from '$lib/frameleaf/creators';

const creator = (error: string | null) =>
  ({ following: true, subscription: { status: MediaSubscriptionState.Attention, error } }) as MediaCreatorResponseDto;

describe('creatorStatus', () => {
  it('says what stopped a subscription instead of always asking to sign in again', () => {
    expect(creatorStatus(creator('Refresh site access before continuing'))).toEqual({
      key: 'frameleaf_creators_state_attention_reason',
      values: { reason: 'Refresh site access before continuing' },
    });
    expect(creatorStatus(creator(null))).toEqual({ key: 'frameleaf_creators_state_attention' });
  });
});
