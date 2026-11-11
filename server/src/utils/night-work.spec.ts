import { describe, expect, it } from 'vitest';
import type { QueueExecution } from 'src/queue/types.js';
import { queueExecution } from 'src/queue/context.js';
import { currentNight, nightWork, withNight } from 'src/utils/night-work.js';

const night = { startedAt: '2026-11-11T02:33:00.000Z', manual: false };
const claimed = (startedAt: string) =>
  ({ claim: { data: { _night: night }, startedAt: new Date(startedAt) } }) as unknown as QueueExecution;

describe('the night a piece of work belongs to (FL-1430)', () => {
  it('is the overnight schedule’s while it starts a step', () => {
    expect(nightWork.run(night, () => withNight({ libraryId: 'l' }))).toEqual({ libraryId: 'l', night });
    expect(withNight({})).toEqual({});
  });

  it('is carried by a job the night queued, however late it runs (Recent work checks it against the night)', () => {
    expect(queueExecution.run(claimed('2026-11-11T02:40:00.000Z'), () => currentNight())).toEqual(night);
    // a producer held by quiet hours runs 14 hours later: still the night's; a run opened after the night ended
    // stands alone, decided when Recent work reads it (recent-work.ts)
    expect(queueExecution.run(claimed('2026-11-11T16:40:00.000Z'), () => currentNight())).toEqual(night);
  });
});
