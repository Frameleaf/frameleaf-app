import { MediaImportItemState, MediaImportState } from '@frameleaf/sdk';
import { inspectionFixture } from '$lib/components/frameleaf/creators/creators.fixture';
import { downloadCounts, downloadShow } from '$lib/frameleaf/creators-downloads.svelte';

const [file] = inspectionFixture().items;
const job = (state: MediaImportState, states: MediaImportItemState[]) =>
  inspectionFixture({
    albumId: 'album-1',
    state,
    items: states.map((item, id) => ({ ...file, id: String(id), state: item })),
  });

describe('downloadCounts', () => {
  it('sorts the files of a download that is going into running, waiting and saved', () => {
    const { Saved, Downloading, Assembling, Discovered, Skipped } = MediaImportItemState;
    expect(
      downloadCounts(
        job(MediaImportState.Downloading, [Saved, Downloading, Assembling, Discovered, Discovered, Skipped]),
      ),
    ).toEqual({ running: 2, waiting: 2, needs: 0, saved: 1 });
  });

  it('counts what a paused or failed download left as needing the owner, not as waiting', () => {
    const { Saved, Discovered, Failed } = MediaImportItemState;
    for (const state of [MediaImportState.Paused, MediaImportState.Failed, MediaImportState.Partial]) {
      expect(downloadCounts(job(state, [Saved, Discovered, Failed]))).toEqual({
        running: 0,
        waiting: 0,
        needs: 2,
        saved: 1,
      });
    }
  });

  it('leaves the rest of a download the owner stopped out of every list', () => {
    const { Saved, Discovered } = MediaImportItemState;
    expect(downloadCounts(job(MediaImportState.Cancelled, [Saved, Discovered]))).toEqual({
      running: 0,
      waiting: 0,
      needs: 0,
      saved: 1,
    });
  });
});

it('reads only a known list from the address', () => {
  expect(downloadShow('needs')).toBe('needs');
  expect(downloadShow('everything')).toBe('all');
  expect(downloadShow(null)).toBe('all');
});
