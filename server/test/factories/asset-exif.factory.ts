import { Selectable } from 'kysely';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { AssetExifLike } from 'test/factories/types.js';
import { factory } from 'test/small.factory.js';

export class AssetExifFactory {
  private constructor(private readonly value: Selectable<AssetExifTable>) {}

  static create(dto: AssetExifLike = {}) {
    return AssetExifFactory.from(dto).build();
  }

  static from(dto: AssetExifLike = {}) {
    return new AssetExifFactory({
      updatedAt: factory.date(),
      updateId: factory.uuid(),
      assetId: factory.uuid(),
      autoStackId: null,
      bitsPerSample: null,
      imageEncoding: null,
      city: 'Austin',
      colorspace: null,
      country: 'United States of America',
      dateTimeOriginal: factory.date(),
      description: '',
      exifImageHeight: 420,
      exifImageWidth: 42,
      exposureTime: null,
      fileSizeInByte: 69,
      fNumber: 1.7,
      focalLength: 4.38,
      fps: null,
      iso: 947,
      latitude: 30.267334570570195,
      longitude: -97.78983353428207,
      gpsAccuracyM: null,
      lensModel: null,
      livePhotoCID: null,
      mediaKinds: null,
      make: 'Google',
      model: 'Pixel 7',
      // FL-1196: nothing else recorded
      altitude: null,
      shutterCount: null,
      focalLengthIn35mm: null,
      exposureCompensation: null,
      exposureProgram: null,
      meteringMode: null,
      flash: null,
      whiteBalance: null,
      sceneCaptureType: null,
      focusDistance: null,
      lensMake: null,
      lensSerialNumber: null,
      serialNumber: null,
      software: null,
      artist: null,
      copyright: null,
      imageDirection: null,
      gpsSpeed: null,
      modifyDate: factory.date(),
      orientation: '1',
      profileDescription: null,
      projectionType: null,
      rating: 4,
      lockedProperties: [],
      state: 'Texas',
      tags: ['parent/child'],
      timeZone: 'UTC-6',
      ...dto,
    });
  }

  build() {
    return { ...this.value };
  }
}
