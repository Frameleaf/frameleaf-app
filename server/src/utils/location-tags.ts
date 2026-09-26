/**
 * FL-54: every exiftool tag selector that places a file. exiftool's family-2 `Location` group holds
 * coordinates and place names (EXIF GPS IFD, XMP `exif:GPS*`, IPTC and XMP place names, QuickTime
 * `UserData`/`Keys` GPSCoordinates, Samsung's network country code); the whole `GPS` group and any tag
 * named `GPS*` or `Location*` (Apple's `Keys:LocationAccuracyHorizontal`, GPS time stamps,
 * `XMP-iptcExt:LocationShown`) go with it.
 */
export const LOCATION_TAG_SELECTORS = ['-location:all', '-gps:all', '-gps*', '-location*'];

/** exiftool arguments that delete every location tag it can write */
export const LOCATION_DELETE_ARGS = LOCATION_TAG_SELECTORS.map((selector) => `${selector}=`);

/**
 * Samsung's trailer (motion clip, `MCCData` network country code) cannot be rewritten, only dropped as a
 * whole. Owner default (FL-54 review D1): a location-hidden viewer gets the photo without it, and the
 * motion-photo XMP pointing at the removed clip goes too.
 */
export const SAMSUNG_TRAILER_DELETE_ARGS = [
  '-trailer:all=',
  '-XMP-GCamera:MotionPhoto*=',
  '-XMP-GCamera:MicroVideo*=',
  '-XMP-Container:all=',
];
