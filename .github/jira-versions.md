# Planned and shipped Jira versions

Assign an owned PR a milestone named **`release: <version>`**, for example
`release: 1.2.3`. Its title's Jira keys receive a native Fix Version/s target.
Versions are product-prefixed (`Library 1.2.3`, `Cloud 1.2.3`, `iOS 1.2.3`,
`Android 1.2.3`) so shared FL issues do not conflate different products.
Library and Android accept FL keys, Cloud accepts FC, and iOS accepts FL and FIOS.
Ordinary sprint milestones and fork PRs do not write Jira.

Moving/removing a release milestone or closing an unmerged PR removes only the
automation-owned, unreleased association with no remaining tracked PR references.
Released history and associations that existed before this automation remain.
Use the same version spelling as the product release. Removing an issue key from
a PR title also clears that PR's owned plan. Rename a milestone by reassigning it
on affected PRs; GitHub milestone renames do not emit a PR milestone event.

Shipment adapters verify the product's actual distribution gate, exact source
and previous shipment before scanning commit messages for issue keys. Include
keys in squash/merge commit messages; mentioning a key only in a PR description
does not put it in the release range. For direct commits, put the key in the
commit message. Do not add keys for unrelated work.

The reporter adds versions atomically, verifies persistence, stores source/build,
channel, date and evidence in an issue property, and attaches a visible release
link. It marks the project version released only after all associations and
evidence succeed. It refuses to release a version that still contains issues
outside the shipped range: first move those deferred issues to the correct plan.
Issue workflow status and acceptance are unchanged. Retry the reporter after a
failure; do not repeat deployment just to repair Jira.

Repository secrets `JIRA_EMAIL` and `JIRA_API_TOKEN` are delivery copies from
Infisical. `JIRA_BASE_URL` is a repository variable. The Jira account needs Browse
Projects, Edit Issues, and permission to manage versions (Administer Jira or
Administer Projects). Credentials are never exposed to PR code. The planned and
shipped workflows share a queued concurrency group; GitHub queues at most 100
runs, so canceled/failed runs still need reconciliation.

## Library shipment

`Jira Library shipped version` follows a successful `Deploy production` run. It
requires the successful promotion job and a stable published release manifest
whose deployment run and source commit match. Dry runs, rollout changes,
withdrawals, candidate builds and existing publications do not produce a new
shipment. The previous stable release supplies the source boundary. If no prior
release exists, set `JIRA_RELEASE_BASE_SHA` to the reviewed pre-release commit;
an invalid prior manifest fails rather than silently falling back.

To repair a failed Jira write, dispatch `Jira Library shipped version` on main
with the original deployment run ID. No application deployment is performed.

## Tooling license

The standalone `jira-release.mjs`, `jira-plan.mjs`, their tests, and this document
were independently authored as MIT-licensed release tooling. They contain no
application code and may be reused by the proprietary Cloud/native repositories.
See `jira-tooling-LICENSE` for the license text.
