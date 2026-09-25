import '@testing-library/jest-dom';
import { fireEvent, render } from '@testing-library/svelte';
import { albumFactory } from '@test-data/factories/album-factory';
import { personFactory } from '@test-data/factories/person-factory';
import ViewerChooserDialog from './ViewerChooserDialog.svelte';

describe('ViewerChooserDialog (V-9)', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  it('lists the albums and resolves with the one picked', async () => {
    const onClose = vi.fn();
    const albums = [albumFactory.build({ albumName: 'Rockies' }), albumFactory.build({ albumName: 'Coast' })];
    const { getByRole } = render(ViewerChooserDialog, { kind: 'album', albums, onClose });

    expect(getByRole('heading', { name: 'frameleaf_viewer_chooser_album_title' })).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Coast' }));
    expect(onClose).toHaveBeenCalledWith({ kind: 'album', album: albums[1] });
  });

  it('lists the people and resolves with the one picked', async () => {
    const onClose = vi.fn();
    const people = [personFactory.build({ name: 'Avery' })];
    const { getByRole } = render(ViewerChooserDialog, { kind: 'person', people, onClose });

    expect(getByRole('heading', { name: 'frameleaf_viewer_chooser_person_title' })).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Avery' }));
    expect(onClose).toHaveBeenCalledWith({ kind: 'person', person: people[0] });
  });

  it('says why there is nothing to choose', () => {
    const { getByText } = render(ViewerChooserDialog, { kind: 'album', albums: [], onClose: vi.fn() });
    expect(getByText('frameleaf_viewer_chooser_no_albums')).toBeInTheDocument();
  });

  it('resolves with nothing when closed without a choice', async () => {
    const onClose = vi.fn();
    const { getByRole } = render(ViewerChooserDialog, { kind: 'person', people: [], onClose });
    await fireEvent.click(getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalledWith(undefined);
  });
});
