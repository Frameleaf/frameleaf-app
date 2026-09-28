import type { UserResponseDto } from '@immich/sdk';
import { render } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import AlbumAvatarStack from '$lib/components/frameleaf/AlbumAvatarStack.svelte';
import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
import FaceCrop from '$lib/components/frameleaf/people/FaceCrop.svelte';
import PetThumbnail from '$lib/components/frameleaf/pets/PetThumbnail.svelte';
import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
import { personFactory } from '@test-data/factories/person-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

/**
 * FL-37 / FL-29: every people photo is a squircle (apple-style.css:137-148 and
 * INTERACTION-REQUIREMENTS.md "People photos use a squircle shape everywhere"), drawn by the
 * global `fl-squircle` mask in app.css so the shape is identical in every engine.
 */
describe('squircle people photos', () => {
  it('masks the person avatar and drops the circular thumbnail', () => {
    const { container } = render(PersonAvatar, { person: personFactory.build(), size: 40 });
    const avatar = container.querySelector('.avatar');
    expect(avatar).toHaveClass('fl-squircle');
    expect(container.querySelector('.rounded-full')).toBeNull();
  });

  it('masks a face crop', () => {
    const { container } = render(FaceCrop, { src: '/face.jpg', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
    expect(container.querySelector('.face-crop')).toHaveClass('fl-squircle');
  });

  it('masks a pet photo and its placeholder', () => {
    const { container } = render(PetThumbnail, { assetId: 'pet-asset', size: 72 });
    expect(container.querySelector('.pet-thumb')).toHaveClass('fl-squircle');
    expect(container.querySelector('.rounded-full')).toBeNull();
  });

  it('masks account avatars everywhere they appear (account menu, members, activity)', () => {
    const user = userAdminFactory.build({ name: 'Robin' });
    const { container } = render(UserAvatar, { user, size: 'md', noTitle: true });
    const figure = container.querySelector('figure');
    expect(figure).toHaveClass('fl-squircle');
    expect(figure).not.toHaveClass('rounded-full');
  });

  it('masks each face in an album avatar stack', () => {
    const users = userAdminFactory.buildList(2) as unknown as UserResponseDto[];
    const { container } = render(AlbumAvatarStack, { users });
    const avatars = container.querySelectorAll('.avatar');
    expect(avatars).toHaveLength(2);
    for (const avatar of avatars) {
      expect(avatar).toHaveClass('fl-squircle');
    }
  });

  it('keeps every other people photo surface on the squircle mask', () => {
    // Surfaces that draw a people photo with their own <img> or placeholder rather than the
    // primitives above. A new circle there would break the owner's "squircle everywhere" rule.
    for (const file of [
      'src/lib/components/frameleaf/RuleBuilder.svelte',
      'src/lib/components/frameleaf/access/LockedRulesPanel.svelte',
      'src/lib/components/frameleaf/FaceTagger.svelte',
      'src/lib/components/asset-viewer/DetailPanelPeople.svelte',
    ]) {
      const source = readFileSync(file, 'utf8');
      for (const [tag] of source.matchAll(/<img[^>]*getPeopleThumbnailUrl[^>]*>/g)) {
        expect(tag, file).toContain('fl-squircle');
      }
      expect(source, file).toContain('fl-squircle');
    }
    for (const file of [
      'src/lib/components/frameleaf/PersonAvatar.svelte',
      'src/lib/components/frameleaf/pets/PetThumbnail.svelte',
    ]) {
      // The ImageThumbnail `circle` prop would clip a circle inside the squircle.
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/^\s*circle\s*$/m);
    }
  });
});
