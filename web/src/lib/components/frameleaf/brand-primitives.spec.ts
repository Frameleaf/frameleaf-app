import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOGO_CLEAR_SPACE, LOGO_MIN_HEIGHT } from '$lib/frameleaf/tokens';
import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
import en from '../../../../../i18n/en.json';
import logoWhiteUrl from '../../assets/frameleaf/frameleaf-logo-white.svg?url';
import symbolWhiteUrl from '../../assets/frameleaf/frameleaf-symbol-white.svg?url';
import symbolUrl from '../../assets/frameleaf/frameleaf-symbol.svg?url';
import CountUp from './CountUp.svelte';
import EmptyState from './EmptyState.svelte';
import InlineError from './InlineError.svelte';
import Logo from './Logo.svelte';
import Skeleton from './Skeleton.svelte';
import Spinner from './Spinner.svelte';
import Toast from './Toast.svelte';

/** The shared brand primitives: the states every area draws the same way. */
describe('Frameleaf brand primitives', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('InlineError', () => {
    it('announces a plain message and offers a real Retry button', async () => {
      const onRetry = vi.fn();
      render(InlineError, { title: 'Duplicates', message: 'Frameleaf could not load this tool.', onRetry });

      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Duplicates');
      expect(alert).toHaveTextContent('Frameleaf could not load this tool.');
      const retry = screen.getByRole('button', { name: en.frameleaf_error_retry });
      expect(retry.classList).toContain('button');
      await fireEvent.click(retry);
      expect(onRetry).toHaveBeenCalledOnce();
    });

    it('disables Retry while the retry is running, and omits it when there is nothing to retry', async () => {
      const { rerender } = render(InlineError, {
        message: 'No.',
        onRetry: vi.fn(),
        retrying: true,
        retryLabel: 'Load',
      });
      expect(screen.getByRole('button', { name: 'Load' })).toBeDisabled();
      await rerender({ message: 'No.', onRetry: undefined, retrying: false });
      expect(screen.queryByRole('button')).toBeNull();
    });
  });

  describe('EmptyState', () => {
    it('says what is missing and leads with one primary way forward', async () => {
      const upload = vi.fn();
      render(EmptyState, {
        title: 'No photos yet',
        message: 'Upload photos to start your library.',
        action: { label: 'Upload photos', onClick: upload },
        secondaryAction: { label: 'Import from a folder', href: '/utilities' },
      });

      expect(screen.getByRole('status')).toHaveTextContent('Upload photos to start your library.');
      expect(screen.getByRole('heading', { level: 2, name: 'No photos yet' })).toBeInTheDocument();
      const primary = screen.getByRole('button', { name: 'Upload photos' });
      expect(primary.classList).toContain('primary');
      await fireEvent.click(primary);
      expect(upload).toHaveBeenCalledOnce();
      const secondary = screen.getByRole('link', { name: 'Import from a folder' });
      expect(secondary).toHaveAttribute('href', '/utilities');
      expect(secondary.classList).not.toContain('primary');
    });

    it('frames the icon at full size, and stays plain when compact', async () => {
      const { container, rerender } = render(EmptyState, { icon: 'M0 0', message: 'No albums yet.' });
      // A full-size empty state has no photographs beside it, so it carries the framed icon.
      expect(container.querySelector('.icon')?.classList).toContain('framed');
      await rerender({ icon: 'M0 0', message: 'No albums yet.', compact: true });
      expect(container.querySelector('.icon')?.classList).not.toContain('framed');
    });
  });

  describe('Spinner', () => {
    it('is one ring with a text label, or decorative when its control already says so', async () => {
      const { container, rerender } = render(Spinner, { size: 'xl' });
      expect(screen.getByRole('status')).toHaveTextContent(en.loading);
      const ring = container.querySelector<HTMLElement>('.fl-spinner');
      expect(ring?.getAttribute('aria-hidden')).toBe('true');
      expect(ring?.style.getPropertyValue('--fl-spinner-size')).toBe('20px');

      await rerender({ size: 40, decorative: true });
      expect(screen.queryByRole('status')).toBeNull();
      expect(container.querySelector<HTMLElement>('.fl-spinner')?.style.getPropertyValue('--fl-spinner-size')).toBe(
        '40px',
      );
    });

    it('stays hidden for a fast load when given a delay', async () => {
      vi.useFakeTimers();
      const { container } = render(Spinner, { delay: 200 });
      expect(container.querySelector('.fl-spinner')).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(container.querySelector('.fl-spinner')).not.toBeNull();
    });
  });

  describe('Skeleton', () => {
    it('draws text lines, hidden from assistive technology, with a shorter last line', () => {
      const { container } = render(Skeleton, { lines: 3 });
      const lines = container.querySelectorAll('.fl-skeleton.line');
      expect(lines).toHaveLength(3);
      expect(lines[2].classList).toContain('short');
      expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    });

    it('shows a thumbhash at once under a photo tile, and does not pulse it', () => {
      const { container } = render(Skeleton, {
        variant: 'tile',
        thumbhash: 'data:image/png;base64,AAAA',
        aspect: '4 / 3',
      });
      const tile = container.querySelector<HTMLElement>('.fl-skeleton.tile');
      expect(tile?.style.backgroundImage).toContain('data:image/png;base64,AAAA');
      expect(tile?.style.aspectRatio).toBe('4 / 3');
      expect(tile?.classList).toContain('still');
    });
  });

  describe('Toast', () => {
    it('drops the generic title, shows the message, and announces politely', () => {
      render(Toast, { title: en.success, description: 'Added 3 photos to Summer', color: 'primary', onClose: vi.fn() });
      const toast = screen.getByRole('status');
      expect(toast).toHaveTextContent('Added 3 photos to Summer');
      expect(toast).not.toHaveTextContent(en.success);
    });

    it('announces an error as an alert and keeps a real title', () => {
      render(Toast, { title: 'Upload paused', description: 'Storage is full.', color: 'danger' });
      const toast = screen.getByRole('alert');
      expect(toast).toHaveTextContent('Upload paused');
      expect(toast).toHaveTextContent('Storage is full.');
    });

    it('runs its action, then closes; the close button only closes', async () => {
      const onClose = vi.fn();
      const undo = vi.fn();
      render(Toast, { description: 'Moved to Trash', button: { label: en.undo, onclick: undo }, onClose });
      await fireEvent.click(screen.getByRole('button', { name: en.undo }));
      expect(undo).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
      await fireEvent.click(screen.getByRole('button', { name: en.dismiss }));
      expect(undo).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('hands the close function to an action that is built from it', async () => {
      const onClose = vi.fn();
      render(Toast, {
        description: 'Verdict saved',
        button: (close: () => void) => ({ label: en.undo, onclick: close }),
        onClose,
      });
      await fireEvent.click(screen.getByRole('button', { name: en.undo }));
      expect(onClose).toHaveBeenCalled();
    });

    it('renders custom content when given children', () => {
      const children = createRawSnippet(() => ({ render: () => '<span>Custom toast</span>' }));
      render(Toast, { children });
      expect(screen.getByRole('status')).toHaveTextContent('Custom toast');
    });
  });

  describe('CountUp', () => {
    it('shows the value at once under Reduce Motion and always reads the final value', () => {
      vi.spyOn(mediaQueryManager, 'reducedMotion', 'get').mockReturnValue(true);
      const { container } = render(CountUp, { value: 7271 });
      expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('7,271');
      expect(container.querySelector('.sr-only')?.textContent).toBe('7,271');
    });

    it('starts from zero when motion is allowed, with the final value still read out', () => {
      vi.spyOn(mediaQueryManager, 'reducedMotion', 'get').mockReturnValue(false);
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
      const { container } = render(CountUp, { value: 320, format: (value: number) => `${Math.round(value)} GB` });
      expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('0 GB');
      expect(container.querySelector('.sr-only')?.textContent).toBe('320 GB');
    });
  });

  describe('Logo usage rules', () => {
    it('uses the white artwork only for mono on a dark surface', () => {
      const dark = render(Logo, { variant: 'symbol', surface: 'dark', mono: true });
      expect(dark.container.querySelector('img')?.getAttribute('src')).toBe(symbolWhiteUrl);
      dark.unmount();

      const lockup = render(Logo, { variant: 'lockup', surface: 'dark', mono: true });
      expect(lockup.container.querySelector('img')?.getAttribute('src')).toBe(logoWhiteUrl);
      lockup.unmount();

      // There is no mono artwork for a light surface: the gradient symbol and the name as text.
      const light = render(Logo, { variant: 'lockup', surface: 'light', mono: true });
      const images = [...light.container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
      expect(images).toEqual([symbolUrl]);
      expect(light.getByText('Frameleaf')).toBeInTheDocument();
    });

    it('fades in only when asked to arrive', () => {
      const still = render(Logo, { variant: 'symbol' });
      expect(still.container.querySelector('img')?.classList).not.toContain('fl-logo-arrive');
      still.unmount();
      const arriving = render(Logo, { variant: 'lockup', surface: 'dark', arrive: true });
      expect(arriving.container.querySelector('img')?.classList).toContain('fl-logo-arrive');
    });

    it('follows the app theme on an automatic surface', () => {
      const { container } = render(Logo, { variant: 'symbol', surface: 'auto' });
      expect(container.querySelector('img')?.getAttribute('src')).toBe(symbolUrl);
    });

    it('never draws below the minimum height and pads clear space from the drawn size', () => {
      const { container } = render(Logo, { variant: 'lockup', surface: 'dark', size: 'small', clearSpace: true });
      const img = container.querySelector<HTMLElement>('img');
      expect(img?.style.minHeight).toBe(`${LOGO_MIN_HEIGHT.lockup}px`);
      expect(img?.style.padding).toBe(`${40 * LOGO_CLEAR_SPACE}px`);
      expect(LOGO_MIN_HEIGHT.symbol).toBeLessThan(LOGO_MIN_HEIGHT.lockup);
    });
  });
});
