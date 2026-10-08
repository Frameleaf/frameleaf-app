import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudTourFacts } from '$lib/frameleaf/cloud-tour';
import CloudTour from './CloudTour.svelte';

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({
  mediaQueryManager: {
    get reducedMotion() {
      return motion.reduced;
    },
    get maxMd() {
      return false;
    },
    get pointerCoarse() {
      return false;
    },
  },
}));

const facts = (patch: Partial<CloudTourFacts> = {}): CloudTourFacts => ({
  license: {
    entitlements: { cloudBackup: false, cloudMl: false, frameleafCloud: false, remoteAccess: false, supporter: false },
    plan: null,
  },
  remoteAccessEnabled: false,
  customHostnameVerified: false,
  processingEnabled: false,
  walletAvailableUsd: 12.5,
  backupConfigured: false,
  ...patch,
});

const setup = (props: Partial<Parameters<typeof render<typeof CloudTour>>[1]> = {}) => {
  const onClose = vi.fn();
  const onOpen = vi.fn();
  render(CloudTour, {
    facts: facts(),
    account: 'owner@example.test',
    planFromUsd: 6,
    licensedDiscount: 0.2,
    onClose,
    onOpen,
    ...props,
  });
  return { onClose, onOpen, dialog: screen.getByRole('dialog', { hidden: true }) };
};

describe('CloudTour (FL-196)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    motion.reduced = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens on the first step with the linked account, its status and its settings page', async () => {
    const { dialog, onOpen, onClose } = setup();
    expect(within(dialog).getByRole('heading', { name: 'Reach your photos from anywhere' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('1 of 6');
    expect(dialog).toHaveTextContent('This server is linked to owner@example.test');
    expect(within(dialog).getByText('owner@example.test').tagName).toBe('STRONG');
    expect(within(dialog).getByTestId('cloud-tour-status')).toHaveTextContent('Needs a plan');

    await fireEvent.click(within(dialog).getByRole('button', { name: /Open Remote access/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ area: 'cloud', section: 'cloud-remote' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves with Next, Back, the arrow keys and labelled page dots, focusing each heading', async () => {
    const { dialog } = setup();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    const address = within(dialog).getByRole('heading', { name: 'An address of your own' });
    await waitFor(() => expect(address).toHaveFocus());
    expect(dialog).toHaveTextContent('2 of 6');
    expect(dialog).not.toHaveTextContent('This server is linked');

    await fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(within(dialog).getByRole('heading', { name: 'Sign in with Frameleaf' })).toBeInTheDocument();
    await fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(within(dialog).getByRole('heading', { name: 'An address of your own' })).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByRole('heading', { name: 'Reach your photos from anywhere' })).toBeInTheDocument();

    const dots = within(within(dialog).getByRole('group', { name: 'Tour steps' })).getAllByRole('button');
    expect(dots).toHaveLength(6);
    expect(dots[0]).toHaveAttribute('aria-current', 'step');
    await fireEvent.click(screen.getByRole('button', { name: 'Step 4: Cloud AI when you choose it', hidden: true }));
    expect(dialog).toHaveTextContent('4 of 6');
    expect(within(dialog).getByTestId('cloud-tour-status')).toHaveTextContent('Off · $12.50 AI credit');
  });

  it('shows the plan step in US dollars with Done instead of Skip', async () => {
    const { dialog, onClose } = setup({ initialStep: 5 });
    expect(dialog).toHaveTextContent('from $6 a month');
    expect(dialog).toHaveTextContent('Licensed servers save 20% on plans');
    expect(within(dialog).getByTestId('cloud-tour-status')).toHaveTextContent('No plan');
    expect(within(dialog).queryByRole('button', { name: 'Skip tour' })).toBeNull();
    for (const name of ['Open Plan', 'Open Licence', 'Open Frameleaf Cloud']) {
      expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
    }
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledWith('finished');
  });

  it('colours the tile by role and carries the brand hairline, with no literal colour', () => {
    const { dialog } = setup();
    const tile = dialog.querySelector<HTMLElement>('.ct-tile')!;
    expect(tile.dataset.tone).toBe('blue');
    expect(tile.getAttribute('style') ?? '').not.toMatch(/#|--tile/);
  });

  it('opens a settings page from a step link', async () => {
    const { dialog, onOpen } = setup({ initialStep: 4 });
    await fireEvent.click(within(dialog).getByRole('button', { name: /^Open / }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ area: 'backups', params: { backupView: 'cloud' } }));
  });

  it('skips with Skip tour or Escape', async () => {
    const { dialog, onClose } = setup();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Skip tour' }));
    expect(onClose).toHaveBeenLastCalledWith('skipped');
    await fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenLastCalledWith('skipped');
  });

  it('slides with the spring, and only crossfades under Reduce Motion', async () => {
    const animate = vi.spyOn(Element.prototype, 'animate');
    const { dialog } = setup();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(animate).toHaveBeenCalled());
    const [frames] = animate.mock.calls[0];
    expect(JSON.stringify(frames)).toContain('translateX(28px)');
    expect(animate).toHaveBeenCalledTimes(2); // the step, and the icon tile's scale

    animate.mockClear();
    motion.reduced = true;
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(animate).toHaveBeenCalled());
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it('turns pages with a horizontal swipe, not with a scroll', async () => {
    const { dialog } = setup();
    const body = dialog.querySelector('.ct-body')!;
    await fireEvent.pointerDown(body, { pointerType: 'touch', clientX: 300, clientY: 200 });
    await fireEvent.pointerUp(body, { pointerType: 'touch', clientX: 180, clientY: 210 });
    expect(dialog).toHaveTextContent('2 of 6');
    await fireEvent.pointerDown(body, { pointerType: 'touch', clientX: 200, clientY: 100 });
    await fireEvent.pointerUp(body, { pointerType: 'touch', clientX: 140, clientY: 300 });
    expect(dialog).toHaveTextContent('2 of 6');
    await fireEvent.pointerDown(body, { pointerType: 'touch', clientX: 100, clientY: 200 });
    await fireEvent.pointerUp(body, { pointerType: 'touch', clientX: 220, clientY: 200 });
    expect(dialog).toHaveTextContent('1 of 6');
  });
});
