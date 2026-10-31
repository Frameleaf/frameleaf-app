---
title: Pinned collections API
---

`GET /users/me/pins` returns the account's complete ordered pin list. `PUT /users/me/pins` replaces that list, allowing clients to add, remove and reorder entries in one save. Both endpoints require an authenticated user session; shared links and API keys cannot read or edit pins.

Each entry has a client-selected opaque UUID `id`, a `kind` (`album`, `smart-album`, `saved-search`, `person`, `pet`, `memory` or `builtin`) and a `targetId`. Domain targets use their UUIDs, saved searches use their existing preference name, and built-ins use `favourites`, `photos`, `videos`, `live-photos`, `archive`, `locked` or `recently-deleted`. A list may contain up to 50 entries, with unique pin IDs and unique targets. Album and smart-album references to the same album count as one target.

The response contains `revision` and `pins`. Send that revision as `expectedRevision` when saving. A new list has a null revision; an empty existing list still has a revision. Each write checks the revision atomically within the account's metadata row. A conflicting save returns HTTP 409 and must reload before retrying. A non-null stale revision cannot recreate a deleted row.

Every read rechecks access through the existing collection and search services. Available pins contain current `title`, `count`, `coverAssetId` and `countCapped`. Semantic saved-search counts retain the existing smart-search cap and report `countCapped: true` when capped. Counts and covers obey the same search predicate, including legacy filename, checksum, path and shared-album filters. Search pagination saved in preferences does not narrow the pin summary.

When a target is deleted, suppressed or inaccessible, its pin remains in the user's order with `unavailable: true`. `targetId`, `title`, `count` and `coverAssetId` are null, and `countCapped` is false. Clients must clear previously hydrated data. Such a pin can be removed or reordered by submitting its opaque `id`, original `kind` and null `targetId`; the server resolves that identity only from the same account's existing list. Creating a new inaccessible target is rejected. Operational failures propagate instead of being represented as missing collections.

## Replacement sync contract

Request `PinnedCollectionsV1` through the existing sync endpoint. Each request emits one `PinnedCollectionsV1` entity containing `userId`, `revision` and the complete ordered `pins` snapshot, followed by the normal completion entity. Its acknowledgement uses the existing stream checkpoint protocol.

This entity replaces the client's entire pins mirror, including an empty list. An acknowledgement or unchanged pin revision never suppresses current access checks: the next request still replaces hydration after sharing is revoked, a target is deleted or the session loses Locked access. Clients must apply unavailable entries by clearing all previously hydrated fields.

This aggregate snapshot covers pin creation, updates, removal and access loss. Its wire shape is unchanged. Private pin references stored in account metadata are excluded from `UserMetadataV1`, so older clients do not receive inaccessible target identities or an unknown metadata key. Clients must explicitly request and implement this replacement entity before using pins sync.

## Per-pin events

Clients may instead request the additive `PinnedCollectionEventsV1` stream. `PinnedCollectionV1` upserts carry the currently authorized pin hydration and its `position` in the complete ordered list. Unavailable entries leave position holes. `PinnedCollectionDeleteV1` carries only the opaque `pinId`; it clears that source's available mirror hydration without removing the user's stored pin.

The server rechecks hydration before delivery. Reordering, changes to title/count/cover, access loss and regrant produce events even when the stored list revision is unchanged. Acknowledgements use the exact delivered event ID and entity type; retries and partial resume retain delivery order. Operational hydration failures propagate rather than becoming false revocations. The original replacement request remains available for complete lists, including sanitized unavailable placeholders.
