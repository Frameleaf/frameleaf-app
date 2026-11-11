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

Set `FRAMELEAF_ASSISTANT_EVAL_MODE=assistant` to score the Assistant HTTP
response with recorded plans. The regular replay run also exercises the
Assistant HTTP response with a local fixture worker. Both use the seeded
library and fixture authentication. These runs verify the harness and the
API contract. Release qualification requires an actual planner model.

## Candidate planner benchmarking

Run a candidate exposing the FL-847 `POST /assistant/plan` contract on a test
worker. Set `FRAMELEAF_ASSISTANT_EVAL_MODE=live` and set
`FRAMELEAF_ASSISTANT_PLANNER_URL` to its HTTP(S) origin before invoking the same
command. Only synthetic questions and catalogue names are sent. Live planning
reports the accepted plan rate and fixture retrieval metrics. This mode uses
the evaluator's reason claims.

## Live Assistant qualification

From a clean candidate checkout, start a test worker built from that candidate's
ML source with its pinned default planner available. Use only a disposable
worker and test database. The harness sends synthetic questions and catalogue
names, runs the production Assistant controller and service, and scores the
plans, result IDs, structured reason claims, and latency in the HTTP response.
The fixture supplies the test session, catalogue entries, and ML destination.

```sh
FRAMELEAF_ASSISTANT_EVAL_MODE=qualification \
FRAMELEAF_ASSISTANT_PLANNER_URL=http://127.0.0.1:3003 \
FRAMELEAF_ASSISTANT_QUALIFICATION_REPORT=/tmp/frameleaf-assistant-qualification.json \
  pnpm --filter frameleaf test:assistant-eval

node .github/assistant-qualification.mjs /tmp/frameleaf-assistant-qualification.json "$(git rev-parse HEAD)"
```

The evaluator checks the candidate's default planner against the worker's
advertised capabilities and rejects runs with protected results or insufficient
model use. It writes the report only after all quality thresholds pass, and
requires a fresh report path. The checker accepts only qualification reports for
the specified source SHA and that commit's default planner. Its input must come
from a trusted candidate qualification run. The checker does not authenticate
the report's producer or attest to the worker image's provenance.
