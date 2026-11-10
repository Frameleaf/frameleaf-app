# Library Assistant evaluation

`cases.json` is a versioned set of 213 search questions. `library.json` is a
300-asset synthetic library covering people, pets, places, favorites, photos,
video, OCR, transcripts, and descriptions. Locked and second-owner assets are
planted among eligible matches to check privacy during retrieval. All names,
media metadata, and dialogue in the fixtures are synthetic. The fixture stores
no media bytes.

Question themes were adapted from public discussions about
[location search](https://www.reddit.com/r/immich/comments/1jhv70m),
[text in photos](https://www.reddit.com/r/immich/comments/1aqqd5k),
and [description search](https://www.reddit.com/r/immich/comments/1m001r8),
and from published examples of
[conversational photo search](https://blog.google/products-and-platforms/products/photos/google-ask-photos-early-access/).
The questions use fictional names and context.

## Add a case

Choose a question that has a stable interpretation against the fixture. Give
it a unique ID and family in `cases.json`, specify the expected filters, and
label all relevant visible asset keys. Add near misses to the library when
they make the distinction meaningful. For a question with no relevant assets,
leave `assetKeys` empty. Record the candidate planner's filters under the same
ID in `replay.json`. The initial replay records are hand-authored reference
plans. Keep the reference judgments independent of candidate outputs.

Run `pnpm --filter frameleaf test:assistant-eval` from the workspace root.
The command runs scoring checks and retrieval tests against disposable
PostgreSQL. The regular medium test suite also runs replay in CI.

Replay executes the recorded filters through metadata and transcript search
and checks exact filter agreement, mean recall at 24, per-hit reason claims
against fixture facts, and 95th-percentile case time. `thresholds.json` sets the
minimums. Baseline mode measures today's Ask Search rule planner through the
same fixture with neutral CLIP vectors. It records the baseline without
threshold enforcement. The existing endpoint has a response-level explanation,
so it scores zero for per-hit reasons. Set
`FRAMELEAF_ASSISTANT_EVAL_MODE=baseline` before the same command.

Live qualification requires the planner and Assistant API. Its per-hit claims
must come from the actual Assistant response. Replay and baseline results
cannot qualify the release.
