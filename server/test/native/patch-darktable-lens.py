"""Apply one calibration-report seam to the pinned darktable source before its normal build.
No module algorithm, ABI, matching or correction defaults are changed. Runtime refuses missing reports.
"""
import hashlib
import sys
from pathlib import Path

EXPECTED = "042c85866fb0eed61f6c03732a5631f88e15368413c8555b3613d517e1e3379a"
ANCHOR = """  piece->process_cl_ready = TRUE;

  if(d->method == DT_IOP_LENS_METHOD_LENSFUN)
  {
    _commit_params_lf(self, p, pipe, piece);
  }
  else if(d->method == DT_IOP_LENS_METHOD_EMBEDDED_METADATA)
  {
    _commit_params_md(self, p, pipe, piece);
  }
  else
   _commit_params_vig(self, p, pipe, piece);
"""
REPORT = """
  // Frameleaf: report genuine calibration availability for unattended CLI exports.
  int frameleaf_flags = 0;
  if(d->method == DT_IOP_LENS_METHOD_LENSFUN && d->lens && d->lens->Model)
  {
    int mods = 0;
    dt_pthread_mutex_lock(&darktable.plugin_threadsafe);
    lfModifier *modifier = _get_modifier(&mods, self->dev->image_storage.width,
                                         self->dev->image_storage.height, d,
                                         LF_MODIFY_ALL, FALSE);
    delete modifier;
    dt_pthread_mutex_unlock(&darktable.plugin_threadsafe);
    frameleaf_flags = _modflags_from_lensfun_mods(mods);
  }
  else if(d->method == DT_IOP_LENS_METHOD_EMBEDDED_METADATA)
    frameleaf_flags = _check_corrections_md(d);
  fprintf(stderr, "frameleaf-lens-calibration:%d\\n", frameleaf_flags);
"""

def patch(path: Path) -> None:
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != EXPECTED:
        raise ValueError("Lens source differs from darktable 03179f8; refuse patch drift")
    text = data.decode()
    if text.count(ANCHOR) != 1:
        raise ValueError("Pinned calibration-report insertion point missing")
    path.write_text(text.replace(ANCHOR, ANCHOR + REPORT))

if __name__ == "__main__":
    patch(Path(sys.argv[1]) / "src/iop/lens.cc")
