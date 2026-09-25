import { fireEvent, render, screen } from '@testing-library/svelte';
import { personFactory } from '@test-data/factories/person-factory';
import MergeSuggestionBanner from './MergeSuggestionBanner.svelte';

/**
 * FL-57: the guided merge-suggestion verdict banner. Every verdict (same, different, later,
 * ignore) calls back to the caller — the banner itself never calls the network; the People page
 * owns the verdicts and the local suggestion queue. Each person shows a reference face and the
 * complete photo it is in, or a placeholder when no photo may be shown.
 *
 * No locale is loaded in this test environment, so `$t(key)` renders the literal i18n
 * key (see PersonFaceActions.spec.ts for the same convention).
 */
describe('MergeSuggestionBanner', () => {
  const person = personFactory.build({ name: 'Alice' });
  const suggestion = personFactory.build({ name: 'Alicia' });
  const evidence = {
    assetId: '00000000-0000-4000-8000-00000000000a',
    faceId: '00000000-0000-4000-8000-00000000000b',
    box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
  };
  const pair = { person, suggestion, distance: 0.2, personEvidence: evidence, suggestionEvidence: null };
  const handlers = () => ({ onAccept: vi.fn(), onReject: vi.fn(), onSkip: vi.fn(), onIgnore: vi.fn() });

  it.each([
    ['frameleaf_people_merge_suggestion_accept', 'onAccept'],
    ['frameleaf_people_merge_suggestion_reject', 'onReject'],
    ['frameleaf_people_merge_suggestion_skip', 'onSkip'],
    ['frameleaf_people_merge_suggestion_ignore', 'onIgnore'],
  ] as const)('should answer %s with %s', async (label, handler) => {
    const callbacks = handlers();
    render(MergeSuggestionBanner, { suggestion: pair, remaining: 0, ...callbacks });

    await fireEvent.click(screen.getByText(label));
    expect(callbacks[handler]).toHaveBeenCalledOnce();
    for (const [name, callback] of Object.entries(callbacks)) {
      if (name !== handler) {
        expect(callback).not.toHaveBeenCalled();
      }
    }
  });

  it('should show the reference face and the complete authorized photo with the face outlined', () => {
    const { container } = render(MergeSuggestionBanner, { suggestion: pair, remaining: 2, ...handlers() });

    const photo = screen.getByAltText('frameleaf_people_merge_suggestion_photo');
    expect(photo.getAttribute('src')).toContain(evidence.assetId);
    const outline = container.querySelector<HTMLElement>('.fl-merge-suggestion-box')!;
    expect(outline.style.left).toBe('10%');
    expect(outline.style.top).toBe('20%');
    expect(outline.style.width).toBe('30%');
    expect(outline.style.height).toBe('40%');
    expect(container.querySelector(':scope .face-crop img')?.getAttribute('src')).toContain(evidence.assetId);
    expect(screen.getByText('frameleaf_people_merge_suggestion_more')).toBeTruthy();
  });

  it('should never invent a photo for a person without authorized evidence', () => {
    const { container } = render(MergeSuggestionBanner, { suggestion: pair, remaining: 0, ...handlers() });

    expect(screen.getByText('frameleaf_people_merge_suggestion_no_photo')).toBeTruthy();
    // one photo only: the other side has none it may show
    expect(container.querySelectorAll(':scope .fl-merge-suggestion-photo img')).toHaveLength(1);
  });

  it('should disable every answer while busy', () => {
    render(MergeSuggestionBanner, { suggestion: pair, remaining: 0, busy: true, ...handlers() });

    for (const label of [
      'frameleaf_people_merge_suggestion_accept',
      'frameleaf_people_merge_suggestion_reject',
      'frameleaf_people_merge_suggestion_skip',
      'frameleaf_people_merge_suggestion_ignore',
    ]) {
      expect(screen.getByText(label).closest('button')).toBeDisabled();
    }
  });
});
