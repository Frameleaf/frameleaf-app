# FL-25 toolchain baseline evidence

- Baseline commit: `4bedc0c4d384f365ee5c29739ce201cc114fdd85`
- Declared pin records: **61**
- Hashed source files: **24**
- Workflow action pins: **9**
- Workflow runner labels: **4**
- Container-image declarations: **19**
- Unique tools: **21**
- Resolved/exact-pin mismatches: **3**
- Resolved locally: **3**
- Missing locally: **1**
- Deliberately not probed: **15**
- Version probes failed: **2**

## Resolved local tools

- `github:jellyfin/jellyfin-ffmpeg`: version 9.0.1 at `$PATH[4]/ffmpeg` (controlled PATH slot; comparison: **mismatch**)
- `node`: version 24.19.0 at `$PATH[0]/node` (controlled PATH slot; comparison: **mismatch**)
- `python`: version 3.9.6 at `$PATH[2]/python3` (controlled PATH slot; comparison: **mismatch**)

## Missing or unresolved tools

- `aqua:flutter/flutter`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `bundler`: **probe-failed** — [output redacted: no version token]
- `cocoapods`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `dart`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `flutter`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `github:CQLabs/homebrew-dcm`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `github:extism/cli`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `github:extism/js-pdk`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `github:webassembly/binaryen`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `gradle`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `java`: **probe-failed** — [output redacted: no version token]
- `npm:@openapitools/openapi-generator-cli`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `npm:oazapfts`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `opentofu`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `pnpm`: **present-not-probed** — Executable is present but its wrapper is not on the strict side-effect-safe probe allowlist
- `terragrunt`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed
- `uv`: **missing** — No executable found on the controlled PATH
- `wrangler`: **missing-not-probed** — Executable is absent; unsafe wrapper was not executed

## Interpretation

Declared pins come from source files verified byte-for-byte against the explicit reviewed baseline ancestor and hashed in the JSONL companion. Delivery-only commits may sit above that baseline, but any change to a covered source is rejected. Local resolution is observational: the generator does not install, update, initialize, or download tools. Probes receive only LANG, LC_ALL, NO_COLOR, and the caller-supplied controlled PATH. Evidence stores PATH-slot identities and PATH-entry digests rather than absolute paths. Missing or unprobed tools are not treated as version matches.
