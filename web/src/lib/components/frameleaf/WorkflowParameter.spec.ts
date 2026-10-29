import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import WorkflowParameter from '$lib/components/frameleaf/WorkflowParameter.svelte';
import { clearWorkflowReferenceNames } from '$lib/frameleaf/workflow-references';
import type { WorkflowParameterSchema } from '$lib/frameleaf/workflows';
import { eventManager } from '$lib/managers/event-manager.svelte';

const TRIP = '7f9a1c2e-1111-4a6b-9c3d-000000000001';
const FAMILY = '7f9a1c2e-1111-4a6b-9c3d-000000000002';
const GONE = '7f9a1c2e-1111-4a6b-9c3d-000000000003';

const tags = { type: 'array', items: { type: 'string' }, uiHint: { type: 'TagId' } } as WorkflowParameterSchema;
const albums = { type: 'array', items: { type: 'string' }, uiHint: { type: 'AlbumId' } } as WorkflowParameterSchema;
const tag = (id: string, value: string) => ({ id, value, name: value, createdAt: '', updatedAt: '' }) as never;
const album = (id: string, albumName: string) => ({ id, albumName }) as never;

describe('WorkflowParameter tag and album pickers (FL-647)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearWorkflowReferenceNames();
    sdkMock.searchTags.mockResolvedValue([]);
    sdkMock.getAllAlbums.mockResolvedValue([]);
  });

  it("shows a saved workflow's tags by name, reading only the chosen ones", async () => {
    sdkMock.getTagById.mockImplementation(async ({ id }) => {
      if (id === GONE) {
        throw new Error('not found');
      }
      return tag(id, 'Travel/Trip');
    });
    render(WorkflowParameter, { schema: tags, value: [TRIP, GONE], label: 'Tags', onChange: vi.fn() });

    expect(await screen.findByText('Travel/Trip')).toBeInTheDocument();
    expect(await screen.findByText(`Unavailable selection: ${GONE}`)).toBeInTheDocument();
    expect(sdkMock.getTagById).toHaveBeenCalledTimes(2);
    expect(sdkMock.searchTags).not.toHaveBeenCalled();
  });

  it('reads the chosen names again when the session locks, and drops ones it can no longer read', async () => {
    sdkMock.getTagById.mockResolvedValueOnce(tag(TRIP, 'Private/Trip'));
    render(WorkflowParameter, { schema: tags, value: [TRIP], label: 'Tags', onChange: vi.fn() });
    expect(await screen.findByText('Private/Trip')).toBeInTheDocument();

    sdkMock.getTagById.mockRejectedValueOnce(new Error('not found'));
    eventManager.emit('SessionLocked');

    expect(await screen.findByText(`Unavailable selection: ${TRIP}`)).toBeInTheDocument();
    expect(screen.queryByText('Private/Trip')).toBeNull();
    expect(sdkMock.getTagById).toHaveBeenCalledTimes(2);
  });

  it("shows a saved workflow's albums by name", async () => {
    sdkMock.getAllAlbums.mockImplementation(async ({ id } = {}) => (id === FAMILY ? [album(FAMILY, 'Family')] : []));
    render(WorkflowParameter, { schema: albums, value: [FAMILY], label: 'Albums', onChange: vi.fn() });

    expect(await screen.findByText('Family')).toBeInTheDocument();
    expect(sdkMock.getAllAlbums).toHaveBeenCalledExactlyOnceWith({ id: FAMILY });
  });

  it('searches the server as the person types and adds the chosen tag', async () => {
    const onChange = vi.fn();
    sdkMock.searchTags.mockImplementation(async ({ search } = {}) =>
      search === 'tri' ? [tag(TRIP, 'Travel/Trip')] : [tag(FAMILY, 'Family')],
    );
    render(WorkflowParameter, { schema: tags, value: [], label: 'Tags', onChange });

    const input = screen.getByRole('combobox', { name: 'Find a tag' });
    await fireEvent.focus(input);
    await waitFor(() =>
      expect(sdkMock.searchTags).toHaveBeenCalledWith({ search: undefined, take: 20 }, expect.anything()),
    );
    await fireEvent.input(input, { target: { value: 'tri' } });
    await waitFor(() =>
      expect(sdkMock.searchTags).toHaveBeenLastCalledWith({ search: 'tri', take: 20 }, expect.anything()),
    );
    await fireEvent.click(await screen.findByRole('option', { name: 'Travel/Trip' }));

    expect(onChange).toHaveBeenCalledWith([TRIP]);
  });

  it('searches albums by name, not the whole list', async () => {
    sdkMock.getAllAlbums.mockResolvedValue([album(FAMILY, 'Family')]);
    render(WorkflowParameter, { schema: albums, value: [], label: 'Albums', onChange: vi.fn() });

    const input = screen.getByRole('combobox', { name: 'Find an album' });
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'fam' } });
    await waitFor(() =>
      expect(sdkMock.getAllAlbums).toHaveBeenLastCalledWith({ search: 'fam', take: 20 }, expect.anything()),
    );
    expect(await screen.findByRole('option', { name: 'Family' })).toBeInTheDocument();
  });
});
