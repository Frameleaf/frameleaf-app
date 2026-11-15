# Studio render spec: sound channel mapping (native-app contract)

**Status: native-app contract.** This page specifies which source channels of a sound clip feed its left and right outputs (FL-1561), and how that combines with track pan and with the other clips of a mix. It belongs to the render spec of [`README.md`](README.md) and follows its terms: it is a clean-room specification, written by reading the engine at the revision pinned there, and it holds mathematics and prose only. Rules are tagged M1 to M10.

## The field

**[M1] `audioChannelMap`.** An optional object on a `video` or `audio` item (protocol 2.4): `{ "left": [i, …], "right": [j, …] }`. Each list holds source plane indexes, integers 0 to 31, no index twice in one list, at most 32 entries. The two lists together hold at least one index; one of them may be empty. Absent means the clip plays its source planes as they are, which is every graph written before FL-1561.

**[M2] Planes.** Index k is the k-th plane the decoder hands over, in the file's own order; Frameleaf never reorders planes. For the common layouts that order is:

| Source | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mono | M | | | | | | | |
| stereo | L | R | | | | | | |
| 5.1 | L | R | C | LFE | Ls | Rs | | |
| 7.1 | L | R | C | LFE | Ls | Rs | Lrs | Rrs |

**[M3] The rule.** For each output side s with list I_s of n_s indexes, at every sample t:

  out_s(t) = (1 / n_s) · Σ_{k in I_s, k < N} in_k(t)

where N is the number of planes the source has. An index the source does not have contributes silence but still counts in n_s. An empty list makes that side silent. The gain is the plain 1 / n_s, never a power or speaker-layout law, and the sum is taken before the gain.

**[M4] Malformed maps.** A map that breaks M1 is refused: export fails with "Invalid audio channel map" and publishes nothing, preview keeps the clip silent, and a project bundle that carries one fails validation. No map is ever corrected silently.

## What it names

**[M5] Presets.** An editor offers these; any other map that meets M1 is equally valid.

| Name | `left` | `right` | Result on a stereo source (L, R) | Result on 5.1 |
| --- | --- | --- | --- | --- |
| Stereo (no field) | | | L, R | all six planes, unmapped (M8) |
| Stereo, explicit (dual mono) | `[0]` | `[1]` | L, R | front L, front R |
| Mono from left | `[0]` | `[0]` | L, L | front L on both |
| Mono from right | `[1]` | `[1]` | R, R | front R on both |
| Mono mix | `[0, 1]` | `[0, 1]` | (L+R)/2 on both | (L+R)/2 on both |
| Front L/R | `[0]` | `[1]` | L, R | L, R |
| Centre to both | `[2]` | `[2]` | silent (no plane 2) | C, C |
| LFE to both | `[3]` | `[3]` | silent | LFE, LFE |
| Surround L/R | `[4]` | `[5]` | silent | Ls, Rs |

Dual mono means each source channel goes to its own side unchanged; for a two-channel source it is the same as stereo, and it is written `[0]` / `[1]`.

**[M6] Worked values.** Source planes at one sample: 5.1 = (0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625); stereo = (0.5, 0.25); mono = (0.75).

| Source | `left` | `right` | out_left | out_right |
| --- | --- | --- | --- | --- |
| stereo | `[0, 1]` | `[0, 1]` | 0.375 | 0.375 |
| stereo | `[1]` | `[1]` | 0.25 | 0.25 |
| stereo | `[0]` | `[]` | 0.5 | 0 |
| 5.1 | `[2]` | `[2]` | 0.125 | 0.125 |
| 5.1 | `[4]` | `[5]` | 0.03125 | 0.015625 |
| 5.1 | `[0, 2]` | `[1, 2]` | 0.3125 | 0.1875 |
| 5.1 | `[0, 1, 2]` | `[0]` | 0.291666… | 0.5 |
| mono | `[0]` | `[0, 1]` | 0.75 | 0.375 |
| stereo | `[2]` | `[5]` | 0 | 0 |

## Where it sits

**[M7] Order of stages.** Per clip: decode, **channel map**, reverse, speed and pitch, clip EQ, track pan (leaf track first, then the tracks of enclosing compound clips from the inside out), then clip volume, fades, ducking, track and master gain. The map reads the planes exactly as decoded, before anything else touches them, so index 1 of a mono source is silent and the speed and pitch stage only ever sees the two mapped planes.

**[M8] Plane counts in a mix.** A mapped clip contributes exactly two planes (left, right). An unmapped clip contributes its source planes. Every audible clip of an export must contribute the same number of planes, as before: a mapped 5.1 clip mixes with unmapped stereo clips and the export is stereo; an unmapped 5.1 clip beside stereo clips is still refused ("Mixed audio channel counts require an explicit layout mapping"), and mapping it is that explicit layout. A timeline whose clips are all unmapped 5.1 still mixes six planes, which the encoder refuses for want of a speaker layout ("Multichannel encoding requires an explicit supported speaker layout") unless the untouched file is copied as it is; mapping the clips is how that sound reaches a stereo export.

**[M9] Pan on multichannel sound.** Track pan acts on the two mapped planes with the stereo pan law of the existing pan stage (p > 0: left = L·cos(pπ/2), right = R + L·sin(pπ/2); p < 0: left = L + R·cos((p+1)π/2), right = R·sin((p+1)π/2)). A 5.1 clip that is mapped can therefore be panned; an unmapped multichannel clip with an active pan is refused as before. Example: 5.1 centre to both, pan 0.5, centre plane 0.25: left = 0.25 · 0.7071068 = 0.1767767, right = 0.25 + 0.1767767 = 0.4267767.

**[M10] Preview, meters and copy.** Preview applies the same rule at decode, to the source planes, before its usual reduction to a stereo preview buffer (which otherwise folds surround down to stereo and doubles mono); a mapped clip therefore always plays from decoded sound, never from the file's own playback, and its decoded windows are kept apart from the unmapped ones. Preview and export agree to float precision, at preview's lower sample rate. A clip with a map is never packet-copied into an export. The level meters estimate a mapped clip only from a mono envelope (the other planes of a mono source are silent, M3); from a stereo envelope they report it as unavailable, because an envelope cannot say what each source plane holds.

**Native rule.** A client that cannot apply a channel map must refuse to export a graph in which an audible clip carries `audioChannelMap`, and must preserve the object unchanged. A writer writes only indexes the source has, and drops the field instead of writing the stereo identity when no mapping is wanted.

**Not in this page.** Sample-accurate sound edits and the sound effect stack (compressor, limiter, gate, de-esser, reverb, noise reduction, parametric EQ) are separate parts of FL-1561. There is no editor control for the map at this revision; the field is written by the editor's future control or by a client.
