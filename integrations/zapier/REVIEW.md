# Zapier beta and review checklist

This app is not published. Each step below needs the owner or Zapier and is outside this repository's CI.

## Private beta (owner)

1. Create or choose the Frameleaf Zapier developer account and run `zapier-platform register` (or `link`) from a private copy; never commit `.zapierapprc`.
2. Copy the app's exact OAuth callback from its Zapier authentication settings. On a test Library, register it in Connect setup and note the public client ID.
3. `zapier-platform push`, then invite testers to the private version only.

## Hosted qualification (owner, against a test Library over public HTTPS)

- Browser OAuth with the real callback and PKCE; confirm the resource, all seven scopes and the chosen album/workspace policy on the consent screen.
- Several Zaps sharing one connection whose access token expires together: exactly one rotation, the full replacement token pair persisted, another rotation succeeds afterwards. Repeat with a dropped refresh response and confirm the consumed token is never replayed (no grace period, no API-key fallback).
- Narrow access in Settings while a Zap is on: the next call fails as `Forbidden`. Revoke in Connected Apps: refresh fails and Zapier asks to reconnect; queued file hydrations fail.
- Each trigger, search and action with real data, including a burst of more than 1,000 events between polls, a replayed upload with the same Source ID, two simultaneous runs uploading the same source, a PDF to a Boards album and an MP4 near the size ceiling.
- Through Frameleaf relay as well as customer HTTPS.
- Native Zapier logs: no tokens, transfer URLs, filenames or media.

## Directory review (Zapier)

- Public help pages for the two auth fields (the remaining `D002` warnings), app logo and description, and a test account for Zapier's reviewers on a disposable Library.
- Explain in the submission that the server URL is user-supplied by design (self-hosted), with origin validation (`D026`), and that Source IDs and asset IDs come from earlier steps (`D004`).
- Support owner and contact for Zapier escalations.
