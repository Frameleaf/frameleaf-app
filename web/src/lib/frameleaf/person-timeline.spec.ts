import { AssetVisibility } from '@frameleaf/sdk';
import { personTimelineOptions } from '$lib/frameleaf/person-timeline';

describe('personTimelineOptions (FL-795)', () => {
  it('shows timeline photos only unless the viewer includes archived photos in People', () => {
    expect(personTimelineOptions('p1', false)).toEqual({ visibility: AssetVisibility.Timeline, personId: 'p1' });
    expect(personTimelineOptions('p1', true)).toEqual({ personId: 'p1' });
  });
});
