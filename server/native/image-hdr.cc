// Loaded only inside the existing isolated image worker. No codec runs in the API process.
#include <node_api.h>
#include <libheif/heif.h>
#include <libheif/heif_items.h>
#include <libheif/heif_security.h>
#include <ultrahdr_api.h>
#include <expat.h>
#include <lcms2.h>
#include <libheif/heif_properties.h>
#include <optional>
#include <type_traits>
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
  if (error.error_code == UHDR_CODEC_MEM_ERROR) throw std::runtime_error("RESOURCE_LIMIT");
  if (error.error_code != UHDR_CODEC_OK) throw std::runtime_error("INVALID_GAIN_MAP");
}
void check(heif_error error) {
  if (error.subcode == heif_suberror_Security_limit_exceeded) throw std::runtime_error("RESOURCE_LIMIT");
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
    if (!(maxPixels > 0 && maxPixels <= 200000000 && maxBytes > 0 && maxBytes <= 8589934592)
        || size > maxBytes || size > 134217728) throw std::runtime_error("RESOURCE_LIMIT");
  }
  // Include row padding in either orientation, compressed copies and simultaneous working surfaces.
  void dimensions(int w, int h, int mapWidth = 0, int mapHeight = 0, int workingBytesPerPixel = 64) const {
    const auto paddedPixels = [](int width, int height) {
      return std::max(std::ceil(double(width) / 64) * 64 * height,
                      std::ceil(double(height) / 64) * 64 * width);
    };
    if (w <= 0 || h <= 0 || mapWidth < 0 || mapHeight < 0
        || (mapWidth == 0) != (mapHeight == 0) || double(w) * h > maxPixels
        || double(mapWidth) * mapHeight > maxPixels
        || double(size) * 2 + paddedPixels(w, h) * workingBytesPerPixel + paddedPixels(mapWidth, mapHeight) * 16 > maxBytes)
      throw std::runtime_error("RESOURCE_LIMIT");
  }
  Context readHeif() const {
    if (double(size) * 2 >= maxBytes) throw std::runtime_error("RESOURCE_LIMIT");
    Context ctx(heif_context_alloc(), heif_context_free);
    if (!ctx) throw std::runtime_error("RESOURCE_LIMIT");
    auto* limits = heif_context_get_security_limits(ctx.get());
    if (!limits || limits->version < 2) throw std::runtime_error("HDR_CODEC_VERSION_UNSUPPORTED");
    const auto available = uint64_t(maxBytes - double(size) * 2);
    if (!available) throw std::runtime_error("RESOURCE_LIMIT");
    limits->max_image_size_pixels = std::max(uint64_t(1), uint64_t(maxPixels));
    limits->max_color_profile_size = std::min(limits->max_color_profile_size, uint32_t(std::min(available, uint64_t(1048576))));
    limits->max_memory_block_size = std::min(limits->max_memory_block_size, available);
    limits->max_total_memory = std::min(limits->max_total_memory, available);
    check(heif_context_read_from_memory_without_copy(ctx.get(), data, size, nullptr));
    return ctx;
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

Decoder preparedDecoder(Input& input) {
  Decoder dec(uhdr_create_decoder(), uhdr_release_decoder);
  if (!dec) throw std::runtime_error("RESOURCE_LIMIT");
#ifdef UHDR_FRAMELEAF_RESOURCE_LIMITS_API
  if (double(input.size) * 2 + 1 > input.maxBytes) throw std::runtime_error("RESOURCE_LIMIT");
  check(uhdr_dec_set_resource_limits(dec.get(), std::max(uint64_t(1), uint64_t(input.maxPixels)),
    uint64_t(input.maxBytes - double(input.size) * 2)));
#endif
  uhdr_compressed_image_t image{input.data, input.size, input.size,
    UHDR_CG_UNSPECIFIED, UHDR_CT_UNSPECIFIED, UHDR_CR_UNSPECIFIED};
  check(uhdr_dec_set_image(dec.get(), &image));
  return dec;
}
bool hasGainMap(Input& input) {
  auto dec = preparedDecoder(input);
  const auto status = uhdr_dec_probe(dec.get());
  if (status.error_code == UHDR_CODEC_MEM_ERROR) check(status);
  return status.error_code == UHDR_CODEC_OK;
}
Decoder decoder(Input& input, bool linear = false, bool sdr = false) {
  auto dec = preparedDecoder(input);
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
    uhdr_dec_get_gainmap_width(dec.get()), uhdr_dec_get_gainmap_height(dec.get()));
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
// Apple legacy metadata and reconstruction are distinct from ISO/Ultra HDR gain maps.
// Formula: https://developer.apple.com/documentation/appkit/applying-apple-hdr-effect-to-your-photos
struct TiffView {
  const uint8_t* bytes; size_t size; bool little;
  void range(size_t at, size_t length) const {
    if (at > size || length > size - at) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  }
  unsigned u16(size_t at) const {
    range(at, 2);
    return little ? unsigned(bytes[at]) | unsigned(bytes[at + 1]) << 8
      : unsigned(bytes[at]) << 8 | bytes[at + 1];
  }
  uint32_t u32(size_t at) const {
    return little ? uint32_t(u16(at)) | uint32_t(u16(at + 2)) << 16
      : uint32_t(u16(at)) << 16 | u16(at + 2);
  }
  std::optional<size_t> entry(size_t directory, unsigned tag) const {
    const auto count = u16(directory);
    if (count > 4096) throw std::runtime_error("RESOURCE_LIMIT");
    range(directory + 2, size_t(count) * 12);
    std::optional<size_t> found;
    for (unsigned i = 0; i < count; ++i) {
      const size_t at = directory + 2 + i * 12;
      if (u16(at) == tag) {
        if (found) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
        found = at;
      }
    }
    return found;
  }
  float scalar(size_t at) const {
    if (u32(at + 4) != 1) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
    const auto format = u16(at + 2);
    float value;
    if (format == 11) { const auto bits = u32(at + 8); std::memcpy(&value, &bits, 4); }
    else if (format == 10 || format == 5) {
      const size_t offset = u32(at + 8);
      const double numerator = format == 10 ? double(int32_t(u32(offset))) : double(u32(offset));
      const double denominator = format == 10 ? double(int32_t(u32(offset + 4))) : double(u32(offset + 4));
      if (denominator == 0) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
      value = float(numerator / denominator);
    } else throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
    if (!std::isfinite(value)) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
    return value;
  }
};
std::vector<uint8_t> heifMetadata(const Input& input, const heif_image_handle* handle, heif_item_id id) {
  const size_t size = heif_image_handle_get_metadata_size(handle, id);
  if (size == 0 || size > 1048576 || size > input.size || input.size * 2 > input.maxBytes)
    throw std::runtime_error("RESOURCE_LIMIT");
  std::vector<uint8_t> data(size); check(heif_image_handle_get_metadata(handle, id, data.data())); return data;
}
std::vector<heif_item_id> metadataIds(const heif_image_handle* handle, const char* type) {
  const int count = heif_image_handle_get_number_of_metadata_blocks(handle, type);
  if (count < 0 || count > 16) throw std::runtime_error("RESOURCE_LIMIT");
  std::vector<heif_item_id> ids(count);
  if (heif_image_handle_get_list_of_metadata_block_IDs(handle, type, ids.data(), count) != count)
    throw std::runtime_error("CORRUPT_IMAGE");
  return ids;
}
double appleHeadroom(const Input& input, const heif_image_handle* primary) {
  const auto ids = metadataIds(primary, "Exif");
  if (ids.size() != 1) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  const auto data = heifMetadata(input, primary, ids[0]);
  TiffView container{data.data(), data.size(), false};
  const size_t offset = size_t(container.u32(0)) + 4;
  container.range(offset, 8);
  TiffView tiff{data.data() + offset, data.size() - offset, data[offset] == 'I' && data[offset + 1] == 'I'};
  if ((!tiff.little && !(tiff.bytes[0] == 'M' && tiff.bytes[1] == 'M')) || tiff.u16(2) != 42)
    throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  const auto exif = tiff.entry(tiff.u32(4), 0x8769);
  if (!exif || tiff.u16(*exif + 2) != 4 || tiff.u32(*exif + 4) != 1)
    throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  const auto maker = tiff.entry(tiff.u32(*exif + 8), 0x927c);
  if (!maker || tiff.u16(*maker + 2) != 7) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  const size_t length = tiff.u32(*maker + 4), begin = tiff.u32(*maker + 8);
  tiff.range(begin, length);
  if (length < 16 || std::memcmp(tiff.bytes + begin, "Apple iOS\0", 10) != 0)
    throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  TiffView apple{tiff.bytes + begin, length, tiff.bytes[begin + 12] == 'I' && tiff.bytes[begin + 13] == 'I'};
  if (!apple.little && !(apple.bytes[12] == 'M' && apple.bytes[13] == 'M'))
    throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  const auto entry33 = apple.entry(14, 33), entry48 = apple.entry(14, 48);
  if (!entry33 || !entry48) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  const float maker33 = apple.scalar(*entry33), maker48 = apple.scalar(*entry48);
  const float stops = maker33 < 1 ? (maker48 <= 0.01f ? -20 * maker48 + 1.8f : -0.101f * maker48 + 1.601f)
    : (maker48 <= 0.01f ? -70 * maker48 + 3.0f : -0.303f * maker48 + 2.303f);
  const double headroom = std::pow(2.0, std::max(stops, 0.0f));
  if (!std::isfinite(headroom) || headroom > 10000 / 203.0) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  return headroom;
}
struct AppleXmp {
  XML_Parser parser; int depth = 0, capture = 0, count = 0; bool invalid = false; std::string value; bool unsupported = false;
  void stop() { invalid = true; XML_StopParser(parser, XML_FALSE); }
  static bool version(const XML_Char* name) { return std::strcmp(name, "http://ns.apple.com/HDRGainMap/1.0/|HDRGainMapVersion") == 0; }
  static void start(void* user, const XML_Char* name, const XML_Char** attributes) {
    auto& x = *static_cast<AppleXmp*>(user);
    if (++x.depth > 32 || x.capture) { x.stop(); return; }
    if (std::strncmp(name, "http://ns.apple.com/HDRGainMap/1.0/|", sizeof("http://ns.apple.com/HDRGainMap/1.0/|") - 1) == 0 && !version(name)) x.unsupported = true;
    if (version(name)) { if (++x.count != 1) { x.stop(); return; } x.capture = x.depth; }
    for (size_t i = 0; attributes[i]; i += 2) {
      if (std::strncmp(attributes[i], "http://ns.apple.com/HDRGainMap/1.0/|", sizeof("http://ns.apple.com/HDRGainMap/1.0/|") - 1) == 0 && !version(attributes[i])) x.unsupported = true;
      if (!version(attributes[i])) continue;
      if (++x.count != 1 || std::strlen(attributes[i + 1]) > 32) { x.stop(); return; }
      x.value = attributes[i + 1];
    }
  }
  static void end(void* user, const XML_Char*) {
    auto& x = *static_cast<AppleXmp*>(user); if (x.capture == x.depth) x.capture = 0; --x.depth;
  }
  static void text(void* user, const XML_Char* data, int length) {
    auto& x = *static_cast<AppleXmp*>(user);
    if (x.capture) { if (x.value.size() + size_t(length) > 32) x.stop(); else x.value.append(data, size_t(length)); }
  }
  static void doctype(void* user, const XML_Char*, const XML_Char*, const XML_Char*, int) { static_cast<AppleXmp*>(user)->stop(); }
};
void validateAppleVersion(const Input& input, const heif_image_handle* auxiliary) {
  int found = 0;
  for (auto id : metadataIds(auxiliary, nullptr)) {
    const char* type = heif_image_handle_get_metadata_content_type(auxiliary, id);
    if (!type || std::strcmp(type, "application/rdf+xml") != 0) continue;
    const auto data = heifMetadata(input, auxiliary, id);
    std::unique_ptr<std::remove_pointer_t<XML_Parser>, decltype(&XML_ParserFree)> parser(XML_ParserCreateNS(nullptr, '|'), XML_ParserFree);
    if (!parser) throw std::runtime_error("RESOURCE_LIMIT");
    AppleXmp x{parser.get(), 0, 0, 0, false, {}}; x.value.reserve(32);
    XML_SetUserData(parser.get(), &x); XML_SetElementHandler(parser.get(), AppleXmp::start, AppleXmp::end);
    XML_SetCharacterDataHandler(parser.get(), AppleXmp::text); XML_SetStartDoctypeDeclHandler(parser.get(), AppleXmp::doctype);
    XML_SetParamEntityParsing(parser.get(), XML_PARAM_ENTITY_PARSING_NEVER);
    const auto status = XML_Parse(parser.get(), reinterpret_cast<const char*>(data.data()), int(data.size()), XML_TRUE);
    if (XML_GetErrorCode(parser.get()) == XML_ERROR_NO_MEMORY) throw std::runtime_error("RESOURCE_LIMIT");
    if (status == XML_STATUS_ERROR || x.invalid) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
    if (x.unsupported) throw std::runtime_error("APPLE_GAIN_MAP_VERSION_UNSUPPORTED");
    if (x.count) {
      const auto begin = x.value.find_first_not_of(" \t\r\n"), end = x.value.find_last_not_of(" \t\r\n");
      if (begin == std::string::npos || x.value.substr(begin, end - begin + 1) != "65536" || ++found != 1)
        throw std::runtime_error("APPLE_GAIN_MAP_VERSION_UNSUPPORTED");
    }
  }
  if (found != 1) throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
}
Handle appleAuxiliary(const heif_image_handle* primary) {
  const int count = heif_image_handle_get_number_of_auxiliary_images(primary, 0);
  if (count < 0 || count > 64) throw std::runtime_error("RESOURCE_LIMIT");
  std::vector<heif_item_id> ids(count);
  if (heif_image_handle_get_list_of_auxiliary_image_IDs(primary, 0, ids.data(), count) != count)
    throw std::runtime_error("CORRUPT_IMAGE");
  Handle found(nullptr, heif_image_handle_release);
  for (auto id : ids) {
    heif_image_handle* raw = nullptr; check(heif_image_handle_get_auxiliary_image_handle(primary, id, &raw));
    Handle auxiliary(raw, heif_image_handle_release);
    const char* type = nullptr; check(heif_image_handle_get_auxiliary_type(raw, &type));
    const bool apple = type && std::strcmp(type, "urn:com:apple:photo:2020:aux:hdrgainmap") == 0;
    heif_image_handle_release_auxiliary_type(raw, &type);
    if (apple) { if (found) throw std::runtime_error("INVALID_APPLE_GAIN_MAP"); found = std::move(auxiliary); }
  }
  return found;
}
using ColorProfile = std::unique_ptr<void, decltype(&cmsCloseProfile)>;
ColorProfile rgbProfile(int primaries, int transfer) {
  cmsCIExyY white{0.3127, 0.3290, 1};
  cmsCIExyYTRIPLE colors = primaries == 9 ? cmsCIExyYTRIPLE{{0.708,0.292,1},{0.170,0.797,1},{0.131,0.046,1}}
    : primaries == 12 ? cmsCIExyYTRIPLE{{0.680,0.320,1},{0.265,0.690,1},{0.150,0.060,1}}
    : cmsCIExyYTRIPLE{{0.640,0.330,1},{0.300,0.600,1},{0.150,0.060,1}};
  const double parameters[] = {transfer == 1 ? 1 / 0.45 : 2.4, transfer == 1 ? 1 / 1.099 : 1 / 1.055,
    transfer == 1 ? 0.099 / 1.099 : 0.055 / 1.055, transfer == 1 ? 1 / 4.5 : 1 / 12.92, transfer == 1 ? 0.081 : 0.04045};
  std::unique_ptr<cmsToneCurve, decltype(&cmsFreeToneCurve)> curve(transfer == 0 ? cmsBuildGamma(nullptr, 1)
    : cmsBuildParametricToneCurve(nullptr, 4, parameters), cmsFreeToneCurve);
  if (!curve) throw std::runtime_error("RESOURCE_LIMIT");
  cmsToneCurve* curves[] = {curve.get(), curve.get(), curve.get()};
  ColorProfile profile(cmsCreateRGBProfile(&white, &colors, curves), cmsCloseProfile);
  if (!profile) throw std::runtime_error("HDR_PROFILE_UNSUPPORTED");
  return profile;
}
ColorProfile appleColorProfile(const Input& input, const heif_image_handle* primary) {
  const size_t size = heif_image_handle_get_raw_color_profile_size(primary);
  if (size) {
    if (size > 1048576 || size > input.size) throw std::runtime_error("RESOURCE_LIMIT");
    std::vector<uint8_t> icc(size); check(heif_image_handle_get_raw_color_profile(primary, icc.data()));
    ColorProfile profile(cmsOpenProfileFromMem(icc.data(), cmsUInt32Number(size)), cmsCloseProfile);
    if (!profile || cmsGetColorSpace(profile.get()) != cmsSigRgbData || !cmsIsMatrixShaper(profile.get())) throw std::runtime_error("HDR_PROFILE_UNSUPPORTED");
    return profile;
  }
  heif_color_profile_nclx* raw = nullptr; check(heif_image_handle_get_nclx_color_profile(primary, &raw));
  Profile profile(raw, heif_nclx_color_profile_free);
  if ((raw->color_primaries != 1 && raw->color_primaries != 9 && raw->color_primaries != 12)
      || (raw->transfer_characteristics != 1 && raw->transfer_characteristics != 13))
    throw std::runtime_error("HDR_PROFILE_UNSUPPORTED");
  return rgbProfile(raw->color_primaries, raw->transfer_characteristics);
}

void validateAppleLayout(const Input& input, const heif_context* ctx, const heif_image_handle* primary, const heif_image_handle* auxiliary) {
  // Apple may associate the same primary transform properties with the auxiliary.
  // Independently authored map geometry is not part of this rendering policy.
  const auto primaryId = heif_image_handle_get_item_id(primary), mapId = heif_image_handle_get_item_id(auxiliary);
  const int mapCount = heif_item_get_transformation_properties(ctx, mapId, nullptr, 0);
  const int primaryCount = heif_item_get_transformation_properties(ctx, primaryId, nullptr, 0);
  if (mapCount < 0 || primaryCount < 0 || mapCount > 16 || primaryCount > 16)
    throw std::runtime_error("RESOURCE_LIMIT");
  if (mapCount) {
    std::vector<heif_property_id> mapProperties(mapCount), primaryProperties(primaryCount);
    if (heif_item_get_transformation_properties(ctx, mapId, mapProperties.data(), mapCount) != mapCount
        || heif_item_get_transformation_properties(ctx, primaryId, primaryProperties.data(), primaryCount) != primaryCount
        || mapCount != primaryCount) throw std::runtime_error("APPLE_GAIN_MAP_GEOMETRY_UNSUPPORTED");
    for (int i = 0; i < mapCount; ++i) {
      const auto type = heif_item_get_property_type(ctx, mapId, mapProperties[i]);
      if (type != heif_item_get_property_type(ctx, primaryId, primaryProperties[i]))
        throw std::runtime_error("APPLE_GAIN_MAP_GEOMETRY_UNSUPPORTED");
      if (type == heif_item_property_type_transform_rotation) {
        if (heif_item_get_property_transform_rotation_ccw(ctx, mapId, mapProperties[i])
            != heif_item_get_property_transform_rotation_ccw(ctx, primaryId, primaryProperties[i]))
          throw std::runtime_error("APPLE_GAIN_MAP_GEOMETRY_UNSUPPORTED");
      } else if (type == heif_item_property_type_transform_mirror) {
        if (heif_item_get_property_transform_mirror(ctx, mapId, mapProperties[i])
            != heif_item_get_property_transform_mirror(ctx, primaryId, primaryProperties[i]))
          throw std::runtime_error("APPLE_GAIN_MAP_GEOMETRY_UNSUPPORTED");
      } else throw std::runtime_error("APPLE_GAIN_MAP_GEOMETRY_UNSUPPORTED");
    }
  }
  const int width = heif_image_handle_get_ispe_width(primary), height = heif_image_handle_get_ispe_height(primary);
  const int mapWidth = heif_image_handle_get_ispe_width(auxiliary), mapHeight = heif_image_handle_get_ispe_height(auxiliary);
  input.dimensions(width, height, mapWidth, mapHeight);
  heif_colorspace colorspace; heif_chroma chroma;
  check(heif_image_handle_get_preferred_decoding_colorspace(auxiliary, &colorspace, &chroma));
  if (colorspace != heif_colorspace_monochrome || chroma != heif_chroma_monochrome)
    throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  if (heif_image_handle_get_luma_bits_per_pixel(primary) != 8 || heif_image_handle_is_premultiplied_alpha(primary)
      || heif_image_handle_get_luma_bits_per_pixel(auxiliary) != 8
      || mapWidth != (width + 3) / 4 || mapHeight != (height + 3) / 4)
    throw std::runtime_error("APPLE_GAIN_MAP_GEOMETRY_UNSUPPORTED");
}
struct AppleTransform { heif_item_property_type type; int width, height, value = 0, left = 0, top = 0; };
std::vector<AppleTransform> appleTransforms(const heif_context* ctx, heif_item_id id, int& width, int& height) {
  const int count = heif_item_get_transformation_properties(ctx, id, nullptr, 0);
  if (count < 0 || count > 16) throw std::runtime_error("RESOURCE_LIMIT");
  std::vector<heif_property_id> ids(count); std::vector<AppleTransform> result;
  if (heif_item_get_transformation_properties(ctx, id, ids.data(), count) != count)
    throw std::runtime_error("CORRUPT_IMAGE");
  for (auto property : ids) {
    AppleTransform transform{heif_item_get_property_type(ctx, id, property), width, height};
    if (transform.type == heif_item_property_type_transform_rotation) {
      transform.value = heif_item_get_property_transform_rotation_ccw(ctx, id, property);
      if (transform.value < 0) throw std::runtime_error("CORRUPT_IMAGE");
      if (transform.value == 90 || transform.value == 270) std::swap(width, height);
    } else if (transform.type == heif_item_property_type_transform_mirror) {
      transform.value = heif_item_get_property_transform_mirror(ctx, id, property);
      if (transform.value < 0) throw std::runtime_error("CORRUPT_IMAGE");
    } else if (transform.type == heif_item_property_type_transform_crop) {
      int right, bottom;
      heif_item_get_property_transform_crop_borders(ctx, id, property, width, height, &transform.left, &transform.top, &right, &bottom);
      if (transform.left < 0 || transform.top < 0 || right < 0 || bottom < 0
          || transform.left >= width - right || transform.top >= height - bottom)
        throw std::runtime_error("CORRUPT_IMAGE");
      width -= transform.left + right; height -= transform.top + bottom;
    } else throw std::runtime_error("APPLE_GAIN_MAP_GEOMETRY_UNSUPPORTED");
    result.push_back(transform);
  }
  return result;
}
void inverseAppleGeometry(const std::vector<AppleTransform>& transforms, int& x, int& y) {
  for (auto i = transforms.rbegin(); i != transforms.rend(); ++i) {
    if (i->type == heif_item_property_type_transform_crop) { x += i->left; y += i->top; }
    else if (i->type == heif_item_property_type_transform_mirror) {
      if (i->value == heif_transform_mirror_direction_horizontal) x = i->width - 1 - x;
      else y = i->height - 1 - y;
    } else {
      const int oldX = x;
      switch (i->value) {
        case 0: break;
        case 90: x = i->width - 1 - y; y = oldX; break;
        case 180: x = i->width - 1 - x; y = i->height - 1 - y; break;
        case 270: x = y; y = i->height - 1 - oldX; break;
        default: throw std::runtime_error("CORRUPT_IMAGE");
      }
    }
  }
}
napi_value decodeApple(napi_env env, Input& input, heif_context* ctx, heif_image_handle* primary,
                       heif_image_handle* auxiliary, bool paired) {
  validateAppleVersion(input, auxiliary); const double headroom = appleHeadroom(input, primary);
  const int rawWidth = heif_image_handle_get_ispe_width(primary), rawHeight = heif_image_handle_get_ispe_height(primary);
  const int mapWidth = heif_image_handle_get_ispe_width(auxiliary), mapHeight = heif_image_handle_get_ispe_height(auxiliary);
  validateAppleLayout(input, ctx, primary, auxiliary);
  auto profile = appleColorProfile(input, primary); auto linearProfile = rgbProfile(9, 0);
  using ColorTransform = std::unique_ptr<void, decltype(&cmsDeleteTransform)>;
  ColorTransform linear(cmsCreateTransform(profile.get(), TYPE_RGBA_8, linearProfile.get(), TYPE_RGBA_FLT,
    INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_COPY_ALPHA | cmsFLAGS_NOOPTIMIZE), cmsDeleteTransform);
  if (!linear) throw std::runtime_error("HDR_PROFILE_UNSUPPORTED");
  std::unique_ptr<heif_decoding_options, decltype(&heif_decoding_options_free)> options(heif_decoding_options_alloc(), heif_decoding_options_free);
  if (!options) throw std::runtime_error("RESOURCE_LIMIT");
  options->ignore_transformations = true; options->convert_hdr_to_8bit = false; options->strict_decoding = true;
  heif_color_profile_nclx* nclxRaw = nullptr;
  Profile nclx(nullptr, heif_nclx_color_profile_free);
  if (heif_image_handle_get_nclx_color_profile(primary, &nclxRaw).code == heif_error_Ok) {
    nclx.reset(nclxRaw); options->output_image_nclx_profile = nclxRaw;
  }
  heif_image* baseRaw = nullptr; check(heif_decode_image(primary, &baseRaw, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, options.get()));
  std::unique_ptr<heif_image, decltype(&heif_image_release)> base(baseRaw, heif_image_release);
  if (heif_image_get_width(baseRaw, heif_channel_interleaved) != rawWidth
      || heif_image_get_height(baseRaw, heif_channel_interleaved) != rawHeight
      || heif_image_get_bits_per_pixel_range(baseRaw, heif_channel_interleaved) != 8)
    throw std::runtime_error("HDR_RECONSTRUCTION_UNAVAILABLE");
  // libheif inherits primary transforms onto auxiliary handles; apply the shared geometry once below.
  options->ignore_transformations = true; options->output_image_nclx_profile = nullptr;
  heif_image* mapRaw = nullptr;
  check(heif_decode_image(auxiliary, &mapRaw, heif_colorspace_monochrome, heif_chroma_monochrome, options.get()));
  std::unique_ptr<heif_image, decltype(&heif_image_release)> map(mapRaw, heif_image_release);
  int baseStride = 0, mapStride = 0;
  const auto* baseBytes = heif_image_get_plane_readonly(baseRaw, heif_channel_interleaved, &baseStride);
  const auto* mapBytes = heif_image_get_plane_readonly(mapRaw, heif_channel_Y, &mapStride);
  if (!baseBytes || !mapBytes || baseStride < rawWidth * 4 || mapStride < mapWidth
      || heif_image_get_width(mapRaw, heif_channel_Y) != mapWidth || heif_image_get_height(mapRaw, heif_channel_Y) != mapHeight
      || heif_image_get_bits_per_pixel_range(mapRaw, heif_channel_Y) != 8)
    throw std::runtime_error("INVALID_APPLE_GAIN_MAP");
  std::vector<float> baseLinear(size_t(rawWidth) * rawHeight * 4);
  for (int y = 0; y < rawHeight; ++y)
    cmsDoTransform(linear.get(), baseBytes + size_t(y) * baseStride, baseLinear.data() + size_t(y) * rawWidth * 4, cmsUInt32Number(rawWidth));
  std::vector<uint8_t> baseline;
  if (paired) {
    auto sdrProfile = rgbProfile(9, 13);
    ColorTransform sdr(cmsCreateTransform(linearProfile.get(), TYPE_RGBA_FLT, sdrProfile.get(), TYPE_RGBA_8,
      INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_COPY_ALPHA | cmsFLAGS_NOOPTIMIZE), cmsDeleteTransform);
    if (!sdr) throw std::runtime_error("HDR_PROFILE_UNSUPPORTED");
    baseline.resize(size_t(rawWidth) * rawHeight * 4);
    cmsDoTransform(sdr.get(), baseLinear.data(), baseline.data(), cmsUInt32Number(rawWidth) * rawHeight);
  }
  std::vector<float> mapCodes(size_t(mapWidth) * mapHeight);
  for (int y = 0; y < mapHeight; ++y) for (int x = 0; x < mapWidth; ++x) {
    const double code = mapBytes[size_t(y) * mapStride + x] / 255.0;
    mapCodes[size_t(y) * mapWidth + x] = float(code);
  }
  int width = rawWidth, height = rawHeight;
  const auto transforms = appleTransforms(ctx, heif_image_handle_get_item_id(primary), width, height);
  input.dimensions(width, height, mapWidth, mapHeight);
  napi_value data; void* output;
  check(napi_create_buffer(env, size_t(width) * height * 16, &output, &data));
  napi_value sdrData; void* sdrOutput = nullptr;
  if (paired) check(napi_create_buffer(env, size_t(width) * height * 4, &sdrOutput, &sdrData));
  auto* target = static_cast<float*>(output);
  for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
    int sx = x, sy = y; inverseAppleGeometry(transforms, sx, sy);
    if (sx < 0 || sy < 0 || sx >= rawWidth || sy >= rawHeight) throw std::runtime_error("CORRUPT_IMAGE");
    const double mx = std::clamp((sx + 0.5) * mapWidth / rawWidth - 0.5, 0.0, double(mapWidth - 1));
    const double my = std::clamp((sy + 0.5) * mapHeight / rawHeight - 0.5, 0.0, double(mapHeight - 1));
    const int x0 = int(mx), y0 = int(my), x1 = std::min(x0 + 1, mapWidth - 1), y1 = std::min(y0 + 1, mapHeight - 1);
    const double top = mapCodes[size_t(y0) * mapWidth + x0] * (1 - (mx - x0)) + mapCodes[size_t(y0) * mapWidth + x1] * (mx - x0);
    const double bottom = mapCodes[size_t(y1) * mapWidth + x0] * (1 - (mx - x0)) + mapCodes[size_t(y1) * mapWidth + x1] * (mx - x0);
    // Version 65536 matches ImageIO's 2.2 curve, applied after resampling encoded map values.
    const double gain = 1 + (headroom - 1) * std::pow(top * (1 - (my - y0)) + bottom * (my - y0), 2.2);
    const size_t sourceOffset = (size_t(sy) * rawWidth + sx) * 4, offset = (size_t(y) * width + x) * 4;
    for (int c = 0; c < 4; ++c) {
      const float value = float(baseLinear[sourceOffset + c] * (c == 3 ? 1 : gain));
      if (!std::isfinite(value)) throw std::runtime_error("INVALID_LINEAR_PIXELS");
      target[offset + c] = value;
    }
    if (paired) std::memcpy(static_cast<uint8_t*>(sdrOutput) + offset, baseline.data() + sourceOffset, 4);
  }
  auto result = object(env); check(napi_set_named_property(env, result, "data", data));
  field(env, result, "width", double(width)); field(env, result, "height", double(height));
  field(env, result, "gamut", 2.0); field(env, result, "referenceWhite", 203.0);
  field(env, result, "renderingPolicy", "apple-legacy-imageio-2.2-reference-203-v1");
  if (paired) { check(napi_set_named_property(env, result, "sdr", sdrData)); field(env, result, "sdrGamut", 2.0); }
  return result;
}

napi_value decodeHeif(napi_env env, Input& input, bool paired = false) {
  auto ctx = input.readHeif();
  if (heifHasToneMap(input, ctx.get())) throw std::runtime_error("ISO_HEIF_GAIN_MAP_UNAVAILABLE");
  heif_image_handle* raw = nullptr; check(heif_context_get_primary_image_handle(ctx.get(), &raw));
  Handle primary(raw, heif_image_handle_release);
  auto auxiliary = appleAuxiliary(raw);
  if (auxiliary) return decodeApple(env, input, ctx.get(), raw, auxiliary.get(), paired);
  if (paired) throw std::runtime_error("ADAPTIVE_IMAGE_UNAVAILABLE");
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
    if (hasGainMap(input)) {
      auto dec = decoder(input);
      field(env, result, "dynamicRange", "hdr");
      const auto* bytes = static_cast<const uint8_t*>(input.data);
      const bool jpeg = input.size >= 2 && bytes[0] == 255 && bytes[1] == 216;
      if (jpeg) {
        field(env, result, "container", "jpeg"); field(env, result, "codec", "jpeg");
        field(env, result, "bitDepth", 8.0);
        field(env, result, "gainMap", jpegIsoGainMap(uhdr_dec_get_gainmap_image(dec.get())) ? "iso-21496" : "ultra-hdr");
      } else {
        auto ctx = input.readHeif();
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
      auto ctx = input.readHeif();
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
      auto auxiliary = appleAuxiliary(raw);
      if (auxiliary) {
        field(env, result, "dynamicRange", "hdr"); field(env, result, "gainMap", "apple-legacy");
        field(env, result, "transfer", "adaptive");
        try {
          validateAppleVersion(input, auxiliary.get());
          field(env, result, "contentHeadroom", appleHeadroom(input, raw));
          validateAppleLayout(input, ctx.get(), raw, auxiliary.get());
          auto color = appleColorProfile(input, raw);
          field(env, result, "reconstructionAvailable", true);
          field(env, result, "renderingPolicy", "apple-legacy-imageio-2.2-reference-203-v1");
        } catch (const std::bad_alloc&) { throw;
        } catch (const std::exception& error) {
          if (std::strcmp(error.what(), "RESOURCE_LIMIT") == 0) throw;
          field(env, result, "reconstructionAvailable", false);
          field(env, result, "fallbackReason", (std::strcmp(error.what(), "APPLE_GAIN_MAP_VERSION_UNSUPPORTED") == 0
            || std::strcmp(error.what(), "APPLE_GAIN_MAP_GEOMETRY_UNSUPPORTED") == 0)
            ? "apple-gain-map-interpretation-unqualified" : std::strcmp(error.what(), "HDR_PROFILE_UNSUPPORTED") == 0
            ? "hdr-profile-unsupported" : "invalid-gain-map");
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
    if (!hasGainMap(input)
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
    if (!hasGainMap(input)) return decodeHeif(env, input, true);
    // The previous decoder is destroyed before this one starts. Include retained float RGB in its budget.
    auto result = decodeLinear(env, input);
    auto dec = decoder(input, false, true);
    input.dimensions(uhdr_dec_get_image_width(dec.get()), uhdr_dec_get_image_height(dec.get()),
      uhdr_dec_get_gainmap_width(dec.get()), uhdr_dec_get_gainmap_height(dec.get()), 80);
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
        || maxPixels > 200000000 || maxBytes > 8589934592 || maxBytes <= 0
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
napi_value encodeHeic(napi_env env, napi_callback_info info) {
  return invoke(env, info, 6, [&](napi_value* args) {
    bool buffer; check(napi_is_buffer(env, args[0], &buffer));
    if (!buffer) throw std::runtime_error("INVALID_ARGUMENT");
    void* bytes; size_t size; check(napi_get_buffer_info(env, args[0], &bytes, &size));
    const double wd = number(env, args[1]), hd = number(env, args[2]), gd = number(env, args[3]);
    const double maxPixels = number(env, args[4]), maxBytes = number(env, args[5]);
    if (!std::isfinite(wd) || !std::isfinite(hd) || !std::isfinite(gd)
        || !std::isfinite(maxPixels) || !std::isfinite(maxBytes)
        || reinterpret_cast<uintptr_t>(bytes) % alignof(float) != 0
        || wd < 1 || hd < 1 || wd != std::floor(wd) || hd != std::floor(hd)
        || maxPixels < 1 || maxPixels > 200000000 || wd * hd > maxPixels
        || maxBytes <= 0 || maxBytes > 8589934592 || wd * hd * 64 > maxBytes
        || size != wd * hd * 16 || gd < 0 || gd > 2 || gd != std::floor(gd))
      throw std::runtime_error("RESOURCE_LIMIT");
    const auto* source = static_cast<const float*>(bytes);
    for (size_t i = 0; i < size / 4; ++i)
      if (!std::isfinite(source[i]) || source[i] < 0 || source[i] > (i % 4 == 3 ? 1 : 10000.0 / 203))
        throw std::runtime_error("INVALID_LINEAR_PIXELS");
    Context ctx(heif_context_alloc(), heif_context_free);
    if (!ctx) throw std::runtime_error("RESOURCE_LIMIT");
    const heif_encoder_descriptor* descriptor = nullptr;
    if (heif_get_encoder_descriptors(heif_compression_HEVC, "x265", &descriptor, 1) != 1)
      throw std::runtime_error("HDR_HEIC_ENCODER_UNAVAILABLE");
    heif_encoder* encoderRaw = nullptr; check(heif_context_get_encoder(ctx.get(), descriptor, &encoderRaw));
    std::unique_ptr<heif_encoder, decltype(&heif_encoder_release)> encoder(encoderRaw, heif_encoder_release);
    check(heif_encoder_set_lossy_quality(encoder.get(), 95));
    check(heif_encoder_set_logging_level(encoder.get(), 0));
    check(heif_encoder_set_parameter_string(encoder.get(), "chroma", "420"));
    check(heif_encoder_set_parameter_string(encoder.get(), "x265:pools", "none"));
    check(heif_encoder_set_parameter_string(encoder.get(), "x265:frame-threads", "1"));
    check(heif_encoder_set_parameter_string(encoder.get(), "x265:wpp", "0"));
    heif_image* imageRaw = nullptr;
    check(heif_image_create(int(wd), int(hd), heif_colorspace_RGB, heif_chroma_interleaved_RRGGBBAA_LE, &imageRaw));
    std::unique_ptr<heif_image, decltype(&heif_image_release)> image(imageRaw, heif_image_release);
    check(heif_image_add_plane(image.get(), heif_channel_interleaved, int(wd), int(hd), 10));
    int stride = 0; auto* plane = heif_image_get_plane(image.get(), heif_channel_interleaved, &stride);
    if (!plane || stride < wd * 8) throw std::runtime_error("RESOURCE_LIMIT");
    for (int y = 0; y < int(hd); ++y) {
      auto* row = reinterpret_cast<uint16_t*>(plane + size_t(y) * stride);
      for (int x = 0; x < int(wd) * 4; ++x) {
        double value = source[size_t(y) * int(wd) * 4 + x];
        if (x % 4 != 3) {
          // ST 2084 encodes absolute light: working 1.0 is 203 cd/m², PQ 1.0 is 10000 cd/m².
          const double light = std::pow(value * 203 / 10000, 2610.0 / 16384);
          value = std::pow((3424.0 / 4096 + 2413.0 / 128 * light) / (1 + 2392.0 / 128 * light), 2523.0 / 32);
        }
        row[x] = uint16_t(std::lround(value * 1023));
      }
    }
    Profile profile(heif_nclx_color_profile_alloc(), heif_nclx_color_profile_free);
    if (!profile) throw std::runtime_error("RESOURCE_LIMIT");
    check(heif_nclx_color_profile_set_color_primaries(profile.get(), gd == 2 ? 9 : gd == 1 ? 12 : 1));
    check(heif_nclx_color_profile_set_transfer_characteristics(profile.get(), 16));
    check(heif_nclx_color_profile_set_matrix_coefficients(profile.get(), gd == 2 ? 9 : 1));
    profile->full_range_flag = 1;
    check(heif_image_set_nclx_color_profile(image.get(), profile.get()));
    std::unique_ptr<heif_encoding_options, decltype(&heif_encoding_options_free)>
      options(heif_encoding_options_alloc(), heif_encoding_options_free);
    if (!options) throw std::runtime_error("RESOURCE_LIMIT");
    options->output_nclx_profile = profile.get();
    options->image_orientation = heif_orientation_normal;
    heif_image_handle* handleRaw = nullptr;
    check(heif_context_encode_image(ctx.get(), image.get(), encoder.get(), options.get(), &handleRaw));
    Handle handle(handleRaw, heif_image_handle_release);
    struct Output { std::vector<uint8_t> bytes; size_t limit; } output{{}, size_t(std::min(maxBytes, 134217728.0))};
    heif_writer writer{1, [](heif_context*, const void* data, size_t length, void* state) -> heif_error {
      auto& output = *static_cast<Output*>(state);
      if (length > output.limit - output.bytes.size())
        return {heif_error_Memory_allocation_error, heif_suberror_Unspecified, "RESOURCE_LIMIT"};
      try {
        const auto* bytes = static_cast<const uint8_t*>(data);
        output.bytes.insert(output.bytes.end(), bytes, bytes + length);
        return {heif_error_Ok, heif_suberror_Unspecified, nullptr};
      } catch (...) { return {heif_error_Memory_allocation_error, heif_suberror_Unspecified, "RESOURCE_LIMIT"}; }
    }};
    check(heif_context_write(ctx.get(), &writer, &output));
    // Validate the serialized stream: the encoder's in-memory handle does not report coded bit depth.
    Context verify(heif_context_alloc(), heif_context_free);
    if (!verify) throw std::runtime_error("RESOURCE_LIMIT");
    check(heif_context_read_from_memory_without_copy(verify.get(), output.bytes.data(), output.bytes.size(), nullptr));
    heif_image_handle* verifiedRaw = nullptr; check(heif_context_get_primary_image_handle(verify.get(), &verifiedRaw));
    Handle verified(verifiedRaw, heif_image_handle_release);
    heif_color_profile_nclx* verifiedProfileRaw = nullptr;
    check(heif_image_handle_get_nclx_color_profile(verified.get(), &verifiedProfileRaw));
    Profile verifiedProfile(verifiedProfileRaw, heif_nclx_color_profile_free);
    if (heif_image_handle_get_luma_bits_per_pixel(verified.get()) != 10
        || verifiedProfile->transfer_characteristics != 16
        || verifiedProfile->color_primaries != profile->color_primaries)
      throw std::runtime_error("HDR_HEIC_ENCODER_UNAVAILABLE");
    napi_value result; check(napi_create_buffer_copy(env, output.bytes.size(), output.bytes.data(), nullptr, &result));
    return result;
  });
}
napi_value capabilities(napi_env env, napi_callback_info info) {
  return invoke(env, info, 0, [&](napi_value*) {
  napi_value result = object(env);
  field(env, result, "libheif", heif_get_version());
  field(env, result, "libultrahdr", UHDR_LIB_VERSION_STR);
  field(env, result, "heicDecoder", heif_have_decoder_for_format(heif_compression_HEVC) != 0);
  field(env, result, "appleGainMapDecoder", heif_have_decoder_for_format(heif_compression_HEVC) != 0);
  field(env, result, "avifDecoder", heif_have_decoder_for_format(heif_compression_AV1) != 0);
#ifdef UHDR_FRAMELEAF_RESOURCE_LIMITS_API
  field(env, result, "renderer", "frameleaf-develop-hdr/2");
  field(env, result, "isoGainMapDecoder", uhdr_is_heif_supported() != 0);
#else
  field(env, result, "renderer", "frameleaf-develop-hdr/1");
  field(env, result, "isoGainMapDecoder", false);
#endif
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
    {"encodeHeic", nullptr, encodeHeic, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  check(napi_define_properties(env, exports, sizeof(functions) / sizeof(functions[0]), functions)); return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
