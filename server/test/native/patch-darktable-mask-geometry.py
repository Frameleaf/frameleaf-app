"""Fill the pinned rotatepixels mask-only TODO using its own native pixel backtransform.
No image processing, history ABI, camera defaults or JavaScript pixel stand-in is changed.
"""
import hashlib
import sys
from pathlib import Path

EXPECTED = "b9f5534020a2637d1db6d35e84b806acfbc004a6bf1e9ddb228db13c1ae8f436"
ANCHOR = '''  // TODO
  memset(out, 0, sizeof(float) * roi_out->width * roi_out->height);
  dt_print(DT_DEBUG_ALWAYS, "TODO: implement %s() in %s", __FUNCTION__, __FILE__);'''
NATIVE_MASK = '''  // Frameleaf: mirror process()'s native backtransform for one-channel masks.
  const float scale = roi_in->scale / piece->iscale;
  const dt_interpolation_t *interpolation = dt_interpolation_new(DT_INTERPOLATION_USERPREF);
  DT_OMP_FOR()
  for(int y = 0; y < roi_out->height; y++)
  {
    for(int x = 0; x < roi_out->width; x++)
    {
      float point[2] = { roi_out->x + x, roi_out->y + y }, source[2];
      backtransform(piece, scale, point, source);
      source[0] -= roi_in->x;
      source[1] -= roi_in->y;
      out[(size_t)y * roi_out->width + x] = CLIP(dt_interpolation_compute_sample
        (interpolation, in, source[0], source[1], roi_in->width, roi_in->height, 1, roi_in->width));
    }
  }
  dt_print(DT_DEBUG_ALWAYS, "frameleaf-native-mask-geometry:rotatepixels:1");'''


def patch(path: Path) -> None:
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != EXPECTED:
        raise ValueError("Pixel geometry source differs from darktable 03179f8; refuse patch drift")
    text = data.decode()
    if text.count(ANCHOR) != 1:
        raise ValueError("Pinned native mask insertion point missing")
    path.write_text(text.replace(ANCHOR, NATIVE_MASK))


if __name__ == "__main__":
    patch(Path(sys.argv[1]) / "src/iop/rotatepixels.c")
