# Frameleaf repository development

- Work only in `Frameleaf/frameleaf-app`. Never push, open pull requests, or merge against `immich-app/immich` or other upstream repositories.
- The default branch is literally `fork/main`. Verify the canonical repository and default branch before any remote write; do not infer the destination from a remote name.
- Do not push to a remote named `origin`. Use an explicitly verified Frameleaf remote, such as `frameleaf`, for authorized pushes. Historical `fork` remotes may still point to `adamtaylor152/immich`.
- Preserve existing uncommitted work. Use an isolated checkout for unrelated infrastructure changes; do not assume it includes uncommitted planning or application changes.
- Create commits only with author and committer `AJ Taylor <aj@ajtaylor.net>`. Verify both identities before committing. Do not add co-author trailers.
- Read [the development and delivery guide](docs/docs/developer/frameleaf-development.md) and the assigned Jira issue before implementation. Use `codex/FL-123-description` branch names and include the assigned `FL-123` key in commit subjects and PR titles. Pull requests target `fork/main`.
- The [implementation plan](https://heroit.atlassian.net/wiki/spaces/FR/pages/61538319) and issue acceptance criteria define feature preservation. Mock controls, route links, generated clients, and prototype checks do not establish production parity.
- Keep compatibility-sensitive API paths, storage identities, migration identifiers and official-client support intact. Do not globally replace `immich` strings.
- Do not deploy, dispatch publishing workflows, merge, or submit mobile applications unless the user has authorized that operation. Preparing and validating a PR does not qualify a production release.
