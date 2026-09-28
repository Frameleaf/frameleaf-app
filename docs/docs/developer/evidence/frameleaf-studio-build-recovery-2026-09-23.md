# FL-84 / FL-85 / FL-86 Studio build recovery

Recovered the existing PR #130 / #133 implementation from `0a042d249039a1eb706ed7ede96348707569c4d5` onto integration `fbbdc7970eca748fef793e04ec1847660a73c9d3`. This is local recovery evidence, not a production integration, distribution approval or full Studio qualification.

## Source and scope

- Restored the isolated package, stable worker source-map and deferred profiler DOM patches, plus the later default-deny resource-admission patch. Preserved the exact source patch bytes, engine lockfile, build identity, conformance overlay, notice captures and rights evidence from PR #133.
- Restored preparation, attestation, independent attribution audit, conformance and resource-policy tools; the dedicated read-only engine workflow; and the existing conformance step in the current test workflow.
- Preserved all existing fields in `dependency-attribution.json`; the recovered manifest adds the original resource and notice evidence. The immutable Freecut provenance and feature manifest remain byte-identical to both source and integration.
- Reconciled `studio/README.md` with the current FL-88 host, FL-90 resource and FL-92 command sections. Production web/server code, the adapter boundary, resource inventory and command catalogue are unchanged.
- Verified Jira FL-84, FL-85 and FL-86 are In Progress and assigned to AJ Taylor; read their latest comments before editing. All remain unqualified. Root owns Confluence reconciliation and hosted CI; this recovery does not rewrite historical mirror receipts.

The reused implementation includes `6542d481f4`, `a7882dcf7d`, `48d5fc71a8`, `d9ac0451a2`, `56ed517202`, `bd9d7f72ca`, `2972799ba0`, `b349ed856d`, `42ea135f89` and `c43f87ce1d`. No previously reported measurements are promoted to current acceptance.

## Local validation

Used Node **24.21.0** and an isolated npm **11.8.0** installation. Dependency installation used `npm ci --ignore-scripts --no-audit --no-fund` only in the generated engine workspace.

- Existing recovery, attribution, conformance and preservation tests: **15/15 passed**.
- Current workflow contracts: **13/13 passed**, including read-only credentials, pinned actions and inline shell syntax.
- Fresh preparation verified all **2,646** original files and reproduced **2,652** adapted inputs with source digest `3d889096898ce322599190e34193d9a4fd4ec62cf1227f1fb773d4cd57bd73c3`.
- One isolated production build passed on macOS arm64. Attestation covers **1,030** artifacts with digest `8f9ca444932e0308346e49fff2f55aa996955cf59b64551e515cd271e83264ff` and **584** dependency license records.
- Independent artifact attribution audit passed: **186** notices, **210** resource decisions and **8** unresolved package notices. Distribution approval remains false. The attribution index digest is `18f640bd24cbf097c3def4b974143ca765bc4051a91cb57cf0be659d4392ec78`.
- The recovered deferred profiler regression and adjacent tests: **4/4 passed**. Existing Node headless contracts: **43/43 passed**.
- Post-build vendor verification passed for all **2,646** immutable files.
- Conformance validation reports **210** rows, **1,332** fixture cases, **0** passed axes, **0** qualified rows and `releaseQualified: false`.

The build emitted upstream dynamic-import/chunk and Tailwind source-map warnings. There was no second local build, so this run does not establish fresh two-build reproducibility; the restored hosted workflow retains that gate. Full upstream unit, browser/media/GPU, offline lifecycle and application integration suites were not run in this recovery. No model weights were separately acquired, and the eight package-notice gaps and blocked rights decisions remain unchanged.

## Impact and review boundary

GitNexus impact lookup could not resolve the absent recovered tool files and returned UNKNOWN. Manual caller tracing follows `engine.mjs` through policy/attribution helpers, the fixture checker, the isolated generated engine and the dedicated workflow. Conformance reads the current ownership ledger and runs under the test workflow. The restored resource admission module is copied only into the generated workspace; no production web/server import was added.

Pre-commit `detect_changes` reports 96 changed files and LOW risk, but resolves no changed symbols in the older index; this is partial evidence, supplemented by the manual trace and exact PR #133 byte comparison. The edited README, workflow and recovery note pass formatting and whitespace checks. Full-diff whitespace checking flags original whitespace in hash-bound license/model-card captures and versioned patch context; those recovered bytes are deliberately unchanged.

Independent root review approved candidate `1574d985ad560501a21c166eb09bc4502d11a956`, integrated at `08706048aa`. The review traced source immutability, path and artifact attestation, resource admission, conformance gates and the read-only hosted workflow. The integration reran all 15 tooling contracts and 13 workflow contracts successfully. Generated vendor, engine, dependency and build artifacts remain ignored local evidence, not committed distribution payloads.

The complete Studio README source matches Confluence page61408007v6 after decoded HTML readback; the full prior page history remains preserved. The recovered rights source matches the existing page61997196v6, so its identity was restored without rewriting the remote page. These receipts qualify source preservation only: the eight package notices, 210 blocked resources, zero qualified conformance rows and production-adapter boundary remain unchanged. At published integration head `8944f8be77`, the 20:00 UTC snapshot had 32 successful checks, three skips and three running jobs; final hosted acceptance remains pending.

The original recovery commit had issue keys but no Smart Commit commands for FL84, FL85 or FL86. Their absent new Jira comments were therefore not evidence of an ingestion failure. The documentation milestone recording this completed review and mirror reconciliation carries the first progress commands for those issues; delivery must be checked after publication. FL29's original recovery command was verified as Jira comment34522. All four issues remain In Progress.
