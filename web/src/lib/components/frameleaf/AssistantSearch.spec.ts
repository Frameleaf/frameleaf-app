import type { AssetResponseDto, AssistantAskResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { whyLine } from '$lib/frameleaf/assistant';
import en from '../../../../../i18n/en.json';
import AssistantSearch from './AssistantSearch.svelte';

const asset = (id: string) => ({ id, originalFileName: `${id}.jpg` }) as AssetResponseDto;

const answer = (answeredBy: string, ids = ['lake', 'trail']): AssistantAskResponseDto =>
  ({
    query: 'Emma by the lake last summer',
    summary: 'Items of Emma in Lake Louise · 2 found',
    answeredBy,
    plan: { people: ['Emma'], city: 'Lake Louise' },
    results: {
      assets: { items: ids.map((id) => asset(id)), total: ids.length, count: ids.length, facets: [], nextPage: null },
      albums: { items: [], total: 0, count: 0, facets: [] },
    },
    reasons: ids.map((assetId) => ({
      assetId,
      items: [
        { kind: 'visual', text: 'Looks like “lake” (closest match 1)', value: 'lake' },
        { kind: 'date', text: 'Taken Aug 12, 2026', value: '2026-08-12' },
        { kind: 'place', text: 'Taken in Lake Louise', value: 'Lake Louise' },
        { kind: 'person', text: 'Emma is in this photo', value: 'Emma' },
        { kind: 'text', text: 'Text in the photo matches “Lake Agnes”', value: 'Lake Agnes' },
      ],
    })),
    warnings: [],
  }) as unknown as AssistantAskResponseDto;

const props = (extra: Record<string, unknown> = {}) => ({
  onAsk: vi.fn(),
  onClassic: vi.fn(),
  onOpen: vi.fn(),
  ...extra,
});

describe('AssistantSearch (FL-918)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('asks on Enter and clears on Escape, as Ask does', async () => {
    const onAsk = vi.fn();
    render(AssistantSearch, props({ onAsk }));
    const field = screen.getByRole('textbox', { name: 'Ask about your photos' });

    await fireEvent.input(field, { target: { value: '  photos of Emma  ' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(onAsk).toHaveBeenCalledWith('photos of Emma');

    await fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveValue('');
  });

  it('shows the Beta label and switches to classic search in one tap', async () => {
    const onClassic = vi.fn();
    render(AssistantSearch, props({ onClassic }));
    expect(screen.getByText('Beta')).toBeInTheDocument();
    const group = screen.getByRole('radiogroup', { name: 'How to search' });
    expect(within(group).getByRole('radio', { name: 'Frameleaf Assistant' })).toHaveAttribute('aria-checked', 'true');

    await fireEvent.click(within(group).getByRole('radio', { name: 'Classic search' }));
    expect(onClassic).toHaveBeenCalledOnce();
  });

  it('names Frameleaf Assistant when it is turned off', () => {
    render(AssistantSearch, props({ problem: 'disabled' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Frameleaf Assistant is turned off on this server. Classic search still works.',
    );
  });

  it('shows the looking state while the question is answered', () => {
    render(AssistantSearch, props({ query: 'Emma', loading: true }));
    expect(screen.getByText('Looking through your library…')).toBeInTheDocument();
  });

  it('answers with the summary, a grid, and up to three reasons per tile in the mock order', async () => {
    const onOpen = vi.fn();
    render(AssistantSearch, props({ response: answer('planner'), onOpen }));

    expect(screen.getByText('Answered on this server.')).toBeInTheDocument();
    expect(screen.getByText('Items of Emma in Lake Louise · 2 found')).toBeInTheDocument();
    const grid = screen.getByRole('list', { name: 'Matching photos' });
    const [first] = within(grid).getAllByRole('listitem');
    expect(first).toHaveTextContent('Emma');
    expect(first).toHaveTextContent('Lake Louise');
    expect(first).toHaveTextContent('Aug 12, 2026');
    // the fourth reason waits for the tooltip
    expect(first).not.toHaveTextContent('“Lake Agnes” in the photo');
    const open = within(first).getByRole('button');
    expect(open).toHaveAttribute('title', expect.stringContaining('Text in the photo matches “Lake Agnes”'));

    await fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'lake' }));
    expect(screen.getByText(/never sees Locked photos/)).toBeInTheDocument();
  });

  it('says when simple search answered', () => {
    render(AssistantSearch, props({ response: answer('rules') }));
    expect(screen.getByText(/Answered with simple search/)).toBeInTheDocument();
  });

  it('says nothing matches and offers classic search', async () => {
    const onClassic = vi.fn();
    render(AssistantSearch, props({ response: answer('rules', []), onClassic }));
    expect(screen.getByText('Nothing in your library matches')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Try classic search' }));
    expect(onClassic).toHaveBeenCalledOnce();
  });

  it('shows a failure with a retry', async () => {
    const onRetry = vi.fn();
    render(AssistantSearch, props({ problem: 'failed', onRetry }));
    expect(screen.getByRole('alert')).toHaveTextContent('Your question couldn’t be answered right now.');
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps the feedback on this page', async () => {
    render(AssistantSearch, props({ response: answer('planner') }));
    await fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(screen.getByText('Thanks for letting us know.')).toBeInTheDocument();
  });
});

describe('whyLine', () => {
  it('orders person, place, date, then text, and keeps three', () => {
    const items = answer('planner').reasons[0].items;
    expect(whyLine(items).map(({ kind }) => kind)).toEqual(['person', 'place', 'date']);
  });
});
