# Frameleaf settings and administration preservation inventory

Status: clean-source audit at baseline `7cfa62336f394189c0450533c30618c66366d868`; no command-center redesign is qualified.

## Current composition

- `/admin/system-settings` composes 20 source sections in `web/src/routes/admin/system-settings/+page.svelte`.
- `/user-settings` composes 14 personal accordions in `web/src/routes/(user)/user-settings/UserSettingsList.svelte`; OAuth visibility is capability-dependent.
- Admin routes retain `web/src/routes/admin/+layout.ts` authorization and configuration initialization.
- Configuration-file-managed instances retain the source read-only warning and import restrictions.

The source scope matters:

| Scope                | Examples                                           | Preservation rule                                                                          |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Browser/device       | playback and display choices                       | Label as device-local; do not imply account-wide policy.                                   |
| Personal preference  | features, downloads, notifications                 | Preserve server defaults and conditional children; these are not ACLs.                     |
| Personal resource    | API keys, sessions, OAuth link, sharing            | Use the resource API and one-time secret/revocation behavior, not generic config JSON.     |
| Administrator policy | auth, ML, jobs, SMTP, trash, transcoding           | Retain admin authorization, validation, file-managed locks, and destructive confirmations. |
| External library     | owner, paths, exclusions, scans                    | Owner is immutable; do not broaden permitted filesystem paths.                             |
| Deployment/operator  | service addresses, credentials, installed runtimes | Never place secrets or editable update endpoints in ordinary settings/history/export.      |

## Administration routes

The clean baseline contains 17 `/admin` page routes: redirects, system settings, user list/create/detail/edit, external-library list/create/detail/edit, queues/list detail, maintenance/integrity detail, and server status. `/maintenance` and `/auth/onboarding` remain separate lifecycle routes and must not be collapsed into an ordinary settings modal.

## Account and access boundaries

- Administrator preference read/update endpoints exist in `server/src/controllers/user-admin.controller.ts`; users can edit the same preferences themselves. Preferences and sidebar visibility are not administrator module grants.
- `server/src/services/base.service.ts` hashes a created password but does not establish reviewed create-time PIN hashing. Keep create-time PIN unavailable until a focused server test proves the stored representation and verification path.
- Existing session deletion is owner-scoped. An administrator control for revoking another user's session needs a separately authorized endpoint and access tests.
- Account deletion delay is configuration-derived; do not hardcode a prototype duration.
- Quota, storage label, avatar color, role, password-change, restore/delete, API-key, OAuth, suppression, and sharing flows retain their source DTO validation and lifecycle rules.

## Settings migration gate

One shared draft must not pretend every section shares one backend transaction. Keep separate resource operations, secret dialogs, configuration exports, and capability probes separate. A replacement must preserve baseline/draft/reset/discard behavior, conflicts without draft loss, conditional controls, validation, and exact ownership. Current section counts are inventory sizes, not completion percentages.

Dirty-only settings coverage/prototype files were not restored. Their field counts and interaction totals remain unreviewed evidence until their source models and production adapters are reviewed together.
