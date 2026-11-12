import { render, screen } from '@testing-library/svelte';
import LibraryLockedGate from './LibraryLockedGate.svelte';

vi.mock('$lib/components/frameleaf/LockedUnlockDialog.svelte', () => ({ default: () => {} }));

const props = { title: 'Locked', heading: 'Your Locked collection', message: 'Enter your PIN.', actionLabel: 'Unlock' };

// FL-1457 (FL-1391 B1 on the Locked gate): with room the one Timeline tab is in the toolbar row, with no hint row.
describe('LibraryLockedGate layout row (FL-1457)', () => {
  const widthIs = (width: number) =>
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'library-locked-gate' ? width : 0;
    });
  afterEach(() => vi.restoreAllMocks());

  it('puts the tab at the start of the toolbar row, with no hint, at 960px or more', () => {
    widthIs(1200);
    render(LibraryLockedGate, props);

    expect(screen.getByTestId('frameleaf-layout-switch').parentElement).toHaveClass('in-toolbar');
    expect(screen.queryByText('frameleaf_library_layout_timeline_hint')).not.toBeInTheDocument();
  });

  it('keeps the hint beside the tab on a narrower page', () => {
    widthIs(800);
    render(LibraryLockedGate, props);

    expect(screen.getByTestId('frameleaf-layout-switch').parentElement).not.toHaveClass('in-toolbar');
    expect(screen.getByText('frameleaf_library_layout_timeline_hint')).toBeInTheDocument();
  });
});
