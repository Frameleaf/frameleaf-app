import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import DetailPanelFold from './DetailPanelFold.svelte';

const STORE = 'frameleaf-viewer-info-folds';
const content = (html: string) => createRawSnippet(() => ({ render: () => html }));
const section = content('<section data-testid="inside">Inside</section>');
const fold = (id: string) => document.querySelector<HTMLDetailsElement>(`details[data-fold="${CSS.escape(id)}"]`)!;
const stored = () => JSON.parse(localStorage.getItem(STORE) ?? '{}');
/** The rule in the component's style that hides a fold with nothing in it. */
const EMPTY = ':not(:has(> :not(summary)))';

// The store is read once, when the component module loads; each test uses its own fold id.
describe('DetailPanelFold (FL-1811)', () => {
  it('starts closed, under a summary that names it', () => {
    render(DetailPanelFold, { id: 'closed', label: 'File and camera', children: section });
    expect(fold('closed').open).toBe(false);
    expect(fold('closed').querySelector('summary')).toHaveTextContent('File and camera');
    // The content stays mounted while closed, so the fold knows whether it has anything to show.
    expect(screen.getByTestId('inside')).toBeInTheDocument();
    expect(screen.getByTestId('inside')).not.toBeVisible();
  });

  it('remembers that it was left open, and that it was closed again', async () => {
    const first = render(DetailPanelFold, { id: 'kept', label: 'Credits', children: section });
    fold('kept').open = true;
    await waitFor(() => expect(stored()).toMatchObject({ kept: true }));
    first.unmount();

    const second = render(DetailPanelFold, { id: 'kept', label: 'Credits', children: section });
    expect(fold('kept').open).toBe(true);
    expect(screen.getByTestId('inside')).toBeVisible();
    fold('kept').open = false;
    await waitFor(() => expect(stored()).toMatchObject({ kept: false }));
    second.unmount();

    render(DetailPanelFold, { id: 'kept', label: 'Credits', children: section });
    expect(fold('kept').open).toBe(false);
  });

  it('remembers each fold on its own', async () => {
    render(DetailPanelFold, { id: 'one', label: 'One', children: section });
    render(DetailPanelFold, { id: 'two', label: 'Two', children: section });
    fold('one').open = true;
    await waitFor(() => expect(stored()).toMatchObject({ one: true }));
    expect(fold('two').open).toBe(false);
    expect(stored().two).toBeUndefined();
  });

  it('has nothing but its summary when there is nothing to show, which is what hides it', () => {
    render(DetailPanelFold, { id: 'empty', label: 'Scan', children: content('<!---->') });
    render(DetailPanelFold, { id: 'full', label: 'Scan', children: section });
    expect(fold('empty').matches(EMPTY)).toBe(true);
    expect(fold('full').matches(EMPTY)).toBe(false);
  });
});
