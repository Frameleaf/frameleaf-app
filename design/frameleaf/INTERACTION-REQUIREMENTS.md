# Frameleaf interaction requirements

Preserved user decisions from the design engagement. These requirements take precedence over earlier screenshot details. Production parity is still tracked separately.


- The left navigation rail must collapse to icons, preserving access to every destination and remembering the preference.
- People views must use face photographs. Use smaller versions in person pickers and active filter chips, not generic person icons when a photo is available.
- Search and filtering must reflect the fork's existing smart, filename, description, OCR and full-path search plus its structured people, date, location, camera, tag and media-state filters. Preserve scoped queries and show contextual result counts.
- Long filter dropdowns (places, cameras, lenses and similar choices) must support autocomplete search as well as opening the full option list, with keyboard navigation and contextual counts.
- Keep navigation section titles clear of their dividers, with consistent padding above/below each heading; leave breathing room above the collection search bar.
- Keep the selected restrained three-pane design; maintain dark/light and touch/keyboard quality when refining it.
- Normal preview must fill the browser window. The viewport review page defaults to Fill window; fixed desktop/tablet/phone frames are explicit review choices. Return to the full-page app after responsive QA.
- Settings should be a command center: version/build, disk capacity, recovery readiness, processing, and actionable issues on its homepage. Move these system details out of the library rail.
- Include a rich analytics destination with useful photographic and home-server metrics, clear units/scopes/time windows, graphs, data tables, and export. Keep logical asset bytes, physical originals, and whole-filesystem usage distinct.
- Reimagine all settings around user tasks, not the upstream accordion order. Preserve the fork's complete capabilities and privacy policies; mark proposed behavior honestly. Keep personal, Space, server, and device scopes clear.
- Release/version checks to infrastructure owned by Frameleaf or the operator are allowed, whether LAN-hosted or internet-hosted. External/upstream checks and external telemetry remain prohibited. Update service addresses are managed by Frameleaf deployment/build configuration, never editable or exposed as a user setting. Never invent an endpoint or silently fall back externally. Local analytics collection is separate from outbound reporting.
- Product copy is written for customers. Do not say “fork”, expose source identifiers, or narrate implementation plans in menus, labels, help, or dialogs. Keep developer caveats in the documentation, with a compact preview/sample-data disclosure for this prototype.
- The settings prototype design round is implemented; production integration remains pending. Read [the current settings handoff](https://heroit.atlassian.net/wiki/spaces/FR/pages/61374807/Frameleaf+settings+work+handoff) before continuing; it records completed checks and remaining production qualification.
- The second settings pass must model multiple independent accounts and owned libraries. Scope analytics by account/library while retaining whole-host capacity; do not reuse a single-user total everywhere.
- Use nested settings pages and area directories, with rich operational tools for users, libraries, jobs and utilities. Every source setting/action needs a traceable home; do not equate a link or readonly explanation with implemented action parity.
- All queue concurrency edits must use the central settings draft/review. Keep source queue-specific action constraints, fixed concurrency and owner scopes explicit.
- Fold the original utilities into the command center and redesign their actual review workflows. Never treat unsupported RAW as confirmed damage or resolve a partially filtered duplicate group.
- Duplicate review must support thousands of groups with immediate, undoable decisions, automatic advance, keyboard shortcuts and bulk actions. Do not interrupt routine keeper or stack decisions with confirmation popups.
- Duplicate groups can contain many related burst frames. Use a contact sheet with multiple keepers and preserve complete group membership through filters. Offer stacking without deletion; do not treat similar burst frames as disposable duplicates or include them in automatic suggested-keeper bulk deletion.

- Trash belongs in the settings rail as an actual owner-only asset browser, with quick restore, selected/all operations and deliberate permanent-delete confirmation. Connect it to duplicate and utility deletion state.
- Do not add repeated generic scope/permissions banners under settings headings (Resource settings, Signed in as, original-owner boilerplate, All utilities). Use breadcrumbs/account selection and contextual action feedback; keep forms focused on their controls.

- Duplicate review is private to the signed-in user, including photos, thumbnails, filenames, group counts, search, suggestions and bulk actions. Do not show other accounts’ groups as read-only. Remove account switching from this workflow; omit ambiguous mixed-owner groups and unscoped activity history.
- User administration must include per-account feature preferences, separate navigation visibility, notifications, downloads, appearance, storage and sign-in configuration. Audit the actual source contracts; existing feature preferences are user-editable and are not administrator-enforced module permissions. Do not imply that hiding a feature revokes data/API access. Preserve independent account state, private-content choices, pending drafts and revision checks. Read [the account settings audit](https://heroit.atlassian.net/wiki/spaces/FR/pages/61407287/Frameleaf+account+settings+audit) before production integration.

- Locked is a filtered timeline of media marked sensitive/Locked, not a destination that relocates assets. Preserve album memberships and original organization. The current backend uses NSFW/sensitive flags and can exclude marked media while the session is locked; document those source semantics. Use neutral Locked wording in the new UI, and do not invoke the upstream move-to-Locked visibility action for this workflow.
- Do not put Duplicate review, Large files, or Live Photo pairing under Tools in the library rail. They remain under Settings → Utilities.
- Restore the existing Explore discovery experience, Best Photos and collection slideshow. Timeline appears before Browse and Work. Single-click media opens a full-size viewer with information, favorite, sharing, editing, trash and More actions.

- The media actions must be named **Mark Sensitive** and **Unmark Sensitive**. Locked remains the name of the filtered destination/session control; marking is metadata, never an asset relocation.

- Timeline day groups must fill the available photo area, including groups with fewer thumbnails than the maximum column count.
- Preserve Information → People → Add → draw a face region → assign an existing or new person. Keep face photos in the information panel, people views, and filters, with keyboard/numeric alternatives to drawing.
- A route or settings inventory is not feature parity. Track every source screen and action, its redesigned home, implementation status, and validation. Do not remove existing production screens until their required actions pass parity checks. Read the screen and library-action parity audits linked in the handoff; both explicitly record remaining gaps.
