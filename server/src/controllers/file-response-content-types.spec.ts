import { Reflector } from '@nestjs/core';
import { AssetMediaController } from 'src/controllers/asset-media.controller.js';
import { CloudBackupOwnerController } from 'src/controllers/cloud-backup-owner.controller.js';
import { EnrichmentController } from 'src/controllers/enrichment.controller.js';
import { PersonController } from 'src/controllers/person.controller.js';
import { SharedSpaceController } from 'src/controllers/shared-space.controller.js';
import { StudioMediaController } from 'src/controllers/studio-media.controller.js';
import { UserController } from 'src/controllers/user.controller.js';

// @nestjs/swagger's DECORATORS.API_RESPONSE
const API_RESPONSE = 'swagger/apiResponse';

const reflector = new Reflector();

const contentTypes = (method: (...args: never[]) => unknown) => {
  const responses = reflector.get<Record<string, { content?: object }>>(API_RESPONSE, method);
  return Object.keys(responses['200']?.content ?? {}).toSorted();
};

// FL-436: strict generated clients reject a Content-Type the spec does not list, so each image route
// documents what it really sends. application/octet-stream stays listed for existing clients.
describe('file response content types (FL-436)', () => {
  it.each([
    ['viewAsset', AssetMediaController.prototype.viewAsset, ['image/*', 'image/jpeg', 'image/webp']],
    ['getPersonThumbnail', PersonController.prototype.getPersonThumbnail, ['image/jpeg']],
    ['getProfileImage', UserController.prototype.getProfileImage, ['image/*', 'image/jpeg', 'image/webp']],
    [
      'viewSharedSpacePreviewThumbnail',
      SharedSpaceController.prototype.viewSharedSpacePreviewThumbnail,
      ['image/jpeg', 'image/webp'],
    ],
    ['getVideoMomentFrame', EnrichmentController.prototype.getVideoMomentFrame, ['image/jpeg']],
    [
      'viewAssetFilmstripSprite',
      StudioMediaController.prototype.viewAssetFilmstripSprite,
      ['image/jpeg', 'image/webp'],
    ],
  ])('%s lists the image types it sends', (_name, method, types) => {
    expect(contentTypes(method)).toEqual(['application/octet-stream', ...types].toSorted());
  });

  it.each([
    // streams verified backup objects with an explicit application/octet-stream header
    ['getOwnBackupThumbnail', CloudBackupOwnerController.prototype.getOwnBackupThumbnail],
    // originals and video keep their varying types
    ['downloadAsset', AssetMediaController.prototype.downloadAsset],
    ['playAssetVideo', AssetMediaController.prototype.playAssetVideo],
  ])('%s keeps application/octet-stream only', (_name, method) => {
    expect(contentTypes(method)).toEqual(['application/octet-stream']);
  });
});
