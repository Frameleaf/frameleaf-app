---
title: Server API
---

The Frameleaf Server API lets scripts and tools work with the library on your own server. It supports media uploads, albums, search, sharing and server administration.

[Browse the endpoint reference](https://frameleaf.app/docs/api/reference/) · [Read the API guide](https://frameleaf.app/docs/api/overview/) · [Download this documentation version's OpenAPI specification](/openapi.json)

## Connect securely

Use your server's address followed by `/api`, such as `https://photos.example.com/api`. Create an API key in **Settings → Access & security → API keys** and select only the permissions your integration needs. Send it in the `x-api-key` header. Your account's access rules still apply, and administration endpoints also require administrator access.

Store your key privately. Do not include it in public URLs, source repositories or browser code. Delete unused keys from the same settings page.

## Read albums

Provide `FRAMELEAF_API_URL` (including `/api`) and `FRAMELEAF_API_KEY` through your shell's environment or secret facility. This request needs `album.read`:

```bash
curl --fail-with-body \
  --header "x-api-key: $FRAMELEAF_API_KEY" \
  "$FRAMELEAF_API_URL/albums"
```

## Upload a photo

Uploads require `asset.upload` and multipart form data. Use the file's actual creation and modification times:

```bash
curl --fail-with-body \
  --header "x-api-key: $FRAMELEAF_API_KEY" \
  --form 'assetData=@photo.jpg' \
  --form 'fileCreatedAt=2026-10-01T12:30:00.000Z' \
  --form 'fileModifiedAt=2026-10-01T12:30:00.000Z' \
  "$FRAMELEAF_API_URL/assets"
```

A new upload returns `201`; a duplicate returns `200`. Use the returned asset ID for later requests. Let your HTTP client set the multipart boundary.

## Choose the right reference

The downloadable specification describes selected self-hosted endpoints for API-key integrations. It excludes Cloud services, account linking, internal worker protocols and configuration contracts that combine local and Cloud controls. Each endpoint includes its parameters, request body, response schemas and required key permission.

Match the specification's version to your installed release. `GET /api/server/version` reports the running server version. Exact response field names and enum values are preserved for compatibility.

## Handle failures

Check required fields and formats after `400`, credentials after `401`, and key permissions and account access after `403`. A `404` can mean a missing resource, inaccessible resource or a route unavailable in your release. Refresh state after `409`; respect `Retry-After` when returned with `429`.

Retry reads with a delay after temporary server errors. Before retrying a write, check whether the first request succeeded. Keep backups before automating deletion, restore or other destructive actions.
