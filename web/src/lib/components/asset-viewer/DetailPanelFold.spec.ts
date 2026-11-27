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
    render(DetailPanelFold, { id: 'details', label: 'File and camera', children: section });
    expect(fold('details').open).toBe(false);
    expect(fold('details').querySelector('summary')).toHaveTextContent('File and camera');
    // The content stays mounted while closed, so the fold knows whether it has anything to show.
    expect(screen.getByTestId('inside')).toBeInTheDocument();
    expect(screen.getByTestId('inside')).not.toBeVisible();
  });

  it('remembers that it was left open, and that it was closed again', async () => {
    const first = render(DetailPanelFold, { id: 'credits', label: 'Credits', children: section });
    fold('credits').open = true;
    await waitFor(() => expect(stored()).toMatchObject({ credits: true }));
    first.unmount();

    const second = render(DetailPanelFold, { id: 'credits', label: 'Credits', children: section });
    expect(fold('credits').open).toBe(true);
    expect(screen.getByTestId('inside')).toBeVisible();
    fold('credits').open = false;
    await waitFor(() => expect(stored()).toMatchObject({ credits: false }));
    second.unmount();

    render(DetailPanelFold, { id: 'credits', label: 'Credits', children: section });
    expect(fold('credits').open).toBe(false);
  });

  it('remembers each fold on its own', async () => {
    render(DetailPanelFold, { id: 'sensitive', label: 'One', children: section });
    render(DetailPanelFold, { id: 'scan', label: 'Two', children: section });
    fold('sensitive').open = true;
    await waitFor(() => expect(stored()).toMatchObject({ sensitive: true }));
    expect(fold('scan').open).toBe(false);
    expect(stored().scan).toBeUndefined();
  });

  it('has nothing but its summary when there is nothing to show, which is what hides it', () => {
    render(DetailPanelFold, { id: 'text', label: 'Scan', children: content('<!---->') });
    render(DetailPanelFold, { id: 'details', label: 'Scan', children: section });
    expect(fold('text').matches(EMPTY)).toBe(true);
    expect(fold('details').matches(EMPTY)).toBe(false);
  });
});
