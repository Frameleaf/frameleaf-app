import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PersonPicker from './PersonPicker.svelte';

const row = (id: string, name: string, assetCount = 1) => ({ id, name, assetCount, updatedAt: '2026-11-01T00:00:00Z' });

/** FL-1814: the one person picker, over `GET /people/picker`. */
describe('PersonPicker', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('lists people with their counts, leaves out the excluded one, and shows more on request', async () => {
    sdkMock.getPeoplePicker
      .mockResolvedValueOnce({ people: [row('ada', 'Ada', 4), row('grace', 'Grace', 9)], hasNextPage: true })
      .mockResolvedValueOnce({ people: [row('alan', 'Alan', 2)], hasNextPage: false });
    render(PersonPicker, { excludeId: 'ada', label: 'Merge with', onPick: vi.fn() });

    expect(await screen.findByRole('button', { name: /Grace\s*9 items/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ada/ })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: /Alan/ })).toBeInTheDocument();
    expect(sdkMock.getPeoplePicker).toHaveBeenLastCalledWith(
      { withHidden: true, page: 2, size: 50 },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('finds anyone by name through the server, once per pause in typing, newest answer winning', async () => {
    const answers = new Map<string, (value: never) => void>();
    sdkMock.getPeoplePicker.mockImplementation(
      (options) =>
        new Promise((resolve) => answers.set(options?.name ?? '', resolve as (value: never) => void)) as never,
    );
    render(PersonPicker, { label: 'Move to', onPick: vi.fn() });
    await waitFor(() => expect(answers.has('')).toBe(true));
    answers.get('')!({ people: [], hasNextPage: false } as never);

    const box = screen.getByRole('searchbox');
    await fireEvent.input(box, { target: { value: 'z' } });
    await fireEvent.input(box, { target: { value: 'zo' } });
    await waitFor(() => expect(answers.has('zo')).toBe(true));
    await fireEvent.input(box, { target: { value: 'zoe' } });
    await waitFor(() => expect(answers.has('zoe')).toBe(true));
    expect(answers.has('z')).toBe(false);

    answers.get('zoe')!({ people: [row('zoe', 'Zoe')], hasNextPage: false } as never);
    expect(await screen.findByRole('button', { name: /Zoe/ })).toBeInTheDocument();
    answers.get('zo')!({ people: [row('zola', 'Zola')], hasNextPage: false } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: /Zola/ })).toBeNull();
  });

  it('offers someone new, named after what was typed', async () => {
    sdkMock.getPeoplePicker.mockResolvedValue({ people: [], hasNextPage: false });
    const onNew = vi.fn();
    render(PersonPicker, { label: 'Move to', onPick: vi.fn(), onNew });

    await fireEvent.click(await screen.findByRole('button', { name: 'Someone new…' }));
    expect(onNew).toHaveBeenLastCalledWith('');
    await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'Rosa' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Someone new called “Rosa”' }));
    expect(onNew).toHaveBeenLastCalledWith('Rosa');
  });

  it('has no "Someone new" when the caller cannot make one, and leaves out unnamed people when asked', async () => {
    sdkMock.getPeoplePicker.mockResolvedValue({ people: [row('u', ''), row('b', 'Bea')], hasNextPage: false });
    render(PersonPicker, { label: 'Related to', onPick: vi.fn(), namedOnly: true });

    expect(await screen.findByRole('button', { name: /Bea/ })).toBeInTheDocument();
    expect(screen.queryByText('Unnamed person')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Someone new…' })).toBeNull();
  });
});
