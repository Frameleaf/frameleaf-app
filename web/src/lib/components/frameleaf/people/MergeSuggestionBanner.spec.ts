import { fireEvent, render, screen } from '@testing-library/svelte';
import { personFactory } from '@test-data/factories/person-factory';
import MergeSuggestionBanner from './MergeSuggestionBanner.svelte';

/**
 * FL-57: the guided merge-suggestion verdict banner. Verifies each of the three verdicts
 * (accept/reject/skip) calls back to the caller — the banner itself never calls the
 * network; the People page owns `mergePeople` and the local suggestion queue.
 *
 * No locale is loaded in this test environment, so `$t(key)` renders the literal i18n
 * key (see PersonFaceActions.spec.ts for the same convention).
 */
describe('MergeSuggestionBanner', () => {
  const person = personFactory.build({ name: 'Alice' });
  const suggestion = personFactory.build({ name: 'Alicia' });

  it('should call onAccept when the accept action is chosen', async () => {
    const onAccept = vi.fn();
    render(MergeSuggestionBanner, {
      suggestion: { person, suggestion, distance: 0.2 },
      remaining: 0,
      onAccept,
      onReject: vi.fn(),
      onSkip: vi.fn(),
    });

    await fireEvent.click(screen.getByText('frameleaf_people_merge_suggestion_accept'));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('should call onReject when the reject action is chosen', async () => {
    const onReject = vi.fn();
    render(MergeSuggestionBanner, {
      suggestion: { person, suggestion, distance: 0.2 },
      remaining: 0,
      onAccept: vi.fn(),
      onReject,
      onSkip: vi.fn(),
    });

    await fireEvent.click(screen.getByText('frameleaf_people_merge_suggestion_reject'));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it('should call onSkip when the skip action is chosen', async () => {
    const onSkip = vi.fn();
    render(MergeSuggestionBanner, {
      suggestion: { person, suggestion, distance: 0.2 },
      remaining: 3,
      onAccept: vi.fn(),
      onReject: vi.fn(),
      onSkip,
    });

    await fireEvent.click(screen.getByText('frameleaf_people_merge_suggestion_skip'));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('should disable every action while busy', () => {
    render(MergeSuggestionBanner, {
      suggestion: { person, suggestion, distance: 0.2 },
      remaining: 0,
      busy: true,
      onAccept: vi.fn(),
      onReject: vi.fn(),
      onSkip: vi.fn(),
    });

    expect(screen.getByText('frameleaf_people_merge_suggestion_accept').closest('button')).toBeDisabled();
    expect(screen.getByText('frameleaf_people_merge_suggestion_reject').closest('button')).toBeDisabled();
    expect(screen.getByText('frameleaf_people_merge_suggestion_skip').closest('button')).toBeDisabled();
  });
});
