# Generative edit quality set

Fifty reference edits for Generative Develop (FL-748), assembled in FL-775. The owner scores a model's
results on these edits before a release ships it: at least 40 of the 50 must be accepted.

| File                 | What it holds                                                                    |
| -------------------- | -------------------------------------------------------------------------------- |
| `quality-set.json`   | The 50 edits: photo, mode, the words a person types, and what to look for.       |
| `scoring-sheet.json` | The blank scoring form: one row per edit, plus what was run and who scored it.   |
| `photos/`            | The photos the edits start from (about 1 megapixel JPEG).                        |
| `references/`        | A studio-style second photo for a `transfer` edit.                               |

## The edits

| Mode       | Count | What the person asks for                                                     |
| ---------- | ----- | ---------------------------------------------------------------------------- |
| `instruct` | 20    | A change in words: remove, add, recolour, tidy, change text, change season.  |
| `extend`   | 8     | A new shape (`extend.aspect`) or more picture on named sides (`extend.top`). |
| `relight`  | 8     | Different light on the same scene.                                           |
| `sky`      | 6     | A different sky, including reflections and fine edges such as hair.          |
| `transfer` | 8     | A person or object from `reference` placed inside `placement`.               |

Seven of the `transfer` edits take both photos from other edits in the set: an ordinary photo as the
scene and another ordinary photo as the reference, which is how people will use it. The model has to
lift the subject out of its own background.

`region` and `placement` are `[x, y, width, height]` as fractions of the photo, from the top left.
Sides in `extend` are fractions of the photo's own width or height. `accept` lists what the scorer
checks; an edit is accepted only when every line holds and nothing outside the request has changed.

## Scoring a run

1. Run every edit through the model with the settings a release would use, at one fixed seed.
   Save each result as `<id>.png`.
2. Copy `scoring-sheet.json`, fill in `run`, and for each row set `accepted` to `true` or `false`.
   Use `notes` for the reason when it is `false`.
3. The run passes when 40 or more rows are `true` (`gate` in `quality-set.json`). Attach the filled
   sheet and the results to the release issue. The filled sheet is not committed here.

## Where the photos come from

Every photo is fictional. Each was generated for this set with FLUX.2 [klein] 4B (Apache-2.0) from
the `fixturePrompt` and `fixtureSeed` recorded beside it, at 4 steps, and saved as JPEG. One photo is
a darkened copy of another; its entry says so in `derivedFrom`. No photo shows a real person, and
none comes from anyone's library. The SHA-256 of each file is recorded in
`quality-set.json` and checked by `test_generative_edit_quality_set.py`.
