# Supported Media Formats

Frameleaf supports a number of image and video formats, the most common of which are outlined here.

:::note
For the full list, refer to the [Frameleaf source code](https://github.com/Frameleaf/frameleaf-app/blob/main/server/src/utils/mime-types.ts).
:::

## Image formats

| Format      | Extension(s)                                          |     Supported?     | Notes                        |
| :---------- | :---------------------------------------------------- | :----------------: | :--------------------------- |
| `APNG`      | `.apng`                                               | :white_check_mark: | Animated PNG                 |
| `AVIF`      | `.avif` `.avifs`                                      | :white_check_mark: |                              |
| `BMP`       | `.bmp`                                                | :white_check_mark: |                              |
| `GIF`       | `.gif`                                                | :white_check_mark: |                              |
| `HEIC`      | `.heic` `.heics`                                      | :white_check_mark: |                              |
| `HEIF`      | `.heif`                                               | :white_check_mark: |                              |
| `JPEG 2000` | `.jp2`                                                | :white_check_mark: |                              |
| `JPEG`      | `.jpeg` `.jpg` `.jpe` `.jfif` `.pjpeg` `.pjp` `.insp` | :white_check_mark: |                              |
| `JPEG XL`   | `.jxl`                                                | :white_check_mark: |                              |
| `MPO`       | `.mpo`                                                | :white_check_mark: | Multi-Picture                |
| `Netpbm`    | `.pbm` `.pgm` `.ppm` `.pnm` `.pfm`                    | :white_check_mark: |                              |
| `PNG`       | `.png`                                                | :white_check_mark: |                              |
| `PSD`       | `.psd`                                                | :white_check_mark: | Adobe Photoshop              |
| `Radiance`  | `.hdr`                                                | :white_check_mark: | High dynamic range           |
| `RAW`       | `.raw` `.mef` `.mos`                                  | :white_check_mark: | Also most camera RAW formats |
| `RW2`       | `.rw2`                                                | :white_check_mark: |                              |
| `SVG`       | `.svg`                                                | :white_check_mark: |                              |
| `TIFF`      | `.tif` `.tiff`                                        | :white_check_mark: |                              |
| `WEBP`      | `.webp`                                               | :white_check_mark: |                              |

## Video formats

| Format      | Extension(s)                        |     Supported?     | Notes                            |
| :---------- | :---------------------------------- | :----------------: | :------------------------------- |
| `3GPP`      | `.3gp` `.3gpp` `.3g2`               | :white_check_mark: |                                  |
| `ASF`       | `.asf`                              | :white_check_mark: |                                  |
| `AVI`       | `.avi` `.divx`                      | :white_check_mark: |                                  |
| `DV`        | `.dv`                               | :white_check_mark: |                                  |
| `FLV`       | `.flv`                              | :white_check_mark: |                                  |
| `M4V`       | `.m4v`                              | :white_check_mark: |                                  |
| `MATROSKA`  | `.mkv` `.mk3d`                      | :white_check_mark: |                                  |
| `MP2T`      | `.mts` `.m2ts` `.m2t` `.ts` `.tod`  | :white_check_mark: |                                  |
| `MP4`       | `.mp4` `.insv` `.f4v`               | :white_check_mark: |                                  |
| `MPEG`      | `.mpg` `.mpe` `.mpeg` `.mod` `.vro` | :white_check_mark: | Camcorder and DVD recorder files |
| `MXF`       | `.mxf`                              | :white_check_mark: |                                  |
| `OGG`       | `.ogv`                              | :white_check_mark: |                                  |
| `QUICKTIME` | `.mov` `.qt`                        | :white_check_mark: |                                  |
| `REALMEDIA` | `.rm` `.rmvb`                       | :white_check_mark: |                                  |
| `WEBM`      | `.webm`                             | :white_check_mark: |                                  |
| `WMV`       | `.wmv`                              | :white_check_mark: |                                  |

## Not supported yet

These formats need decoders Frameleaf doesn't include, so they can't be uploaded or imported:

| Format                   | Extension(s) |
| :----------------------- | :----------- |
| `Blackmagic RAW`         | `.braw`      |
| `Canon Cinema RAW Light` | `.crm`       |
| `OpenEXR`                | `.exr`       |
| `RED RAW`                | `.r3d`       |
