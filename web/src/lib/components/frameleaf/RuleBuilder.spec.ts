import { ClassificationRuleAction } from '@immich/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyRule, normalizeRule, PREVIEW_DEBOUNCE_MS } from '$lib/frameleaf/classification-rules';
import RuleBuilder from './RuleBuilder.svelte';

const tags = [{ id: 'tag-lake', value: 'lake', name: 'lake', createdAt: '', updatedAt: '' }];

describe('RuleBuilder', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    sdkMock.previewClassificationRule.mockResolvedValue({
      exact: true,
      sampled: 10,
      matched: 3,
      items: [],
      visualSearchAvailable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = async () => {
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS + 10);
  };

  it('previews through the read-only endpoint and writes nothing', async () => {
    const rule = normalizeRule({ tagIds: ['tag-lake'] });
    render(RuleBuilder, { rule, people: [], tags, onChange: vi.fn() });
    await settle();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('3 items match right now.'));
    expect(sdkMock.previewClassificationRule).toHaveBeenCalledTimes(1);
    expect(sdkMock.previewClassificationRule.mock.calls[0][0].classificationPreviewDto).toMatchObject({
      tagIds: ['tag-lake'],
    });
    for (const write of [
      'createClassificationRule',
      'updateClassificationRule',
      'applyClassificationRule',
      'decideClassificationRuleMatches',
      'createBulkMediaOperation',
      'createAlbum',
    ] as const) {
      expect(sdkMock[write]).not.toHaveBeenCalled();
    }
  });

  it('asks nothing for an empty rule and says why', async () => {
    render(RuleBuilder, { rule: emptyRule(), people: [], tags, onChange: vi.fn() });
    await settle();

    expect(sdkMock.previewClassificationRule).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Add at least one rule.');
  });

  it('asks again when the confidence threshold changes, and not when only the action changes', async () => {
    const rule = normalizeRule({ visualQueries: ['lake'], threshold: 0.25 });
    const { rerender } = render(RuleBuilder, { rule, people: [], tags, onChange: vi.fn() });
    await settle();
    expect(sdkMock.previewClassificationRule).toHaveBeenCalledTimes(1);

    await rerender({ rule: { ...rule, action: ClassificationRuleAction.Tag, tagName: 'Lake' } });
    await settle();
    expect(sdkMock.previewClassificationRule).toHaveBeenCalledTimes(1);

    await rerender({ rule: { ...rule, threshold: 0.4 } });
    await settle();
    expect(sdkMock.previewClassificationRule).toHaveBeenCalledTimes(2);
    expect(sdkMock.previewClassificationRule.mock.calls[1][0].classificationPreviewDto).toMatchObject({
      threshold: 0.4,
      visualQueries: ['lake'],
    });
  });

  it('says when a visual preview only read the newest items', async () => {
    sdkMock.previewClassificationRule.mockResolvedValue({
      exact: false,
      sampled: 500,
      matched: 12,
      items: [],
      visualSearchAvailable: true,
    });
    render(RuleBuilder, { rule: normalizeRule({ visualQueries: ['lake'] }), people: [], tags, onChange: vi.fn() });
    await settle();

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('12 items of your newest 500 items match.'),
    );
  });

  it('asks for consent before archiving is part of the rule', async () => {
    const onChange = vi.fn();
    const { rerender } = render(RuleBuilder, {
      rule: normalizeRule({ tagIds: ['tag-lake'] }),
      people: [],
      tags,
      onChange,
    });
    expect(screen.queryByRole('checkbox', { name: /archived automatically/ })).toBeNull();

    screen.getByRole('switch', { name: /Archive matches/ }).click();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ archive: true, archiveConsent: false }));

    await rerender({ rule: normalizeRule({ tagIds: ['tag-lake'], archive: true }) });
    screen.getByRole('checkbox', { name: /archived automatically/ }).click();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ archive: true, archiveConsent: true }));
  });
});
