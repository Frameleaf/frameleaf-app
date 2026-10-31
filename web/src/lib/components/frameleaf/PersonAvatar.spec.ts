import { fireEvent, render } from '@testing-library/svelte';
import PersonAvatar from './PersonAvatar.svelte';

vi.mock('$lib/utils', () => ({
  getPeopleThumbnailUrl: (person: { id: string }) => `/api/people/${person.id}/thumbnail`,
}));

/** A face thumbnail that cannot load falls back to a quiet placeholder, never a broken image. */
describe('PersonAvatar', () => {
  const person = (name: string, updatedAt = '2026-09-21') =>
    ({ id: 'person-1', name, updatedAt, thumbnailPath: '' }) as never;

  it('shows the face thumbnail while it loads', () => {
    const { container } = render(PersonAvatar, { person: person('Ada'), size: 40 });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/people/person-1/thumbnail');
    expect(container.querySelector('[data-testid="person-avatar-fallback"]')).toBeNull();
  });

  it("falls back to the person's initial when the thumbnail fails, and tells the caller", async () => {
    const onUnavailable = vi.fn();
    const { container } = render(PersonAvatar, { person: person('Ada Lovelace'), size: 40, onUnavailable });
    await fireEvent.error(container.querySelector('img')!);
    const fallback = container.querySelector('[data-testid="person-avatar-fallback"]');
    expect(fallback).toHaveTextContent('A');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-broken-asset]')).toBeNull();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it('falls back to a person glyph when the person has no name', async () => {
    const { container } = render(PersonAvatar, { person: person(''), size: 40 });
    await fireEvent.error(container.querySelector('img')!);
    const fallback = container.querySelector('[data-testid="person-avatar-fallback"]');
    expect(fallback?.querySelector('svg')).not.toBeNull();
    expect(fallback?.textContent?.trim()).toBe('');
  });

  it('tries the new thumbnail again when the person is updated', async () => {
    const { container, rerender } = render(PersonAvatar, { person: person('Ada'), size: 40 });
    await fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('[data-testid="person-avatar-fallback"]')).not.toBeNull();
    await rerender({ person: person('Ada', '2026-09-22'), size: 40 });
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('[data-testid="person-avatar-fallback"]')).toBeNull();
  });
});
