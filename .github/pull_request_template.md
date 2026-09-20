## Description

<!--- Describe your changes in detail -->
<!--- Why is this change required? What problem does it solve? -->
<!--- If it fixes an open issue, please link to the issue here. -->

Jira: https://heroit.atlassian.net/browse/FL-

<!-- Include the assigned FL-123 key in the PR title and commit subjects. Target
Frameleaf/frameleaf-app's literal fork/main branch. Describe the final behavior,
then record reproducible evidence and any acceptance criteria still outstanding. -->

<!-- Follow .agents/skills/frameleaf-deploy-release/SKILL.md. Commands must be in
actual Git commit messages; text in this PR body does not execute Smart Commits.
Record verified delivery below. Before an authorized squash merge, replace the
default concatenated commit messages so old commands are not replayed. -->

Jira Smart Commit evidence: <!-- Commit SHA and resulting Jira comment ID/link for each included issue; state if delivery is still pending. -->

## How Has This Been Tested?

<!-- Please describe the tests that you ran to verify your changes. Provide instructions so we can reproduce. Please also list any relevant details for your test configuration -->

- [ ] Test A
- [ ] Test B

<details><summary><h2>Screenshots (if appropriate)</h2></summary>

<!-- Images go below this line. -->

</details>

<!-- API endpoint changes (if relevant)
## API Changes
The `/api/something` endpoint is now `/api/something-else`
-->

## Checklist:

- [ ] I have carefully read CONTRIBUTING.md
- [ ] I have performed a self-review of my own code
- [ ] I have made corresponding changes to the documentation if applicable
- [ ] I have no unrelated changes in the PR.
- [ ] I have confirmed that any new dependencies are strictly necessary.
- [ ] I have checked the assigned Jira acceptance criteria and documented remaining limitations.
- [ ] I have verified the Smart Commit result in Jira, separately from issue-key linking.
- [ ] I have preserved ownership, privacy, original media and compatibility where affected.
- [ ] I have written tests for new code (if applicable)
- [ ] I have followed naming conventions/patterns in the surrounding code
- [ ] All code in `src/services/` uses repositories implementations for database calls, filesystem operations, etc.
- [ ] All code in `src/repositories/` is pretty basic/simple and does not have any immich specific logic (that belongs in `src/services/`)

## Please describe to which degree, if any, an LLM was used in creating this pull request.

...
