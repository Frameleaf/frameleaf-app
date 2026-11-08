import { AssetType } from 'src/enum.js';
import { detectMediaKinds } from 'src/utils/media-kinds.js';

const image = { type: AssetType.Image, originalFileName: 'IMG_0001.HEIC', width: 4032, height: 3024 };
const video = { type: AssetType.Video, originalFileName: 'IMG_0002.MOV', fps: 30 };

describe('detectMediaKinds', () => {
  it('finds nothing in an ordinary photo or video', () => {
    expect(detectMediaKinds({ Make: 'Apple', LensModel: 'iPhone 15 back camera' }, image)).toEqual([]);
    expect(detectMediaKinds({}, video)).toEqual([]);
  });

  describe('slow motion and time-lapse', () => {
    it('reads an iPhone 240 fps clip as slow motion', () => {
      expect(detectMediaKinds({}, { ...video, fps: 240 })).toEqual(['slow-motion']);
      expect(detectMediaKinds({ FullFrameRatePlaybackIntent: 0 }, { ...video, fps: 120 })).toEqual(['slow-motion']);
    });

    it('leaves high frame rate clips meant to play in real time alone', () => {
      expect(detectMediaKinds({ FullFrameRatePlaybackIntent: 1 }, { ...video, fps: 120 })).toEqual([]);
      expect(detectMediaKinds({}, { ...video, fps: 60 })).toEqual([]);
    });

    it('compares the Android capture rate with the playback rate', () => {
      expect(detectMediaKinds({ AndroidCaptureFPS: 240 }, { ...video, fps: 30 })).toEqual(['slow-motion']);
      expect(detectMediaKinds({ AndroidCaptureFPS: 1 }, { ...video, fps: 30 })).toEqual(['time-lapse']);
      expect(detectMediaKinds({ AndroidCaptureFPS: 120 }, { ...video, fps: 120 })).toEqual([]);
    });

    it('never calls a photo slow motion', () => {
      expect(detectMediaKinds({ FullFrameRatePlaybackIntent: 0 }, { ...image })).toEqual([]);
    });
  });

  describe('panoramas', () => {
    it('reads the iPhone CustomRendered code, GPano projection and Pixel special type', () => {
      expect(detectMediaKinds({ CustomRendered: 6 }, image)).toEqual(['panorama']);
      expect(detectMediaKinds({}, { ...image, projectionType: 'CYLINDRICAL' })).toEqual(['panorama']);
      expect(
        detectMediaKinds(
          { SpecialTypeID: 'com.google.android.apps.camera.gallery.specialtype.SpecialType-PANORAMA' },
          image,
        ),
      ).toEqual(['panorama']);
    });

    it('treats a very wide or very tall still as a panorama', () => {
      expect(detectMediaKinds({}, { ...image, width: 12_000, height: 3000 })).toEqual(['panorama']);
      expect(detectMediaKinds({}, { ...image, width: 3000, height: 9000 })).toEqual(['panorama']);
      expect(detectMediaKinds({}, { ...image, width: 4000, height: 2000 })).toEqual([]);
    });

    it('keeps 360° photos apart from flat panoramas', () => {
      expect(detectMediaKinds({}, { ...image, projectionType: 'EQUIRECTANGULAR', width: 8000, height: 4000 })).toEqual([
        'spherical',
      ]);
      expect(detectMediaKinds({}, { ...image, originalFileName: 'IMG_1.insp' })).toEqual(['spherical']);
    });
  });

  it('reads burst ids from Apple, Google and Samsung', () => {
    expect(detectMediaKinds({ BurstUUID: '0A1B' }, image)).toEqual(['burst']);
    expect(detectMediaKinds({ BurstID: 'x' }, image)).toEqual(['burst']);
    expect(detectMediaKinds({ CameraBurstID: 'y' }, image)).toEqual(['burst']);
  });

  it('reads portraits from CustomRendered 7 and 8 and the Pixel special type', () => {
    expect(detectMediaKinds({ CustomRendered: 8 }, image)).toEqual(['portrait']);
    expect(detectMediaKinds({ CustomRendered: 7 }, image)).toEqual(['portrait']);
    expect(
      detectMediaKinds(
        { SpecialTypeID: 'com.google.android.apps.camera.gallery.specialtype.SpecialType-PORTRAIT' },
        image,
      ),
    ).toEqual(['portrait']);
    expect(detectMediaKinds({ CustomRendered: 3 }, image)).toEqual([]);
  });

  it('reads selfies from the front lens name', () => {
    expect(detectMediaKinds({ LensModel: 'iPhone 15 Pro front camera 2.69mm f/1.9' }, image)).toEqual(['selfie']);
    expect(detectMediaKinds({ LensModel: 'iPhone 15 Pro front camera 2.69mm f/1.9' }, video)).toEqual(['selfie']);
    expect(detectMediaKinds({ LensModel: 'iPhone 15 Pro back triple camera' }, image)).toEqual([]);
  });

  it('reads screenshots from the iOS user comment and common file names', () => {
    expect(detectMediaKinds({ UserComment: 'Screenshot' }, { ...image, originalFileName: 'IMG_0003.PNG' })).toEqual([
      'screenshot',
    ]);
    expect(detectMediaKinds({}, { ...image, originalFileName: 'Screenshot_20240101-101010.png' })).toEqual([
      'screenshot',
    ]);
    expect(detectMediaKinds({}, { ...image, originalFileName: 'Bildschirmfoto 2024-01-01 um 10.00.00.png' })).toEqual([
      'screenshot',
    ]);
  });

  it('reads screen recordings from their file names', () => {
    expect(detectMediaKinds({}, { ...video, originalFileName: 'Screen Recording 2024-01-01 at 10.00.00.mov' })).toEqual(
      ['screen-recording'],
    );
  });

  it('accepts exiftool values given as strings or arrays', () => {
    expect(detectMediaKinds({ CustomRendered: '8' }, image)).toEqual(['portrait']);
    expect(detectMediaKinds({ AndroidCaptureFPS: ['240'] }, { ...video, fps: 30 })).toEqual(['slow-motion']);
  });
});
