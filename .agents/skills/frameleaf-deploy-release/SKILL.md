---
name: frameleaf-deploy-release
description: Use when preparing Frameleaf work that will ship through a pull request, committing or updating a PR, resolving CI, recording Jira delivery, or handling an authorized merge, container publication, release, or deployment.
---

# Frameleaf delivery and release

Announce that you are using this skill. Read [AGENTS.md](../../../AGENTS.md) and the relevant sections of the [delivery guide](../../../docs/docs/developer/frameleaf-development.md). This skill adapts HeroNet's delivery discipline to Frameleaf; the repository guide defines Frameleaf's runtime, review and authorization rules.

## Establish the work

- Use `Frameleaf/frameleaf-app`, literal default branch `fork/main`, and the explicitly verified `frameleaf` remote. Never push to `origin`, the former owner, or upstream.
- Read and claim every assigned `FL-` issue before implementation. Discover live transitions; do not copy HeroNet's IDs or its `NEEDS REVIEW` status. An existing assigned PR/worktree can be continued. For new work, fetch the verified default branch immediately before creating a worktree from its exact SHA.
- Use author and committer `AJ Taylor <aj@ajtaylor.net>` without coauthor trailers. Preserve unrelated working-tree changes.
- For UI work, also follow the [committed design handoff](../../../design/frameleaf/README.md). A prototype is not implementation acceptance.

## Smart Commits are required, not just issue links

A key in a branch, PR title or commit message links development activity. It does not execute a Jira action. Commands belong in the **actual Git commit message**; putting an example in a PR description does not run it.

Before committing an implementation or delivery milestone:

1. Include the assigned key in the commit subject and add a concise `#comment` line for each issue that this commit advances. Keep each complete command on one physical line, with its issue key before the command. Describe completed work accurately and identify unfinished qualification when relevant.
2. Use a message file with real newlines (`git commit --file <message-file>`); do not rely on shell interpolation or escaping. For example:

   ```text
   docs: FL-118 FL-25 document delivery and design handoff

   FL-118 #comment Added delivery instructions and CI corrections in https://github.com/Frameleaf/frameleaf-app/pull/112; hosted checks remain pending.
   FL-25 #comment Preserved the reusable design template and agent entry point in https://github.com/Frameleaf/frameleaf-app/pull/112; the wider implementation baseline remains open.
   ```

   Use the real issues, PR and outcome for the current task. Never send generic placeholder commands or create empty commits just to generate Jira activity.
3. Check the resulting message and both identities with `git show -s --format=fuller HEAD` before push. A key-only subject is not a substitute for the command body. This user-requested delivery workflow authorizes concise issue progress comments; unrelated messages remain outside its scope.
4. After push, verify the comment in the issue's actual activity/comments, not only the Development panel. Record the commit SHA and resulting Jira comment ID/link. If delivery is delayed, allow at most two further read-only checks while doing useful CI work, including one after checks finish. If still absent, inspect the connection and matching identity once and report the precise unverified/blocked integration outcome separately from code/CI status, with the needed next action. Do not duplicate the comment through another API, create empty commits, or rewrite/re-push messages repeatedly. Do not change account privacy, credentials or global automation to hide the failure.

Use `#time` only for actual, authorized time entries; never estimate or invent work logs. Discover the current workflow before using a transition command: the syntax is `#<transition-name>`, with hyphens for spaces, not a literal `#transition` followed by a status. Do not place completion commands in PR titles, feature-branch commits or pre-merge messages: pushes can process them before review/merge. Claim work through Jira before coding, and perform the verified post-merge Done transition through the Jira API when its acceptance is satisfied. Do not make empty closure commits.

The installed GitHub for Atlassian connection and matching Jira/GitHub identity must actually process the command. An installed app, a passing title check or a linked commit alone does not prove this. References: [Smart Commit syntax](https://support.atlassian.com/jira-software-cloud/docs/process-issues-with-smart-commits/) and [GitHub integration troubleshooting](https://support.atlassian.com/jira-cloud-administration/docs/github-integration-faq/).

## PR and CI ownership

- Use a `codex/FL-123-description` branch and every included issue key in the human-readable PR title. Target `fork/main`. State the final behavior, evidence, migration/rollback implications and outstanding acceptance. Record Smart Commit delivery evidence separately from ordinary Jira links.
- Apply the repository's independent review contract to privacy, data integrity, migrations, concurrency, cloud costs and publication authority. Review the exact candidate and callers before pushing risk-bearing changes. Fix P0/P1/P2; recheck substantive deltas. Read existing bot feedback without waiting for optional bots.
- Own CI until the current head passes. Read raw failed job logs; fix repository errors without weakening gates. Retry proven infrastructure failures a bounded number of times after their cause clears. A registry pull failure before tests is not a failed assertion or evidence that tests passed.
- Hosted current-head checks are authoritative; focused local checks are allowed. Track the PR head and tested merge SHA. Preserve all protected checks, integration and official-container round trips. Do not copy HeroNet's local-test ban or Ubicloud assumptions.
- Keep unfinished work draft with explicit missing gates. A completed, qualified slice becomes ready for review. Jira stays In Progress until authorized merge and issue-specific acceptance; a ready PR does not mean Done.

## Squash, merge and release

Before an authorized merge, read the repository's current `squash_merge_commit_title` and `squash_merge_commit_message` settings and inspect the proposed final message. Frameleaf currently uses `PR_TITLE` and `COMMIT_MESSAGES`; concatenating the branch messages can replay Smart Commit commands under the new squash SHA.

Supply an explicit, reviewed squash message instead of replaying command history. Retain every assigned issue key and, if recording a new merge milestone, use one fresh accurate `#comment` per issue. Do not replay prior `#time` or transition commands. Before invoking merge, verify the chosen method can satisfy the repository's author/committer policy: local Git configuration does not control GitHub-generated merge metadata, and web merges may use a GitHub committer. Resolve any conflict before merge without weakening identity policy or bypassing branch protection. Verify the resulting identities and actual Jira outcome afterward. Reconcile any prior-command duplication rather than silently treating it as new work. See [GitHub's metadata restrictions](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#metadata-restrictions).

A request to prepare/update a PR does not authorize merge or publication. Reuse explicit session authorization within its scope. Merging to `fork/main` can automatically publish containers and promote stable tags, so resolve that authorization before invoking merge. Never merge solely to satisfy this skill's completion checklist.

For an authorized release, follow the [build/release flow](../../../docs/docs/developer/frameleaf-development.md#build-and-release-flow): exact-SHA integration and round-trip gates, owned `ghcr.io/frameleaf` images, candidate manifests/platforms/source revisions, stable promotion and matching release assets. CLI publication is separately opt-in. Keep original storage/service/database identities and official-client compatibility intact. Local/Compose/Unraid and local/LAN workers remain supported; RunPod is explicit. Do not import HeroNet's Kubernetes endpoint, Jira-Version-before-tag format, secrets or deployment workflow.

After authorized merge, verify GitHub reports MERGED, record the merge SHA, verify issue acceptance, then transition eligible issues to Done and read back the result. Container publication, deployed health and application/media qualification are distinct evidence. Clean up only owned, clean worktrees and branches.

## Finish with evidence

- Correct repository/base/head and reviewed candidate; actual PR state and current checks.
- Smart Commit message/SHA and verified Jira outcome for each affected issue; any ingestion failure stated explicitly.
- Source-backed Confluence mirrors updated and read back under the standing mirroring request.
- Merge/publication/deployment evidence only for actions actually authorized and performed.
- Outstanding parent acceptance retained; a design slice does not close a wider implementation ticket.

When only PR preparation was requested, a ready PR with passing checks and verified Jira evidence is the completion point; stop for the user's next instructions. If an external Smart Commit failure remains after the bounded verification above, report the ready code/CI state and the specific integration blocker without claiming full delivery verification. When merge/release was authorized, continue through that operation and its verification. Do not leave fixable failures or pending checks as a claimed completion.
