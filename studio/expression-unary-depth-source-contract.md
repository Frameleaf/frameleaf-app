# Unary parser depth correction (FL-100)

This bounded packet fixes unary `+`/`-` recursion bypassing the existing nesting
guard. It does not qualify the entire expression sandbox or imported-graph
review. Patch 0053 was reserved by the root owner; no other engine patch changes.

Read-only audit base: `7280f492087b16bf864c6eabf61f9ec92a0e122a`.
Immutable original Freecut revision:
`4d62e8082c5eb387a96275bcbd323d28f6e41a62`; archive SHA-256:
`b4224e5c219a6302586cbe2242e9e6d299dfd1878f1fcd0f2d77ea3db12a5d32`.
The selected original `src/features/keyframes/utils/property-expression.ts`
has SHA-256 `bf900ab7304157cc7f22f90bc9f092cdb2d4e91fbe90ae74a83959ca4bbbc497`.
It was read with `tar -xOf`; no local preparation or patch application occurred.

Across the 52 reviewed patches, only 0022 changes this parser. Its SHA-256 is
`35d020c532ccac245a8853ea5a304e694df21236c05dcb7367707e641a8302a9`.
It adds a shared 64-expression evaluation budget, passes that budget into
reference resolution and retains cached frame/property references. It does not
change unary recursion, tokenization, builtin calls or primary depth checks.
0010 changes resolver error propagation; 0022 carries the budget through scalar
and vector references and inspector callbacks. 0027 changes effect animation
clock stamping, and 0037 changes canvas opacity; neither changes parser bounds.

Genuine b937 adapted inventory
`/tmp/fl177-b937-source-inventory.json` records parser SHA-256
`df17c6ffe55938e4c068a0ae6eb99409edbf088fd63c03d3f6daa4afa8ab6129`
and resolver SHA-256
`9bd39fd3a55c5f6e29c2b542f4494770c9b188be2c3b343d5cea14941d16b127`.
These are historical adapted inventory receipts, not complete local adapted
files and not evidence for the newly patched source. Original and adapted bytes
are different. A new genuine hosted preparation receipt is required for 0053.
The canonical `sourceSha256` intentionally remains unchanged; preparation must
refuse its stale digest until the root reviews and records that new receipt.

Original source anchors:

| Original lines | Actual contract |
| --- | --- |
| 40–42, 132–147 | Source limit 2048 UTF-16 code units; at most 512 scanned tokens, followed by EOF |
| 229–237, 277–279 | Primary nesting is checked against 64 and unwound with `finally` |
| 265–275 | Unary signs recursively call `parseUnary` without the depth guard |
| 179–196, 306–312 | Arithmetic builtin whitelist and explicit value/frame/time identifiers |
| 333–343 | Property references use the host-supplied resolver |
| 366–379 | Evaluation error returns the unchanged pre-expression value and error text |

The parser evaluates directly; it does not build an AST. No separate AST-depth
guarantee is claimed. A 65-sign expression plus `1` is only 66 code units and
66 tokens and currently reaches primary depth one. This bypass is still bounded
by the token limit; no unbounded exploit or observed runtime failure is claimed.

0053 wraps only recursive sign children in `withDepth`. The primary leaf keeps
its existing count: 63 signs plus a leaf use depth 64; 64 signs plus a leaf refuse
with `Expression is too deeply nested`. Groups, function arguments and vector
leaves share this same depth counter. Sibling expressions unwind it normally.
Valid arithmetic and component-wise vectors retain their meaning. Source length,
token count, evaluation budget, cached references and cycle/error behavior stay
in place. Compose and stored expressions are preserved.

The authored regression uses the actual evaluator and resolver: exact positive
and negative boundaries, mixed signs, groups/calls/vectors, sibling unwinding,
source/token refusals, scalar/vector dependency refusal, actual transform fallback
and valid follow-up reference resolution. It asserts authored expressions remain
unchanged. Existing 0010/0022 fixtures remain intact. These are executable hosted
regressions; none has been run locally and no baseline failure or pass is claimed.

The interpreter exposes no arbitrary JavaScript evaluation or filesystem,
network or credential builtin. That source fact does not certify host resolver
callbacks, aggregate graph size, whole-frame work or physical runtime limits.
The 64 dependency evaluations and individual parser bounds do not establish an
absolute wall-clock or process-memory guarantee across an entire imported graph.

At the audit base, canonical `property.setExpression` lines 1638–1652 invokes
the evaluator using stand-in values and frame zero for command admission. This
performs arithmetic; calling it merely a parse is inaccurate. It does not prove
that imported graph review executes expressions, and does not prove nonexecution
there. Import/review routes need a separate bounded audit and regression before
that Jira acceptance gate can close. No route or admission policy is changed by
0053. GitNexus cannot locate the parser/evaluator symbols: graph risk is UNKNOWN.
