import { UserAvatarColor } from '@frameleaf/sdk';
import { render, waitFor } from '@testing-library/svelte';
import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
import { userAdminFactory } from '@test-data/factories/user-factory';

/**
 * The avatar is a profile photo or, when there is none (or it is loading, or failed), a tile in
 * the account's colour with its initial. Nothing of the tile may show around or behind a photo:
 * the figure is only the squircle, and the colour belongs to the tile.
 */
describe('UserAvatar', () => {
  const sam = userAdminFactory.build({ name: 'Sam', profileImagePath: '', avatarColor: UserAvatarColor.Orange });
  const jamie = { ...sam, name: 'Jamie', profileImagePath: 'upload/profile/jamie.jpg' };

  const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
  const decodeWith = (decode: () => Promise<void>) =>
    Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, writable: true, value: decode });

  afterEach(() => {
    if (originalDecode) {
      Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode);
    } else {
      Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
    }
  });

  /** The fallback tile: the only span the avatar draws. */
  const tile = (container: HTMLElement) => container.querySelector('span');

  /** Anything that could draw the fallback: a filled or bordered box, or the initial. */
  const fallbackParts = (container: HTMLElement) => [
    ...container.querySelectorAll('[class*="bg-"], [class*="border"]'),
    ...[...container.querySelectorAll('span')].filter((span) => span.textContent?.trim()),
  ];

  it('is the tile, in the account colour with the initial, when there is no photo', () => {
    const { container } = render(UserAvatar, { user: sam, size: 'md', noTitle: true });

    expect(tile(container)).toHaveTextContent('S');
    expect(tile(container)).toHaveClass('bg-orange-600');
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows nothing of the tile once the photo is up: no colour, no initial, no ring', async () => {
    decodeWith(() => Promise.resolve());
    const { container } = render(UserAvatar, { user: jamie, size: 'md', noTitle: true });

    await waitFor(() => expect(container.querySelector('img')).not.toHaveClass('hidden'));
    expect(fallbackParts(container)).toEqual([]);
    // The figure stays the squircle the photo is cut to.
    expect(container.querySelector('figure')).toHaveClass('fl-squircle');
  });

  it('stands the tile in while the photo loads, then takes it away', async () => {
    let loaded = () => {};
    decodeWith(() => new Promise<void>((resolve) => (loaded = resolve)));
    const { container } = render(UserAvatar, { user: jamie, size: 'md', noTitle: true });

    expect(tile(container)).toHaveClass('bg-orange-600');
    expect(container.querySelector('img')).toHaveClass('hidden');

    loaded();
    await waitFor(() => expect(tile(container)).toBeNull());
    expect(fallbackParts(container)).toEqual([]);
  });

  it('keeps the tile when the photo fails to load', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('broken image')));
    decodeWith(decode);
    const { container } = render(UserAvatar, { user: jamie, size: 'md', noTitle: true });

    await waitFor(() => expect(decode).toHaveBeenCalled());
    expect(tile(container)).toHaveTextContent('J');
    expect(tile(container)).toHaveClass('bg-orange-600');
    expect(container.querySelector('img')).toHaveClass('hidden');
  });
});
