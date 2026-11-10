import { fireEvent, render, screen } from '@testing-library/svelte';
import { personFactory } from '@test-data/factories/person-factory';
import MixedPersonBanner from './MixedPersonBanner.svelte';

/**
 * FL-1385: "Is this all one person?". Every answer calls back to the caller; the banner itself never
 * calls the network. A few faces from each side are shown, cropped from photos the viewer may see.
 *
 * No locale is loaded in this test environment, so `$t(key)` renders the literal i18n key.
 */
describe('MixedPersonBanner', () => {
  const face = (index: number) => ({
    assetId: `00000000-0000-4000-8000-0000000000a${index}`,
    faceId: `00000000-0000-4000-8000-0000000000b${index}`,
    box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
  });
  const suggestion = {
    person: personFactory.build({ name: 'Jamie Lee' }),
    faceCount: 4,
    totalFaceCount: 12,
    distance: 0.9,
    personEvidence: [face(1), face(2), face(3)],
    otherEvidence: [face(4), face(5)],
  };
  const handlers = () => ({ onSplit: vi.fn(), onSame: vi.fn(), onSkip: vi.fn() });

  it.each([
    ['frameleaf_people_split_suggestion_split', 'onSplit'],
    ['frameleaf_people_split_suggestion_same', 'onSame'],
    ['frameleaf_people_merge_suggestion_skip', 'onSkip'],
  ] as const)('answers %s with %s', async (label, handler) => {
    const callbacks = handlers();
    render(MixedPersonBanner, { suggestion, remaining: 0, ...callbacks });

    // "Ask me later" is the quiet answer in the "More answers" menu
    if (!screen.queryByText(label)) {
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_people_merge_suggestion_more_answers' }));
    }
    await fireEvent.click(await screen.findByText(label));

    expect(callbacks[handler]).toHaveBeenCalledOnce();
    for (const [name, callback] of Object.entries(callbacks)) {
      if (name !== handler) {
        expect(callback).not.toHaveBeenCalled();
      }
    }
  });

  it('shows the question, the count and a few faces from each side', () => {
    const { container } = render(MixedPersonBanner, { suggestion, remaining: 2, ...handlers() });

    expect(screen.getByText('frameleaf_people_split_suggestion_question')).toBeTruthy();
    expect(screen.getByText('frameleaf_people_split_suggestion_summary')).toBeTruthy();
    expect(screen.getByText('frameleaf_people_split_suggestion_most')).toBeTruthy();
    expect(screen.getByText('frameleaf_people_split_suggestion_different')).toBeTruthy();
    expect(screen.getByText('frameleaf_people_merge_suggestion_more')).toBeTruthy();
    const groups = container.querySelectorAll('.fl-mixed-person-faces');
    expect(groups).toHaveLength(2);
    expect(groups[0].querySelectorAll('.face-crop')).toHaveLength(3);
    expect(groups[1].querySelectorAll('.face-crop')).toHaveLength(2);
    expect(groups[1].querySelector('img')?.getAttribute('src')).toContain(suggestion.otherEvidence[0].assetId);
  });

  it('asks about a person without a name in words that fit, and leaves out a side with no photo to show', () => {
    const { container } = render(MixedPersonBanner, {
      suggestion: { ...suggestion, person: personFactory.build({ name: '' }), personEvidence: [] },
      remaining: 0,
      ...handlers(),
    });

    expect(screen.getByText('frameleaf_people_split_suggestion_question_unnamed')).toBeTruthy();
    expect(screen.getByText('frameleaf_people_split_suggestion_summary_unnamed')).toBeTruthy();
    expect(screen.getByText('frameleaf_people_split_suggestion_same_unnamed')).toBeTruthy();
    expect(container.querySelectorAll('.fl-mixed-person-faces')).toHaveLength(1);
    expect(screen.queryByText('frameleaf_people_merge_suggestion_more')).toBeNull();
  });

  it('holds every answer while one is being saved', () => {
    render(MixedPersonBanner, { suggestion, remaining: 0, busy: true, ...handlers() });

    expect(screen.getByText('frameleaf_people_split_suggestion_split').closest('button')).toBeDisabled();
    expect(screen.getByText('frameleaf_people_split_suggestion_same').closest('button')).toBeDisabled();
  });
});
