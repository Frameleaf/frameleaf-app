/**
 * Why this server cannot decode a video (FL-101), in the person's words.
 *
 * The server's decode qualification (`server/src/utils/media-decode.ts`) refuses a source before any
 * editing: a Dolby Vision profile outside the qualified matrix, more than 12 bits per component, a
 * pixel format it cannot describe, or no usable picture size. The quick editor says so before the
 * person starts, and Studio says so for a video placed in a project. Both show the same sentence.
 */
import { DecodeRefusal } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';

const decodeRefusalKeys: Record<DecodeRefusal, Translations> = {
  [DecodeRefusal.DolbyVisionProfile5]: 'frameleaf_video_editor_color_unsupported',
  [DecodeRefusal.DolbyVisionEnhancementLayer]: 'frameleaf_video_editor_decode_dolby_vision_enhancement_layer',
  [DecodeRefusal.DolbyVisionProfileUnqualified]: 'frameleaf_video_editor_decode_dolby_vision_profile',
  [DecodeRefusal.DolbyVisionBaseLayerUnknown]: 'frameleaf_video_editor_decode_dolby_vision_base_layer',
  [DecodeRefusal.UnknownPixelFormat]: 'frameleaf_video_editor_decode_pixel_format',
  [DecodeRefusal.UnsupportedBitDepth]: 'frameleaf_video_editor_decode_bit_depth',
  [DecodeRefusal.UnusableGeometry]: 'frameleaf_video_editor_decode_geometry',
};

/**
 * The sentence for a refusal. Without a code (an older server, or a render-policy refusal that is not a
 * decode refusal) it is the Dolby Vision profile 5 sentence, which is what such a refusal always meant.
 */
export const decodeRefusalMessageKey = (refusal: DecodeRefusal | null | undefined): Translations =>
  (refusal && decodeRefusalKeys[refusal]) || 'frameleaf_video_editor_color_unsupported';
