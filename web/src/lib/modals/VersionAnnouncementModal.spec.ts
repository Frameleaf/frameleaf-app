import { render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import en from '../../../../i18n/en.json';
import VersionAnnouncementModal from './VersionAnnouncementModal.svelte';

describe('VersionAnnouncementModal component', () => {
  beforeEach(() => {
    addMessages('dev', en);
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    Element.prototype.animate = getAnimateMock();
  });

  afterAll(async () => {
    await waitFor(() => {
      expect(document.body.style.pointerEvents).not.toBe('none');
    });
  });

  test('links to the GitHub release notes of the announced Frameleaf version', async () => {
    render(VersionAnnouncementModal, { serverVersion: 'v2.0.0', releaseVersion: 'v2.1.0', onClose: vi.fn() });

    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/Frameleaf/frameleaf-app/releases?q=frameleaf-v2.1.0&expanded=true',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('href')).not.toContain('immich-app');
  });
});
