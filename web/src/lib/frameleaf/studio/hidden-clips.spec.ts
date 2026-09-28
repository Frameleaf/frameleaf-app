import { describe, expect, it } from 'vitest';
import { holdBackHiddenClips, withHeldClips } from './hidden-clips';

const graph = () => ({
  timeline: {
    tracks: [{ id: 'track-v1', items: [] }],
    items: [
      { id: 'c1', mediaId: 'plain' },
      { id: 'c2', mediaId: 'locked', linkedItemIds: ['c3'] },
      { id: 'c3', mediaId: 'locked' },
      { id: 'c4', mediaId: 'other' },
    ],
    transitions: [
      { id: 't1', leftClipId: 'c1', rightClipId: 'c2' },
      { id: 't2', leftClipId: 'c1', rightClipId: 'c4' },
    ],
    keyframes: [{ itemId: 'c2', properties: [] }],
  },
  sequences: [{ id: 'seq-2', clips: [{ assetId: 'locked' }, { assetId: 'plain' }] }],
});

describe('hidden clips (FL-195 follow-up)', () => {
  it('returns the graph untouched when nothing is hidden', () => {
    const input = graph();
    expect(holdBackHiddenClips(input, [])).toEqual({ graph: input, held: [] });
    expect(holdBackHiddenClips(input, undefined).graph).toBe(input);
  });

  it('takes out the clips of hidden media and everything that points at them, without mutating', () => {
    const input = graph();
    const { graph: visible, held } = holdBackHiddenClips(input, ['locked']);

    expect(visible).toEqual({
      timeline: {
        tracks: [{ id: 'track-v1', items: [] }],
        items: [
          { id: 'c1', mediaId: 'plain' },
          { id: 'c4', mediaId: 'other' },
        ],
        transitions: [{ id: 't2', leftClipId: 'c1', rightClipId: 'c4' }],
        keyframes: [],
      },
      sequences: [{ id: 'seq-2', clips: [{ assetId: 'plain' }] }],
    });
    expect(held).toHaveLength(5);
    expect(input).toEqual(graph());
    expect(JSON.stringify(visible)).not.toContain('locked');
  });

  it('puts every held entry back where it came from, after the editor changed the rest', () => {
    const { graph: visible, held } = holdBackHiddenClips(graph(), ['locked']);
    const edited = structuredClone(visible) as ReturnType<typeof graph>;
    edited.timeline.items.push({ id: 'c5', mediaId: 'plain' });

    const saved = withHeldClips(edited, held) as ReturnType<typeof graph>;

    expect(saved.timeline.items.map(({ id }) => id)).toEqual(['c1', 'c4', 'c5', 'c2', 'c3']);
    expect(saved.timeline.transitions.map(({ id }) => id)).toEqual(['t2', 't1']);
    expect(saved.timeline.keyframes).toEqual([{ itemId: 'c2', properties: [] }]);
    expect(saved.sequences[0].clips).toEqual([{ assetId: 'plain' }, { assetId: 'locked' }]);
    // the editor's graph is left as it was
    expect(edited.timeline.items).toHaveLength(3);
  });

  it('never duplicates an entry the editor kept, and drops one whose array the editor removed', () => {
    const { graph: visible, held } = holdBackHiddenClips(graph(), ['locked']);
    const edited = structuredClone(visible) as ReturnType<typeof graph>;
    edited.timeline.items.push({ id: 'c2', mediaId: 'locked' });
    edited.sequences = [];

    const saved = withHeldClips(edited, held) as ReturnType<typeof graph>;

    expect(saved.timeline.items.filter(({ id }) => id === 'c2')).toHaveLength(1);
    expect(saved.sequences).toEqual([]);
  });
});
