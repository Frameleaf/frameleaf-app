import { captureDetails } from 'src/utils/capture-details.js';

describe(captureDetails.name, () => {
  it('reads altitude, shutter count and the other details a camera records', () => {
    expect(
      captureDetails({
        Make: 'Canon',
        GPSAltitude: 1383.4,
        ShutterCount: 48_210,
        FocalLengthIn35mmFormat: 35,
        ExposureCompensation: -0.7,
        ExposureProgram: 'Aperture-priority AE',
        MeteringMode: 'Multi-segment',
        Flash: 'Off, Did not fire',
        WhiteBalance: 'Auto',
        SceneCaptureType: 'Standard',
        FocusDistance: 3.2,
        LensMake: 'Canon',
        LensSerialNumber: '0000c1234',
        SerialNumber: '052021001234',
        Software: 'Firmware Version 1.8.1',
        Artist: 'Taylor',
        Copyright: '© Cedar & Light',
        GPSImgDirection: 271.5,
        GPSSpeed: 10,
        GPSSpeedRef: 'N',
      }),
    ).toEqual({
      altitude: 1383.4,
      shutterCount: 48_210,
      focalLengthIn35mm: 35,
      exposureCompensation: -0.7,
      exposureProgram: 'Aperture-priority AE',
      meteringMode: 'Multi-segment',
      flash: 'Off, Did not fire',
      whiteBalance: 'Auto',
      sceneCaptureType: 'Standard',
      focusDistance: 3.2,
      lensMake: 'Canon',
      lensSerialNumber: '0000c1234',
      serialNumber: '052021001234',
      software: 'Firmware Version 1.8.1',
      title: null,
      artist: 'Taylor',
      copyright: '© Cedar & Light',
      imageDirection: 271.5,
      gpsSpeed: 18.52,
    });
  });

  it('uses Dublin Core values before camera and IPTC fallbacks', () => {
    expect(
      captureDetails({
        Title: 'XMP title',
        ObjectName: 'IPTC title',
        XPTitle: 'EXIF title',
        Creator: ['Studio A', 'Studio B'],
        Artist: 'EXIF artist',
        ByLine: 'IPTC artist',
        Rights: 'XMP rights',
        Copyright: 'EXIF rights',
        CopyrightNotice: 'IPTC rights',
      }),
    ).toMatchObject({ title: 'XMP title', artist: 'Studio A, Studio B', copyright: 'XMP rights' });
    expect(
      captureDetails({
        Title: '',
        ObjectName: 'IPTC title',
        Creator: [],
        Artist: 'EXIF artist',
        CopyrightNotice: 'IPTC rights',
      }),
    ).toMatchObject({ title: 'IPTC title', artist: 'EXIF artist', copyright: 'IPTC rights' });
  });

  it('puts below-sea-level altitude below zero and ignores what is not a value', () => {
    const details = captureDetails({ GPSAltitude: 28, GPSAltitudeRef: 1, ShutterCount: 'n/a', Software: 'Unknown' });
    expect(details.altitude).toBe(-28);
    expect(details.shutterCount).toBeNull();
    expect(details.software).toBeNull();
  });

  it('keeps blank numeric tags as missing measurements, not zero', () => {
    const details = captureDetails({
      GPSAltitude: '',
      ShutterCount: [null],
      FocusDistance: '  ',
      GPSImgDirection: [''],
    });
    expect(details).toMatchObject({ altitude: null, shutterCount: null, focusDistance: null, imageDirection: null });
    expect(captureDetails({ ShutterCount: ['1200'] }).shutterCount).toBe(1200);
  });

  it('counts Fujifilm images as shutter actuations, and no other maker’s', () => {
    expect(captureDetails({ Make: 'FUJIFILM', ImageCount: 1200 }).shutterCount).toBe(1200);
    expect(captureDetails({ Make: 'Apple', ImageCount: 1200 }).shutterCount).toBeNull();
  });
});
