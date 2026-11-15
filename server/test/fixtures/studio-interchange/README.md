# Editor import fixtures (FL-1548)

Small projects the editor import readers are tested against
(`server/src/utils/studio-interchange/readers/readers.spec.ts`). They hold no media: clips point at
file names the specs answer for, so nothing here needs a licence.

All five describe the same edit, "Lake day", at 25 frames a second:

| Feature                             | FCPXML 1.10 | FCP7 XML v5 | OTIO | EDL |
| ----------------------------------- | ----------- | ----------- | ---- | --- |
| Two clips with a 2 s cross dissolve | yes         | yes         | yes  | yes |
| A title over the first clip         | yes         | yes         | yes  | no  |
| Double speed on the second clip     | yes         | yes         | yes  | yes |
| A marker                            | yes         | yes         | yes  | yes |
| Music on its own track              | yes         | yes         | yes  | yes |
| A nest (compound clip, nested seq.) | yes         | yes         | yes  | no  |
| Picture move and an effect          | yes         | yes         | no   | no  |
| Grade (ASC CDL)                     | no          | no          | yes  | yes |
| Audition, switched-off clip         | yes         | no          | no   | no  |
| An item of an unknown kind          | no          | no          | yes  | no  |

Sidecars: `lake-day.cdl` grades the clip named Kayak, `Kayak.cube` is a size-2 3D LUT that swaps red
and blue, and `Lake morning.cube` is a 1D LUT.

These were written by hand against each format's published description, not exported from the
editors. Projects made in Premiere Pro, DaVinci Resolve, Final Cut Pro and iMovie themselves, one
feature at a time and with a rendered movie of each, are added as the owner makes them on machines
with those editors (FL-1548 follow-up); media in those must be CC0.

## Premiere Pro projects (FL-1550)

`premiere/` holds small projects made in Premiere Pro itself (Windows; project versions 40 and 45),
from py-premiere under the MIT licence (`premiere/LICENSE`). Each `.prproj` has a `.json` beside it:
what Premiere's own scripting API reported for that project (sequences, clips, start, end, in and
out points, markers, components), which the reader spec checks against.

## AAF (FL-1552)

`aaf/` holds AAF files made by Avid Media Composer (8.6 to 18.9) and Premiere Pro 13, from
otio-aaf-adapter under the Apache License 2.0 (`aaf/LICENSE`). The spec's expectations were taken
from that adapter's own reading of each file with OpenTimelineIO 0.18 (clip names, files, source
positions, transitions and speeds).
