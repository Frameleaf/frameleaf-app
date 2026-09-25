import { SearchAskMode, type AskSearchResponseDto } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SEARCH_ASK_EXAMPLES } from '$lib/frameleaf/search-ask';
import en from '../../../../../i18n/en.json';
import SearchAsk from './SearchAsk.svelte';

const answer = (mode: SearchAskMode, warnings: string[] = []) =>
  ({
    query: 'favorite videos since 2020',
    explanation: 'Favorite videos taken since 2020.',
    warnings,
    plan: { mode, normalizedQuery: 'favorite videos since 2020', filters: {} },
    results: { assets: { items: [] }, albums: { items: [] } },
  }) as unknown as AskSearchResponseDto;

describe('SearchAsk (FL-31)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('is a labelled combobox over the Try a search examples', () => {
    render(SearchAsk, { onAsk: vi.fn() });

    const field = screen.getByRole('combobox', { name: 'Ask about your photos' });
    expect(field).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    expect(screen.getByText('Try a search')).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((option) => option.textContent?.trim())).toEqual(
      SEARCH_ASK_EXAMPLES.map((key) => en[key]),
    );
  });

  it('asks the typed question on Enter', async () => {
    const onAsk = vi.fn();
    render(SearchAsk, { onAsk });

    const field = screen.getByRole('combobox');
    await fireEvent.input(field, { target: { value: '  photos in Banff  ' } });
    await fireEvent.keyDown(field, { key: 'Enter' });

    expect(onAsk).toHaveBeenCalledWith('photos in Banff');
  });

  it('moves through the examples with the arrow keys and asks the highlighted one', async () => {
    const onAsk = vi.fn();
    render(SearchAsk, { onAsk });

    const field = screen.getByRole('combobox');
    await fireEvent.keyDown(field, { key: 'ArrowDown' });
    await fireEvent.keyDown(field, { key: 'ArrowDown' });
    const second = screen.getAllByRole('option')[1];
    expect(field).toHaveAttribute('aria-activedescendant', second.id);
    expect(second).toHaveAttribute('aria-selected', 'true');

    await fireEvent.keyDown(field, { key: 'ArrowUp' });
    await fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(field).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option').at(-1)!.id);

    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(onAsk).toHaveBeenCalledWith(en[SEARCH_ASK_EXAMPLES.at(-1)!]);
  });

  it('leaves the list and then clears the field with Escape', async () => {
    render(SearchAsk, { onAsk: vi.fn(), query: 'beach' });

    const field = screen.getByRole('combobox');
    await fireEvent.keyDown(field, { key: 'ArrowDown' });
    await fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).not.toHaveAttribute('aria-activedescendant');
    expect(field).toHaveValue('beach');

    await fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveValue('');
  });

  it('asks nothing while an answer is loading, and says it is searching', async () => {
    const onAsk = vi.fn();
    render(SearchAsk, { onAsk, loading: true, query: 'beach' });

    await fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    await fireEvent.click(screen.getAllByRole('option')[0]);

    expect(onAsk).not.toHaveBeenCalled();
    expect(screen.getByText('Searching…')).toBeInTheDocument();
  });

  it('shows what was searched for, the AI mark for smart search, warnings and the empty state', () => {
    render(SearchAsk, { onAsk: vi.fn(), response: answer(SearchAskMode.Smart, ['No place called home.']), matches: 0 });

    expect(screen.getByText('Favorite videos taken since 2020.')).toBeInTheDocument();
    expect(screen.getByTitle('Read by smart search')).toBeInTheDocument();
    expect(screen.getByText('No place called home.')).toBeInTheDocument();
    expect(screen.getByText('No matches in your library.')).toBeInTheDocument();
    expect(screen.getByText('0 matches')).toBeInTheDocument();
  });

  it('has no AI mark when metadata search answered', () => {
    render(SearchAsk, { onAsk: vi.fn(), response: answer(SearchAskMode.Metadata), matches: 3 });

    expect(screen.queryByTitle('Read by smart search')).not.toBeInTheDocument();
    expect(screen.getByText('3 matches')).toBeInTheDocument();
    expect(screen.queryByText('No matches in your library.')).not.toBeInTheDocument();
  });

  it('reports a failure with Try again', async () => {
    const onRetry = vi.fn();
    render(SearchAsk, { onAsk: vi.fn(), problem: 'failed', onRetry });

    expect(screen.getByRole('alert')).toHaveTextContent("Frameleaf couldn't answer that just now.");
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('says Ask is turned off and offers no field that cannot answer', () => {
    render(SearchAsk, { onAsk: vi.fn(), problem: 'disabled' });

    expect(screen.getByRole('status')).toHaveTextContent('Ask about your photos is turned off on this server.');
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
