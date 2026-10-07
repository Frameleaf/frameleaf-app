// Loaded only inside the existing isolated image worker. No codec runs in the API process.
#include <node_api.h>
#include <libheif/heif.h>
#include <libheif/heif_items.h>
#include <ultrahdr_api.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {
void check(napi_status status) { if (status != napi_ok) throw std::runtime_error("INVALID_ARGUMENT"); }
void check(uhdr_error_info_t error) {
  if (error.error_code != UHDR_CODEC_OK) throw std::runtime_error("INVALID_GAIN_MAP");
}
void check(heif_error error) {
  switch (error.code) {
    case heif_error_Ok: return;
    case heif_error_Memory_allocation_error: throw std::runtime_error("RESOURCE_LIMIT");
    case heif_error_Unsupported_filetype:
    case heif_error_Unsupported_feature: throw std::runtime_error("UNSUPPORTED_IMAGE_CODEC");
    case heif_error_Invalid_input:
    case heif_error_Decoder_plugin_error: throw std::runtime_error("CORRUPT_IMAGE");
    default: throw std::runtime_error("HEIF_DECODE_UNAVAILABLE");
  }
}
using Decoder = std::unique_ptr<uhdr_codec_private_t, decltype(&uhdr_release_decoder)>;
using Encoder = std::unique_ptr<uhdr_codec_private_t, decltype(&uhdr_release_encoder)>;
using Context = std::unique_ptr<heif_context, decltype(&heif_context_free)>;
using Handle = std::unique_ptr<heif_image_handle, decltype(&heif_image_handle_release)>;
using Profile = std::unique_ptr<heif_color_profile_nclx, decltype(&heif_nclx_color_profile_free)>;

napi_value object(napi_env env) { napi_value value; check(napi_create_object(env, &value)); return value; }
void field(napi_env env, napi_value obj, const char* key, const char* text) {
  napi_value value; check(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value));
  check(napi_set_named_property(env, obj, key, value));
}
void field(napi_env env, napi_value obj, const char* key, double number) {
  napi_value value; check(napi_create_double(env, number, &value)); check(napi_set_named_property(env, obj, key, value));
}
void field(napi_env env, napi_value obj, const char* key, bool flag) {
  napi_value value; check(napi_get_boolean(env, flag, &value)); check(napi_set_named_property(env, obj, key, value));
}
double number(napi_env env, napi_value value) { double n; check(napi_get_value_double(env, value, &n)); return n; }
struct Input {
  void* data; size_t size; double maxPixels; double maxBytes;
  Input(napi_env env, napi_value* args) {
    bool buffer; check(napi_is_buffer(env, args[0], &buffer));
    if (!buffer) throw std::runtime_error("INVALID_ARGUMENT");
    check(napi_get_buffer_info(env, args[0], &data, &size));
    maxPixels = number(env, args[1]); maxBytes = number(env, args[2]);
    if (!(maxPixels > 0 && maxPixels <= 200000000 && maxBytes > 0 && maxBytes <= 1073741824)
        || size > maxBytes || size > 134217728) throw std::runtime_error("RESOURCE_LIMIT");
  }
  // Includes compressed input, decoded base/map, half-float codec storage and float working/output buffers.
  void dimensions(int w, int h, double mapPixels = 0) const {
    const double pixels = double(w) * h;
    if (w <= 0 || h <= 0 || pixels > maxPixels || mapPixels > maxPixels
        || size + pixels * 64 + mapPixels * 16 > maxBytes) throw std::runtime_error("RESOURCE_LIMIT");
  }
};

// Read only the bounded TIFF orientation entry; no EXIF content crosses the worker boundary.
int jpegOrientation(const Input& input) {
  const auto* bytes = static_cast<const uint8_t*>(input.data);
  if (input.size < 2 || bytes[0] != 255 || bytes[1] != 216) return 1;
  int orientation = 0;
  for (size_t offset = 2; offset + 4 <= input.size;) {
    if (bytes[offset++] != 255) throw std::runtime_error("INVALID_JPEG_METADATA");
    while (offset < input.size && bytes[offset] == 255) ++offset;
    if (offset >= input.size) throw std::runtime_error("INVALID_JPEG_METADATA");
    const unsigned marker = bytes[offset++];
    if (marker == 218 || marker == 217) break;
    if (marker == 1 || (marker >= 208 && marker <= 215)) continue;
    if (offset + 2 > input.size) throw std::runtime_error("INVALID_JPEG_METADATA");
    const size_t length = size_t(bytes[offset]) * 256 + bytes[offset + 1];
    if (length < 2 || length > input.size - offset) throw std::runtime_error("INVALID_JPEG_METADATA");
    const size_t end = offset + length;
    if (marker == 225 && length >= 16 && std::memcmp(bytes + offset + 2, "Exif\0\0", 6) == 0) {
      const auto* tiff = bytes + offset + 8;
      const size_t size = length - 8;
      const bool le = tiff[0] == 'I' && tiff[1] == 'I';
      if (!le && !(tiff[0] == 'M' && tiff[1] == 'M')) throw std::runtime_error("INVALID_JPEG_METADATA");
      auto u16 = [&](size_t at) -> unsigned {
        if (at > size || size - at < 2) throw std::runtime_error("INVALID_JPEG_METADATA");
        return le ? unsigned(tiff[at]) | unsigned(tiff[at + 1]) << 8 : unsigned(tiff[at]) << 8 | tiff[at + 1];
      };
      auto u32 = [&](size_t at) -> size_t {
        return le ? size_t(u16(at)) | size_t(u16(at + 2)) << 16 : size_t(u16(at)) << 16 | u16(at + 2);
      };
      if (u16(2) != 42) throw std::runtime_error("INVALID_JPEG_METADATA");
      const size_t directory = u32(4), count = u16(directory);
      if (directory > size || count > (size - directory - 2) / 12) throw std::runtime_error("INVALID_JPEG_METADATA");
      for (size_t i = 0; i < count; ++i) {
        const size_t entry = directory + 2 + i * 12;
        if (u16(entry) != 274) continue;
        if (u16(entry + 2) != 3 || u32(entry + 4) != 1) throw std::runtime_error("INVALID_JPEG_METADATA");
        const int value = int(u16(entry + 8));
        if (value < 1 || value > 8 || (orientation && orientation != value))
          throw std::runtime_error("INVALID_JPEG_METADATA");
        orientation = value;
      }
    }
    offset = end;
  }
  return orientation ? orientation : 1;
}

Decoder decoder(Input& input, bool linear = false, bool sdr = false) {
  Decoder dec(uhdr_create_decoder(), uhdr_release_decoder);
  if (!dec) throw std::runtime_error("RESOURCE_LIMIT");
  uhdr_compressed_image_t image{input.data, input.size, input.size,
    UHDR_CG_UNSPECIFIED, UHDR_CT_UNSPECIFIED, UHDR_CR_UNSPECIFIED};
  check(uhdr_dec_set_image(dec.get(), &image));
  if (linear || sdr) {
    check(uhdr_dec_set_out_img_format(dec.get(), sdr ? UHDR_IMG_FMT_32bppRGBA8888 : UHDR_IMG_FMT_64bppRGBAHalfFloat));
    check(uhdr_dec_set_out_color_transfer(dec.get(), sdr ? UHDR_CT_SRGB : UHDR_CT_LINEAR));
    if (sdr) check(uhdr_dec_set_out_max_display_boost(dec.get(), 1));
    const int orientation = jpegOrientation(input);
    if (orientation == 2 || orientation == 4 || orientation == 5 || orientation == 7)
      check(uhdr_add_effect_mirror(dec.get(), UHDR_MIRROR_HORIZONTAL));
    const int rotation = orientation == 3 || orientation == 4 ? 180
      : orientation == 5 || orientation == 8 ? 270 : orientation == 6 || orientation == 7 ? 90 : 0;
    if (rotation) check(uhdr_add_effect_rotate(dec.get(), rotation));
  }
  check(uhdr_dec_probe(dec.get()));
  input.dimensions(uhdr_dec_get_image_width(dec.get()), uhdr_dec_get_image_height(dec.get()),
    double(uhdr_dec_get_gainmap_width(dec.get())) * uhdr_dec_get_gainmap_height(dec.get()));
  auto* metadata = uhdr_dec_get_gainmap_metadata(dec.get());
  if (!metadata || !std::isfinite(metadata->hdr_capacity_max) || metadata->hdr_capacity_max < 1
      || !std::isfinite(metadata->hdr_capacity_min) || metadata->hdr_capacity_min < 1
      || metadata->hdr_capacity_max < metadata->hdr_capacity_min)
    throw std::runtime_error("INVALID_GAIN_MAP");
  for (int c = 0; c < 3; ++c) {
    if (!std::isfinite(metadata->max_content_boost[c]) || !std::isfinite(metadata->min_content_boost[c])
        || !std::isfinite(metadata->gamma[c]) || !std::isfinite(metadata->offset_hdr[c])
        || !std::isfinite(metadata->offset_sdr[c]) || metadata->offset_hdr[c] < 0
        || metadata->offset_sdr[c] < 0 || metadata->min_content_boost[c] <= 0
        || metadata->max_content_boost[c] < metadata->min_content_boost[c] || metadata->gamma[c] <= 0)
      throw std::runtime_error("INVALID_GAIN_MAP");
  }
  return dec;
}

float halfToFloat(uint16_t half) {
  const unsigned exponent = (half >> 10) & 31, fraction = half & 1023;
  float value = exponent == 0 ? std::ldexp(float(fraction), -24)
    : exponent == 31 ? INFINITY : std::ldexp(float(fraction + 1024), int(exponent) - 25);
  return half & 32768 ? -value : value;
}
uint16_t floatToHalf(float value) {
  if (value == 0) return 0;
  int exponent; const double mantissa = std::frexp(value, &exponent);
  if (exponent < -13) return uint16_t(std::nearbyint(std::ldexp(double(value), 24)));
  unsigned fraction = unsigned(std::nearbyint((mantissa * 2 - 1) * 1024));
  if (fraction == 1024) { fraction = 0; ++exponent; }
  if (exponent > 16) throw std::runtime_error("INVALID_LINEAR_PIXELS");
  return uint16_t(((exponent + 14) << 10) | fraction);
}

template<class F> napi_value invoke(napi_env env, napi_callback_info info, size_t count, F fn) {
  try {
    std::vector<napi_value> args(count);
    size_t received = count; check(napi_get_cb_info(env, info, &received, args.data(), nullptr, nullptr));
    if (received != count) throw std::runtime_error("INVALID_ARGUMENT");
    return fn(args.data());
  } catch (const std::bad_alloc&) { napi_throw_error(env, "RESOURCE_LIMIT", "HDR image exceeds memory budget"); }
    catch (const std::exception& error) { napi_throw_error(env, error.what(), error.what()); }
  return nullptr;
}

// The same ST 2084 and BT.2100 interpretation used by Studio's managed color pipeline.
// HLG uses the explicit nominal 1000-nit display / gamma 1.2 policy, not a guessed screen peak.
double pqNits(double signal) {
  const double e = std::pow(signal, 1 / (2523.0 / 4096 * 128));
  return 10000 * std::pow(std::max(e - 3424.0 / 4096, 0.0)
    / (2413.0 / 4096 * 32 - 2392.0 / 4096 * 32 * e), 1 / (2610.0 / 16384));
}
double hlgScene(double signal) {
  constexpr double a = 0.17883277, b = 1 - 4 * a;
  const double c = 0.5 - a * std::log(4 * a);
  return signal <= 0.5 ? signal * signal / 3 : (std::exp((signal - c) / a) + b) / 12;
}
bool supportedHdrProfile(const heif_color_profile_nclx* profile) {
  return profile && ((profile->transfer_characteristics == 16
    && (profile->color_primaries == 1 || profile->color_primaries == 9 || profile->color_primaries == 12))
    || (profile->transfer_characteristics == 18 && profile->color_primaries == 9));
}
bool heifHasToneMap(const Input& input, const heif_context* ctx) {
  bool adaptive = heif_has_compatible_brand(static_cast<const uint8_t*>(input.data), int(input.size), "tmap") == 1;
  const int count = heif_context_get_number_of_items(ctx);
  if (count < 0 || count > 4096) throw std::runtime_error("RESOURCE_LIMIT");
  std::vector<heif_item_id> ids(count);
  const int listed = heif_context_get_list_of_item_IDs(ctx, ids.data(), count);
  if (listed < 0 || listed > count) throw std::runtime_error("CORRUPT_IMAGE");
  for (int i = 0; i < listed; ++i)
    adaptive = adaptive || heif_item_get_item_type(ctx, ids[i]) == heif_fourcc('t','m','a','p');
  return adaptive;
}
napi_value decodeHeif(napi_env env, Input& input) {
  Context ctx(heif_context_alloc(), heif_context_free);
  if (!ctx) throw std::runtime_error("RESOURCE_LIMIT");
  check(heif_context_read_from_memory_without_copy(ctx.get(), input.data, input.size, nullptr));
  if (heifHasToneMap(input, ctx.get())) throw std::runtime_error("ISO_HEIF_GAIN_MAP_UNAVAILABLE");
  heif_image_handle* raw = nullptr; check(heif_context_get_primary_image_handle(ctx.get(), &raw));
  Handle primary(raw, heif_image_handle_release);
  input.dimensions(heif_image_handle_get_width(raw), heif_image_handle_get_height(raw));
  heif_color_profile_nclx* profileRaw = nullptr;
  check(heif_image_handle_get_nclx_color_profile(raw, &profileRaw));
  Profile profile(profileRaw, heif_nclx_color_profile_free);
  if (!supportedHdrProfile(profileRaw) || heif_image_handle_get_raw_color_profile_size(raw) != 0
      || heif_image_handle_is_premultiplied_alpha(raw))
    throw std::runtime_error("HDR_PROFILE_UNSUPPORTED");
  std::unique_ptr<heif_decoding_options, decltype(&heif_decoding_options_free)>
    options(heif_decoding_options_alloc(), heif_decoding_options_free);
  if (!options) throw std::runtime_error("RESOURCE_LIMIT");
  options->ignore_transformations = false;
  options->convert_hdr_to_8bit = false;
  options->strict_decoding = true;
  if (options->version < 8) throw std::runtime_error("HDR_CODEC_VERSION_UNSUPPORTED");
  // Explicit source profile prevents libheif's implicit conversion to sRGB.
  options->output_image_nclx_profile = profileRaw;
  heif_image* imageRaw = nullptr;
  check(heif_decode_image(raw, &imageRaw, heif_colorspace_RGB, heif_chroma_interleaved_RRGGBBAA_LE, options.get()));
  std::unique_ptr<heif_image, decltype(&heif_image_release)> image(imageRaw, heif_image_release);
  const int width = heif_image_get_width(imageRaw, heif_channel_interleaved);
  const int height = heif_image_get_height(imageRaw, heif_channel_interleaved);
  input.dimensions(width, height);
  const int depth = heif_image_get_bits_per_pixel_range(imageRaw, heif_channel_interleaved);
  int stride = 0; const uint8_t* source = heif_image_get_plane_readonly(imageRaw, heif_channel_interleaved, &stride);
  if (!source || depth < 10 || depth > 16 || stride < width * 8)
    throw std::runtime_error("HDR_RECONSTRUCTION_UNAVAILABLE");
  napi_value data; void* pixels;
  check(napi_create_buffer(env, size_t(width) * height * 16, &pixels, &data));
  auto* target = static_cast<float*>(pixels);
  const double maximum = (1u << depth) - 1;
  for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
    double rgb[3];
    const auto* pixel = source + size_t(y) * stride + size_t(x) * 8;
    for (int c = 0; c < 3; ++c) {
      const unsigned code = unsigned(pixel[c * 2]) | unsigned(pixel[c * 2 + 1]) << 8;
      if (code > maximum) throw std::runtime_error("INVALID_LINEAR_PIXELS");
      rgb[c] = profileRaw->transfer_characteristics == 16 ? pqNits(code / maximum) : hlgScene(code / maximum);
    }
    const double gain = profileRaw->transfer_characteristics == 18
      ? 1000 * std::pow(std::max(0.2627 * rgb[0] + 0.678 * rgb[1] + 0.0593 * rgb[2], 0.0), 0.2) : 1;
    const size_t i = (size_t(y) * width + x) * 4;
    for (int c = 0; c < 3; ++c) target[i + c] = float(rgb[c] * gain / 203);
    const unsigned alpha = unsigned(pixel[6]) | unsigned(pixel[7]) << 8;
    if (alpha > maximum) throw std::runtime_error("INVALID_LINEAR_PIXELS");
    target[i + 3] = float(alpha / maximum);
  }
  auto result = object(env); check(napi_set_named_property(env, result, "data", data));
  field(env, result, "width", double(width)); field(env, result, "height", double(height));
  field(env, result, "gamut", profileRaw->color_primaries == 9 ? 2.0 : profileRaw->color_primaries == 12 ? 1.0 : 0.0);
  field(env, result, "referenceWhite", 203.0);
  field(env, result, "renderingPolicy", "bt2100-reference-203-hlg-1000-v1");
  return result;
}

bool jpegIsoGainMap(const uhdr_mem_block_t* image) {
  if (!image || image->data_sz < 2) return false;
  const auto* bytes = static_cast<const uint8_t*>(image->data);
  if (bytes[0] != 255 || bytes[1] != 216) return false;
  constexpr char tag[] = "urn:iso:std:iso:ts:21496:-1";
  for (size_t offset = 2; offset + 4 <= image->data_sz;) {
    if (bytes[offset++] != 255) return false;
    while (offset < image->data_sz && bytes[offset] == 255) ++offset;
    if (offset >= image->data_sz) return false;
    const unsigned marker = bytes[offset++];
    if (marker == 218 || marker == 217) return false;
    if (marker == 1 || (marker >= 208 && marker <= 215)) continue;
    if (offset + 2 > image->data_sz) return false;
    const size_t length = size_t(bytes[offset]) * 256 + bytes[offset + 1];
    if (length < 2 || length > image->data_sz - offset) return false;
    if (marker == 226 && length >= sizeof(tag) + 2
        && std::memcmp(bytes + offset + 2, tag, sizeof(tag)) == 0) return true;
    offset += length;
  }
  return false;
}

void describeHeif(napi_env env, napi_value result, const Input& input, heif_context* ctx,
                  const heif_image_handle* primary) {
  const auto* bytes = static_cast<const uint8_t*>(input.data);
  field(env, result, "container", heif_has_compatible_brand(bytes, int(input.size), "avif") == 1
    || heif_has_compatible_brand(bytes, int(input.size), "avis") == 1 ? "avif" : "heif");
  heif_item_id id; check(heif_context_get_primary_image_ID(ctx, &id));
  const auto type = heif_item_get_item_type(ctx, id);
  if (type == heif_item_type_hvc1) field(env, result, "codec", "hevc");
  else if (type == heif_item_type_av01) field(env, result, "codec", "av1");
  // A derived grid is not a codec: leave unknown until its tile codecs are verified.
  field(env, result, "width", double(heif_image_handle_get_width(primary)));
  field(env, result, "height", double(heif_image_handle_get_height(primary)));
  const int depth = heif_image_handle_get_luma_bits_per_pixel(primary);
  if (depth > 0) field(env, result, "bitDepth", double(depth));
}

napi_value inspect(napi_env env, napi_callback_info info) {
  return invoke(env, info, 3, [&](napi_value* args) {
    Input input(env, args); auto result = object(env);
    field(env, result, "dynamicRange", "unknown"); field(env, result, "gainMap", "none");
    field(env, result, "referenceWhite", 203.0); field(env, result, "reconstructionAvailable", false);
    if (is_uhdr_image(input.data, int(input.size))) {
      auto dec = decoder(input);
      field(env, result, "dynamicRange", "hdr");
      const auto* bytes = static_cast<const uint8_t*>(input.data);
      const bool jpeg = input.size >= 2 && bytes[0] == 255 && bytes[1] == 216;
      if (jpeg) {
        field(env, result, "container", "jpeg"); field(env, result, "codec", "jpeg");
        field(env, result, "bitDepth", 8.0);
        field(env, result, "gainMap", jpegIsoGainMap(uhdr_dec_get_gainmap_image(dec.get())) ? "iso-21496" : "ultra-hdr");
      } else {
        Context ctx(heif_context_alloc(), heif_context_free);
        if (!ctx) throw std::runtime_error("RESOURCE_LIMIT");
        check(heif_context_read_from_memory_without_copy(ctx.get(), input.data, input.size, nullptr));
        heif_image_handle* raw; check(heif_context_get_primary_image_handle(ctx.get(), &raw));
        Handle primary(raw, heif_image_handle_release);
        describeHeif(env, result, input, ctx.get(), raw);
        field(env, result, "gainMap", "iso-21496");
      }
      field(env, result, "transfer", "adaptive");
      const auto* gain = uhdr_dec_get_gainmap_metadata(dec.get());
      field(env, result, "contentHeadroom", double(*std::max_element(gain->max_content_boost, gain->max_content_boost + 3)));
      const bool swapped = jpegOrientation(input) >= 5;
      field(env, result, "width", double(swapped ? uhdr_dec_get_image_height(dec.get()) : uhdr_dec_get_image_width(dec.get())));
      field(env, result, "height", double(swapped ? uhdr_dec_get_image_width(dec.get()) : uhdr_dec_get_image_height(dec.get())));
      field(env, result, "reconstructionAvailable", true); return result;
    }
    const auto type = heif_check_filetype(static_cast<uint8_t*>(input.data), int(input.size));
    if (type == heif_filetype_yes_supported || type == heif_filetype_yes_unsupported) {
      Context ctx(heif_context_alloc(), heif_context_free);
      if (!ctx) throw std::runtime_error("RESOURCE_LIMIT");
      check(heif_context_read_from_memory_without_copy(ctx.get(), input.data, input.size, nullptr));
      if (heifHasToneMap(input, ctx.get())) {
        field(env, result, "container", heif_has_compatible_brand(static_cast<const uint8_t*>(input.data),
          int(input.size), "avif") == 1 ? "avif" : "heif");
        field(env, result, "dynamicRange", "hdr"); field(env, result, "gainMap", "iso-21496");
        field(env, result, "fallbackReason", "iso-heif-gain-map-decoder-unavailable");
        return result;
      }
      heif_image_handle* raw; check(heif_context_get_primary_image_handle(ctx.get(), &raw));
      Handle primary(raw, heif_image_handle_release);
      input.dimensions(heif_image_handle_get_width(raw), heif_image_handle_get_height(raw));
      describeHeif(env, result, input, ctx.get(), raw);
      heif_color_profile_nclx* profileRaw = nullptr;
      if (heif_image_handle_get_nclx_color_profile(raw, &profileRaw).code == heif_error_Ok) {
        Profile profile(profileRaw, heif_nclx_color_profile_free);
        field(env, result, "colorPrimaries", double(profileRaw->color_primaries));
        const int transfer = profileRaw->transfer_characteristics;
        field(env, result, "transfer", double(transfer));
        if (transfer == 16 || transfer == 18) {
          field(env, result, "dynamicRange", "hdr");
          const bool supported = supportedHdrProfile(profileRaw)
            && heif_image_handle_get_raw_color_profile_size(raw) == 0
            && !heif_image_handle_is_premultiplied_alpha(raw);
          field(env, result, "reconstructionAvailable", supported);
          if (!supported) field(env, result, "fallbackReason", "hdr-profile-unsupported");
          field(env, result, "renderingPolicy", "bt2100-reference-203-hlg-1000-v1");
        }
        else if (transfer == 1 || transfer == 13) field(env, result, "dynamicRange", "sdr");
      }
      const int count = heif_image_handle_get_number_of_auxiliary_images(raw, 0);
      if (count < 0 || count > 64) throw std::runtime_error("RESOURCE_LIMIT");
      std::vector<heif_item_id> ids(count);
      heif_image_handle_get_list_of_auxiliary_image_IDs(raw, 0, ids.data(), count);
      for (auto id : ids) {
        heif_image_handle* auxiliaryRaw;
        check(heif_image_handle_get_auxiliary_image_handle(raw, id, &auxiliaryRaw));
        Handle auxiliary(auxiliaryRaw, heif_image_handle_release);
        const char* auxType = nullptr; check(heif_image_handle_get_auxiliary_type(auxiliaryRaw, &auxType));
        const std::string name = auxType ? auxType : "";
        heif_image_handle_release_auxiliary_type(auxiliaryRaw, &auxType);
        if (name == "urn:com:apple:photo:2020:aux:hdrgainmap") {
          field(env, result, "dynamicRange", "hdr"); field(env, result, "gainMap", "apple-legacy");
          field(env, result, "reconstructionAvailable", false);
          field(env, result, "fallbackReason", "apple-gain-map-interpretation-unqualified");
        }
      }
      return result;
    }
    const auto* bytes = static_cast<uint8_t*>(input.data);
    if (input.size >= 2 && bytes[0] == 255 && bytes[1] == 216) {
      const std::string_view contents(static_cast<const char*>(input.data), input.size);
      if (contents.find("hdrgm:Version") != std::string_view::npos
          || contents.find("urn:iso:std:iso:ts:21496") != std::string_view::npos) {
        field(env, result, "dynamicRange", "hdr"); field(env, result, "gainMap", "invalid-or-unsupported");
        field(env, result, "fallbackReason", "invalid-gain-map"); return result;
      }
      field(env, result, "container", "jpeg"); field(env, result, "dynamicRange", "sdr");
      field(env, result, "codec", "jpeg");
      field(env, result, "bitDepth", 8.0);
    }
    return result;
  });
}

napi_value decodeLinear(napi_env env, Input& input) {
    const auto type = heif_check_filetype(static_cast<uint8_t*>(input.data), int(input.size));
    if (!is_uhdr_image(input.data, int(input.size))
        && (type == heif_filetype_yes_supported || type == heif_filetype_yes_unsupported))
      return decodeHeif(env, input);
    auto dec = decoder(input, true);
    check(uhdr_decode(dec.get()));
    const auto* image = uhdr_get_decoded_image(dec.get());
    if (!image || image->fmt != UHDR_IMG_FMT_64bppRGBAHalfFloat || image->ct != UHDR_CT_LINEAR)
      throw std::runtime_error("HDR_RECONSTRUCTION_UNAVAILABLE");
    napi_value data; void* pixels;
    check(napi_create_buffer(env, size_t(image->w) * image->h * 16, &pixels, &data));
    auto* target = static_cast<float*>(pixels);
    const auto* source = static_cast<const uint16_t*>(image->planes[0]);
    for (unsigned y = 0; y < image->h; ++y) for (unsigned x = 0; x < image->w * 4; ++x) {
      const float value = halfToFloat(source[y * image->stride[0] * 4 + x]);
      if (!std::isfinite(value)) throw std::runtime_error("INVALID_LINEAR_PIXELS");
      target[size_t(y) * image->w * 4 + x] = value;
    }
    auto result = object(env); check(napi_set_named_property(env, result, "data", data));
    field(env, result, "width", double(image->w)); field(env, result, "height", double(image->h));
    field(env, result, "gamut", double(image->cg)); field(env, result, "referenceWhite", 203.0);
    return result;
}
napi_value decode(napi_env env, napi_callback_info info) {
  return invoke(env, info, 3, [&](napi_value* args) {
    Input input(env, args); return decodeLinear(env, input);
  });
}
napi_value decodePaired(napi_env env, napi_callback_info info) {
  return invoke(env, info, 3, [&](napi_value* args) {
    Input input(env, args);
    if (!is_uhdr_image(input.data, int(input.size))) throw std::runtime_error("ADAPTIVE_IMAGE_UNAVAILABLE");
    // The previous decoder is destroyed before this one starts. Include retained float RGB in its budget.
    auto result = decodeLinear(env, input);
    auto dec = decoder(input, false, true);
    if (input.size + double(uhdr_dec_get_image_width(dec.get())) * uhdr_dec_get_image_height(dec.get()) * 80
        + double(uhdr_dec_get_gainmap_width(dec.get())) * uhdr_dec_get_gainmap_height(dec.get()) * 16 > input.maxBytes)
      throw std::runtime_error("RESOURCE_LIMIT");
    check(uhdr_decode(dec.get()));
    const auto* image = uhdr_get_decoded_image(dec.get());
    // The pinned decoder copies the JPEG base with an unspecified transfer tag; this output mode is sRGB.
    if (!image || image->fmt != UHDR_IMG_FMT_32bppRGBA8888
        || (image->ct != UHDR_CT_SRGB && image->ct != UHDR_CT_UNSPECIFIED)
        || image->cg < UHDR_CG_BT_709 || image->cg > UHDR_CG_BT_2100)
      throw std::runtime_error("SDR_BASELINE_UNAVAILABLE");
    napi_value sdr; void* pixels;
    check(napi_create_buffer(env, size_t(image->w) * image->h * 4, &pixels, &sdr));
    const auto* source = static_cast<const uint8_t*>(image->planes[0]);
    for (unsigned y = 0; y < image->h; ++y)
      std::memcpy(static_cast<uint8_t*>(pixels) + size_t(y) * image->w * 4,
        source + size_t(y) * image->stride[0] * 4, size_t(image->w) * 4);
    check(napi_set_named_property(env, result, "sdr", sdr));
    field(env, result, "sdrGamut", double(image->cg));
    return result;
  });
}

napi_value encodeLinear(napi_env env, napi_value* args, bool paired) {
    // RGBA Float32 linear pixels, source gamut, relative to 203 cd/m². Alpha cannot be discarded silently.
    bool buffer; check(napi_is_buffer(env, args[0], &buffer)); if (!buffer) throw std::runtime_error("INVALID_ARGUMENT");
    void* bytes; size_t size; check(napi_get_buffer_info(env, args[0], &bytes, &size));
    double wd = number(env, args[1]), hd = number(env, args[2]), gd = number(env, args[3]);
    const double maxPixels = number(env, args[4]), maxBytes = number(env, args[5]);
    if (!std::isfinite(wd) || !std::isfinite(hd) || !std::isfinite(gd)
        || !std::isfinite(maxPixels) || !std::isfinite(maxBytes) || maxPixels < 1
        || reinterpret_cast<uintptr_t>(bytes) % alignof(float) != 0
        || wd < 1 || hd < 1 || wd != std::floor(wd) || hd != std::floor(hd) || wd * hd > maxPixels
        || maxPixels > 200000000 || maxBytes > 1073741824 || maxBytes <= 0
        || wd * hd * (paired ? 68 : 64) > maxBytes || size != wd * hd * 16 || gd < 0 || gd > 2 || gd != std::floor(gd))
      throw std::runtime_error("RESOURCE_LIMIT");
    const auto w = unsigned(wd), h = unsigned(hd);
    std::vector<uint16_t> pixels(size / 4);
    const auto* source = static_cast<const float*>(bytes);
    for (size_t i = 0; i < pixels.size(); ++i) {
      if (!std::isfinite(source[i]) || source[i] < 0 || source[i] > 10000.0 / 203)
        throw std::runtime_error("INVALID_LINEAR_PIXELS");
      if (i % 4 == 3 && source[i] != 1) throw std::runtime_error("HDR_JPEG_ALPHA_UNSUPPORTED");
      pixels[i] = floatToHalf(source[i]);
    }
    Encoder enc(uhdr_create_encoder(), uhdr_release_encoder);
    if (!enc) throw std::runtime_error("RESOURCE_LIMIT");
    uhdr_raw_image_t image{UHDR_IMG_FMT_64bppRGBAHalfFloat, uhdr_color_gamut_t(int(gd)), UHDR_CT_LINEAR,
      UHDR_CR_FULL_RANGE, w, h, {pixels.data(), nullptr, nullptr}, {w, 0, 0}};
    check(uhdr_enc_set_raw_image(enc.get(), &image, UHDR_HDR_IMG));
    if (paired) {
      check(napi_is_buffer(env, args[6], &buffer));
      if (!buffer) throw std::runtime_error("INVALID_SDR_BASELINE");
      void* sdr; size_t sdrSize; check(napi_get_buffer_info(env, args[6], &sdr, &sdrSize));
      const double sdrGamut = number(env, args[7]);
      if (sdrSize != wd * hd * 4 || !std::isfinite(sdrGamut) || sdrGamut < 0 || sdrGamut > 2
          || sdrGamut != std::floor(sdrGamut)) throw std::runtime_error("INVALID_SDR_BASELINE");
      for (size_t i = 3; i < sdrSize; i += 4)
        if (static_cast<const uint8_t*>(sdr)[i] != 255) throw std::runtime_error("HDR_JPEG_ALPHA_UNSUPPORTED");
      uhdr_raw_image_t base{UHDR_IMG_FMT_32bppRGBA8888, uhdr_color_gamut_t(int(sdrGamut)), UHDR_CT_SRGB,
        UHDR_CR_FULL_RANGE, w, h, {sdr, nullptr, nullptr}, {w, 0, 0}};
      check(uhdr_enc_set_raw_image(enc.get(), &base, UHDR_SDR_IMG));
    }
    check(uhdr_enc_set_quality(enc.get(), 95, UHDR_BASE_IMG));
    check(uhdr_enc_set_quality(enc.get(), 95, UHDR_GAIN_MAP_IMG));
    check(uhdr_enc_set_using_multi_channel_gainmap(enc.get(), 1));
    check(uhdr_enc_set_gainmap_scale_factor(enc.get(), 1));
    check(uhdr_encode(enc.get()));
    const auto* output = uhdr_get_encoded_stream(enc.get());
    if (!output || output->data_sz > maxBytes) throw std::runtime_error("RESOURCE_LIMIT");
    napi_value result; check(napi_create_buffer_copy(env, output->data_sz, output->data, nullptr, &result));
    return result;
}
napi_value encode(napi_env env, napi_callback_info info) {
  return invoke(env, info, 6, [&](napi_value* args) { return encodeLinear(env, args, false); });
}
napi_value encodePaired(napi_env env, napi_callback_info info) {
  return invoke(env, info, 8, [&](napi_value* args) { return encodeLinear(env, args, true); });
}
napi_value capabilities(napi_env env, napi_callback_info info) {
  return invoke(env, info, 0, [&](napi_value*) {
  napi_value result = object(env);
  field(env, result, "libheif", heif_get_version());
  field(env, result, "libultrahdr", UHDR_LIB_VERSION_STR);
  field(env, result, "heicDecoder", heif_have_decoder_for_format(heif_compression_HEVC) != 0);
  field(env, result, "avifDecoder", heif_have_decoder_for_format(heif_compression_AV1) != 0);
  return result;
  });
}
napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor functions[] = {
    {"capabilities", nullptr, capabilities, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspect", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"decode", nullptr, decode, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"encode", nullptr, encode, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"decodePaired", nullptr, decodePaired, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"encodePaired", nullptr, encodePaired, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  check(napi_define_properties(env, exports, sizeof(functions) / sizeof(functions[0]), functions)); return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
