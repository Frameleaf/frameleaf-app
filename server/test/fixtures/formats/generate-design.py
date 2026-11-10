#!/usr/bin/env python3
"""Writes the design-file fixtures (FL-1358) into ./design, byte for byte, with the standard library only.

Nothing here comes from a design application: each file is the smallest one that follows the published
layout of its format, built from one test pattern, so it carries no third-party licence and is the same
on every run. What that proves is Frameleaf's side of the format (which loader opens it, which entry of
a container holds the preview). Real files from Photoshop, Fireworks, Sketch and the rest are still
wanted: see SOURCES.md.

    python3 generate-design.py            # run from anywhere; writes beside this script
"""

import os
import struct
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "design")
W, H = 96, 72


def pixel(x, y, w=W, h=H):
    """A busy, non-repeating picture: no flat rows, so a blank render is easy to tell from a real one."""
    return ((x * 255) // (w - 1), (y * 255) // (h - 1), ((x * 7) ^ (y * 13)) & 0xFF)


def rgb_rows(w=W, h=H):
    return [[pixel(x, y, w, h) for x in range(w)] for y in range(h)]


def write(name, data):
    with open(os.path.join(OUT, name), "wb") as file:
        file.write(data)


# --- PNG ---------------------------------------------------------------------------------------------
def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(w=W, h=H, before_idat=(), after_idat=()):
    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in rgb_rows(w, h))
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + b"".join(png_chunk(kind, data) for kind, data in before_idat)
        + png_chunk(b"IDAT", zlib.compress(raw, 9))
        + b"".join(png_chunk(kind, data) for kind, data in after_idat)
        + png_chunk(b"IEND", b"")
    )


def bmp(w=W, h=H):
    pad = (4 - (w * 3) % 4) % 4
    rows = b"".join(
        bytes(c for px in row for c in reversed(px)) + b"\x00" * pad for row in reversed(rgb_rows(w, h))
    )
    header = struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, len(rows), 2835, 2835, 0, 0)
    return b"BM" + struct.pack("<IHHI", 14 + 40 + len(rows), 0, 0, 54) + header + rows


def tiff(w=W, h=H):
    """Uncompressed little-endian RGB, one strip."""
    pixels = bytes(c for row in rgb_rows(w, h) for px in row for c in px)
    tags = [
        (256, 3, 1, w),
        (257, 3, 1, h),
        (258, 3, 3, None),  # BitsPerSample -> offset to 8,8,8
        (259, 3, 1, 1),
        (262, 3, 1, 2),
        (273, 4, 1, None),  # StripOffsets
        (277, 3, 1, 3),
        (278, 3, 1, h),
        (279, 4, 1, len(pixels)),
        (284, 3, 1, 1),
    ]
    ifd_at = 8
    bits_at = ifd_at + 2 + len(tags) * 12 + 4
    data_at = bits_at + 6
    out = b"II*\x00" + struct.pack("<I", ifd_at) + struct.pack("<H", len(tags))
    for tag, kind, count, value in tags:
        if tag == 258:
            value = bits_at
        if tag == 273:
            value = data_at
        packed = struct.pack("<H", value) + b"\x00\x00" if kind == 3 and count == 1 else struct.pack("<I", value)
        out += struct.pack("<HHI", tag, kind, count) + packed
    return out + struct.pack("<I", 0) + struct.pack("<HHH", 8, 8, 8) + pixels


# --- Photoshop (PSD and PSB) -------------------------------------------------------------------------
def pascal(name, multiple):
    data = bytes([len(name)]) + name
    return data + b"\x00" * (-len(data) % multiple)


def unicode_string(text):
    return struct.pack(">I", len(text)) + text.encode("utf-16-be")


def resource(resource_id, data):
    return b"8BIM" + struct.pack(">H", resource_id) + b"\x00\x00" + struct.pack(">I", len(data)) + data + b"\x00" * (len(data) % 2)


def version_info(has_real_merged_data):
    """Resource 0x0421. Its second field is what "Maximize compatibility" turns on."""
    return resource(
        0x0421,
        struct.pack(">IB", 1, 1 if has_real_merged_data else 0)
        + unicode_string("Frameleaf fixture")
        + unicode_string("Frameleaf fixture")
        + struct.pack(">I", 1),
    )


def planes(rows, depth, channels):
    """Planar channel data at the document's depth; a fourth channel (CMYK black) is left empty."""
    out = []
    for channel in range(channels):
        plane = bytearray()
        for row in rows:
            for px in row:
                value = px[channel] if channel < 3 else 255
                if depth == 8:
                    plane.append(value)
                elif depth == 16:
                    plane += struct.pack(">H", value * 257)
                else:
                    plane += struct.pack(">f", value / 255)
        out.append(bytes(plane))
    return out


def packbits_row(row):
    """PackBits for a row of bytes. Runs only: the wide PSB is made of flat rows."""
    out = bytearray()
    index = 0
    while index < len(row):
        run = 1
        while index + run < len(row) and run < 128 and row[index + run] == row[index]:
            run += 1
        if run > 1:
            out += bytes([257 - run, row[index]])
        else:
            out += bytes([0, row[index]])
        index += run
    return bytes(out)


def layer(top, left, rows, with_alpha):
    """One 8-bit RGB layer, raw channel data. Returns (record, channel data)."""
    height, width = len(rows), len(rows[0])
    ids = ([-1] if with_alpha else []) + [0, 1, 2]
    data = []
    for channel in ids:
        plane = bytes([255]) * (width * height) if channel == -1 else planes(rows, 8, 3)[channel]
        data.append(struct.pack(">H", 0) + plane)
    record = struct.pack(">iiiiH", top, left, top + height, left + width, len(ids))
    for channel, plane in zip(ids, data):
        record += struct.pack(">hI", channel, len(plane))
    extra = struct.pack(">I", 0) + struct.pack(">I", 0) + pascal(b"Layer", 4)
    record += b"8BIMnorm" + bytes([255, 0, 0, 0]) + struct.pack(">I", len(extra)) + extra
    return record, b"".join(data)


def psd(*, depth=8, mode=3, layers=(), merged=True, psb=False, size=(W, H), rle_rows=None):
    """mode 3 is RGB, 4 is CMYK. `merged` false leaves a white composite, as Photoshop does."""
    width, height = size
    channels = 4 if mode == 4 else 3
    wide = ">Q" if psb else ">I"
    out = b"8BPS" + struct.pack(">H6xHIIHH", 2 if psb else 1, channels, height, width, depth, mode)
    out += struct.pack(">I", 0)  # colour mode data
    resources = version_info(merged)
    out += struct.pack(">I", len(resources)) + resources
    if layers:
        records, data = zip(*layers)
        info = struct.pack(">h", len(layers)) + b"".join(records) + b"".join(data)
        info += b"\x00" * (len(info) % 2)
        section = struct.pack(wide, len(info)) + info + struct.pack(">I", 0)
        out += struct.pack(wide, len(section)) + section
    else:
        out += struct.pack(wide, 0)
    if rle_rows is not None:
        packed = [packbits_row(row) for row in rle_rows]
        out += struct.pack(">H", 1)
        out += b"".join(struct.pack(">I" if psb else ">H", len(row)) for row in packed) + b"".join(packed)
        return out
    rows = rgb_rows(width, height) if merged else [[(255, 255, 255)] * width for _ in range(height)]
    return out + struct.pack(">H", 0) + b"".join(planes(rows, depth, channels))


def thumbnail_only():
    """A document whose picture is cut off after the header, but which carries Photoshop's own JPEG thumbnail
    (resource 0x040C): the shape of a file too large or too unusual to render."""
    with open(os.path.join(HERE, "jpeg", "baseline.jpg"), "rb") as file:
        jpeg = file.read()
    width, height = 320, 240
    row = (width * 24 + 31) // 32 * 4
    thumbnail = resource(0x040C, struct.pack(">IIIIIIHH", 1, width, height, row, row * height, len(jpeg), 24, 1) + jpeg)
    out = b"8BPS" + struct.pack(">H6xHIIHH", 1, 3, H, W, 8, 3) + struct.pack(">I", 0)
    resources = version_info(True) + thumbnail
    return out + struct.pack(">I", len(resources)) + resources + struct.pack(">I", 0) + struct.pack(">H", 0) + b"\x00" * 64


def layered(merged):
    patch = [[(230, 40, 60)] * 40 for _ in range(30)]
    return psd(layers=[layer(0, 0, rgb_rows(), False), layer(10, 10, patch, True)], merged=merged)


def wide_psb():
    """Wider than a PSD may be (30,000 px), which is what PSB exists for. Flat rows keep it small."""
    width, height = 30100, 40
    rows = [bytes([(y * 6 + channel * 80) & 0xFF]) * width for channel in range(3) for y in range(height)]
    return psd(psb=True, size=(width, height), rle_rows=rows)


# --- PDF and PDF-compatible Illustrator --------------------------------------------------------------
def pdf(page_streams, creator, extra_header=b""):
    """A classic cross-reference PDF with 240x180 pt pages (480x360 px at the 144 dpi Frameleaf renders at)."""
    count = len(page_streams)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Count %d /Kids [%s] >>" % (count, b" ".join(b"%d 0 R" % (3 + 2 * i) for i in range(count))),
    ]
    for index, stream in enumerate(page_streams):
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Contents %d 0 R /Resources << >> >>" % (4 + 2 * index)
        )
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
    objects.append(b"<< /Creator (%s) /Producer (Frameleaf fixture) >>" % creator)
    out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n" + extra_header
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        len(objects),
        xref,
    )
    return out


PAGE_ONE = b"0.9 0.2 0.3 rg 20 20 120 90 re f 0.1 0.4 0.8 rg 100 70 120 90 re f"
PAGE_TWO = b"0.2 0.7 0.3 rg 40 40 160 100 re f"
ARTBOARD = b"1 0.6 0 rg 30 30 180 120 re f 0.2 0.2 0.2 RG 6 w 30 30 180 120 re S"


# --- EPS ---------------------------------------------------------------------------------------------
POSTSCRIPT = (
    b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 96 72\n%%Creator: Frameleaf fixture\n%%EndComments\n"
    b"0.9 0.2 0.3 setrgbcolor 10 10 60 40 rectfill\nshowpage\n%%EOF\n"
)


def eps_with_preview():
    """The DOS EPS binary layout: a 30-byte header, the PostScript, then a TIFF preview."""
    preview = tiff()
    header = b"\xc5\xd0\xd3\xc6" + struct.pack("<IIIIIIH", 30, len(POSTSCRIPT), 0, 0, 30 + len(POSTSCRIPT), len(preview), 0xFFFF)
    return header + POSTSCRIPT + preview


# --- GIMP XCF ----------------------------------------------------------------------------------------
def xcf():
    """Version 0, one RGBA layer, tiles stored uncompressed (pixel-interleaved, 64x64)."""
    rows = rgb_rows()

    def prop(kind, data=b""):
        return struct.pack(">II", kind, len(data)) + data

    def string(text):
        return struct.pack(">I", len(text) + 1) + text + b"\x00"

    tiles = []
    for top in range(0, H, 64):
        for left in range(0, W, 64):
            tiles.append(bytes(c for row in rows[top : top + 64] for px in row[left : left + 64] for c in (*px, 255)))

    head = b"gimp xcf file\x00" + struct.pack(">III", W, H, 0) + prop(17, b"\x00") + prop(0)
    layer_at = len(head) + 4 + 4 + 4  # one layer pointer, its terminator, the channel list terminator
    layer_head = (
        struct.pack(">III", W, H, 1)
        + string(b"Background")
        + prop(6, struct.pack(">I", 255))
        + prop(8, struct.pack(">I", 1))
        + prop(15, struct.pack(">ii", 0, 0))
        + prop(7, struct.pack(">I", 0))
        + prop(0)
    )
    hierarchy_at = layer_at + len(layer_head) + 8
    level_at = hierarchy_at + 12 + 8
    tiles_at = level_at + 8 + 4 * (len(tiles) + 1)
    tile_offsets, cursor = [], tiles_at
    for tile in tiles:
        tile_offsets.append(cursor)
        cursor += len(tile)
    return (
        head
        + struct.pack(">III", layer_at, 0, 0)
        + layer_head
        + struct.pack(">II", hierarchy_at, 0)
        + struct.pack(">IIIII", W, H, 4, level_at, 0)
        + struct.pack(">II", W, H)
        + b"".join(struct.pack(">I", offset) for offset in tile_offsets)
        + struct.pack(">I", 0)
        + b"".join(tiles)
        # ImageMagick sizes the last tile's read as a full 64x64 RGBA tile and a half, so the bytes must exist.
        + b"\x00" * (64 * 64 * 6)
    )


# --- Containers: a ZIP whose preview sits at a fixed path ---------------------------------------------
def container(name, entries):
    """Stored and deflated entries, fixed timestamps, so the bytes never change between runs."""
    path = os.path.join(OUT, name)
    with zipfile.ZipFile(path, "w") as archive:
        for index, (entry, data) in enumerate(entries):
            info = zipfile.ZipInfo(entry, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED if index == 0 else zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)


def main():
    os.makedirs(OUT, exist_ok=True)
    full, small = png(), png(48, 36)

    write("layered-compatible.psd", layered(True))
    write("layered-no-composite.psd", layered(False))
    write("16bit.psd", psd(depth=16))
    write("32bit.psd", psd(depth=32))
    write("cmyk.psd", psd(mode=4))
    write("thumbnail-only.psd", thumbnail_only())
    write("wide.psb", wide_psb())
    write("two-pages.pdf", pdf([PAGE_ONE, PAGE_TWO], b"Frameleaf fixture"))
    # What makes an .ai file "PDF compatible" is exactly this: it is a PDF, with Illustrator's own data beside it.
    write("pdf-compatible.ai", pdf([ARTBOARD], b"Adobe Illustrator (fixture)", b"%AI12_CompressedData placeholder\n"))
    write("tiff-preview.eps", eps_with_preview())
    write("no-preview.eps", POSTSCRIPT)
    write("layer.xcf", xcf())

    # Fireworks keeps its editable document in private chunks around the flattened picture.
    write(
        "fireworks.png",
        png(
            before_idat=[
                (b"tEXt", b"Software\x00Adobe Fireworks CS6"),
                (b"mkBF", b"\xfa\xce\xca\xfe" + b"\x00" * 68),
                (b"mkTS", zlib.compress(b"fixture: Fireworks text and style data")),
                (b"mkBS", zlib.compress(b"fixture: Fireworks object data")),
                (b"prVW", zlib.compress(b"fixture: Fireworks preview")),
            ]
        ),
    )

    container("document.sketch", [("meta.json", b"{}"), ("document.json", b"{}"), ("previews/preview.png", full)])
    container("document.xd", [("mimetype", b"application/vnd.adobe.sparkler.project+dcx"), ("manifest", b"{}"), ("preview.png", full), ("thumbnail.png", small)])
    container("document.fig", [("canvas.fig", b"fig-kiwi fixture"), ("meta.json", b"{}"), ("thumbnail.png", full)])
    container("painting.procreate", [("Document.archive", b"bplist00 fixture"), ("QuickLook/Thumbnail.png", full)])
    container("painting.kra", [("mimetype", b"application/x-krita"), ("maindoc.xml", b"<DOC/>"), ("preview.png", small), ("mergedimage.png", full)])
    container("painting.ora", [("mimetype", b"image/openraster"), ("stack.xml", b"<image/>"), ("Thumbnails/thumbnail.png", small), ("mergedimage.png", full)])
    container("drawing.cdr", [("mimetype", b"application/x-vnd.corel.zcf.draw.document+zip"), ("content/riffData.cdr", b"RIFF fixture"), ("metadata/thumbnails/thumbnail.bmp", bmp())])
    # A container with no picture inside: kept, with the placeholder tile.
    container("no-preview.sketch", [("meta.json", b"{}"), ("document.json", b"{}")])

    for name in sorted(os.listdir(OUT)):
        print(f"{os.path.getsize(os.path.join(OUT, name)):>8} design/{name}")


if __name__ == "__main__":
    main()
