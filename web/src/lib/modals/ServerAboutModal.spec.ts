import { render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { expect, it, vi } from 'vitest';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import ServerAboutModal from './ServerAboutModal.svelte';

it('exposes the translated About title as the real dialog accessible name', async () => {
  vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  vi.stubGlobal('visualViewport', getVisualViewportMock());
  Element.prototype.animate = getAnimateMock();
  addMessages('dev', { about: 'About' });

  const view = render(ServerAboutModal, {
    props: {
      onClose: vi.fn(),
      info: { version: 'v3.2.0', versionUrl: '', licensed: false },
      versions: [],
    },
  });

  expect(await screen.findByRole('dialog', { name: 'About' })).toBeInTheDocument();
  expect(document.body.style.pointerEvents).toBe('none');
  view.unmount();
  // Bits UI restores the body asynchronously; finish that work before destroying the test document.
  await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'));
});
