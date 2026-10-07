# Server API models 33

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## StudioProjectImportDto

Related models: [StudioProjectImportKind](models-33.md#studioprojectimportkind).

```json
{
  "properties": {
    "checksum": {
      "description": "SHA-256 of the bytes, hex",
      "type": "string"
    },
    "contentType": {
      "description": "Content type read from the bytes, not the name",
      "type": "string"
    },
    "createdAt": {
      "description": "When it was uploaded",
      "format": "date-time",
      "type": "string"
    },
    "externalReferences": {
      "description": "External subresources an SVG or Lottie graphic names; a graphic with any cannot be rendered",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "fileName": {
      "description": "The name the file was uploaded with",
      "type": "string"
    },
    "id": {
      "description": "Import id; clips reference it as `importId`",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/StudioProjectImportKind"
    },
    "sizeBytes": {
      "description": "Size in bytes",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "checksum",
    "contentType",
    "createdAt",
    "externalReferences",
    "fileName",
    "id",
    "kind",
    "sizeBytes"
  ],
  "type": "object"
}
```

## StudioProjectImportKind


```json
{
  "description": "What the file is, read from its bytes",
  "enum": [
    "audio",
    "image",
    "video",
    "vector",
    "captions",
    "lut"
  ],
  "type": "string"
}
```

## StudioProjectLeaseDto


```json
{
  "properties": {
    "autosaveDebounceMs": {
      "description": "Pause in editing after which the client saves",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "expiresAt": {
      "description": "When the current lease lapses",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "heldByAnother": {
      "description": "A live lease belongs to another editor instance",
      "type": "boolean"
    },
    "heldByYou": {
      "description": "This client holds the write lease",
      "type": "boolean"
    },
    "leaseMs": {
      "description": "Lease length the server grants",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "renewMs": {
      "description": "How often the holder should renew",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "autosaveDebounceMs",
    "expiresAt",
    "heldByAnother",
    "heldByYou",
    "leaseMs",
    "renewMs"
  ],
  "type": "object"
}
```

## StudioProjectLeaseRequestDto


```json
{
  "properties": {
    "clientId": {
      "description": "Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "takeover": {
      "description": "Take a live lease away from another of your editor instances; never implicit",
      "type": "boolean"
    }
  },
  "required": [
    "clientId"
  ],
  "type": "object"
}
```

## StudioProjectListResponseDto

Related models: [StudioProjectDto](models-32.md#studioprojectdto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/StudioProjectDto"
      },
      "type": "array"
    },
    "total": {
      "description": "Matching projects, before paging",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "items",
    "total"
  ],
  "type": "object"
}
```

## StudioProjectResourcesDto

Related models: [StudioUnsupportedSourceDto](models-33.md#studiounsupportedsourcedto).

```json
{
  "properties": {
    "checkedAt": {
      "description": "When the resolution ran",
      "format": "date-time",
      "type": "string"
    },
    "complete": {
      "description": "Every referenced source resolved for the acting account",
      "type": "boolean"
    },
    "hdrProxySources": {
      "description": "FL-97: the hdrSources whose Studio HDR intermediate is ready, so the editor reads their real HDR pixels (GET /assets/{id}/video/studio-hdr). The others are being made",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "hdrSources": {
      "description": "FL-97 owner decision: placed library videos whose original is HDR (PQ or HLG transfer, or Dolby Vision). A project that places one is an HDR project. Only sources that resolved for the acting account are named",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "hiddenSources": {
      "description": "FL-195 follow-up: the owner's own library items this project places that are hidden from this session (Locked, or matched by a Locked rule, while the session is locked). The project keeps them; the editor hides their clips rather than showing missing media. The owner's only; empty for a reviewer",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "refusedCount": {
      "description": "References that were refused for the acting account",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "unsupportedSources": {
      "description": "FL-101: placed videos this server cannot decode, refused as 'unsupported-source' when admitted. The owner's only; empty for a reviewer",
      "items": {
        "$ref": "#/components/schemas/StudioUnsupportedSourceDto"
      },
      "type": "array"
    }
  },
  "required": [
    "checkedAt",
    "complete",
    "hdrProxySources",
    "hdrSources",
    "hiddenSources",
    "refusedCount",
    "unsupportedSources"
  ],
  "type": "object"
}
```

## StudioProjectRestoreDto


```json
{
  "properties": {
    "clientId": {
      "description": "Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "expectedRevision": {
      "description": "The current head; the restore appends after it",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "requestKey": {
      "description": "Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "revision": {
      "description": "The historical revision to bring back",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "clientId",
    "expectedRevision",
    "requestKey",
    "revision"
  ],
  "type": "object"
}
```

## StudioProjectRevisionDetailDto

Related models: [StudioCommandSummaryDto](models-32.md#studiocommandsummarydto), [StudioProjectEnvelopeDto](models-32.md#studioprojectenvelopedto), [StudioProjectResourcesDto](models-33.md#studioprojectresourcesdto).

```json
{
  "properties": {
    "authorId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "digest": {
      "description": "Null for a reviewer; the digest travels with the graph",
      "nullable": true,
      "type": "string"
    },
    "envelope": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioProjectEnvelopeDto"
        }
      ],
      "nullable": true
    },
    "graphBytes": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "resources": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioProjectResourcesDto"
        }
      ],
      "nullable": true
    },
    "restoredFromRevision": {
      "description": "Set when this revision restored an earlier one",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "revision": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "summary": {
      "$ref": "#/components/schemas/StudioCommandSummaryDto"
    },
    "withheld": {
      "type": "boolean"
    }
  },
  "required": [
    "authorId",
    "createdAt",
    "digest",
    "envelope",
    "graphBytes",
    "id",
    "resources",
    "restoredFromRevision",
    "revision",
    "summary",
    "withheld"
  ],
  "type": "object"
}
```

## StudioProjectRevisionDto

Related models: [StudioCommandSummaryDto](models-32.md#studiocommandsummarydto).

```json
{
  "properties": {
    "authorId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "digest": {
      "description": "Null for a reviewer; the digest travels with the graph",
      "nullable": true,
      "type": "string"
    },
    "graphBytes": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "restoredFromRevision": {
      "description": "Set when this revision restored an earlier one",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "revision": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "summary": {
      "$ref": "#/components/schemas/StudioCommandSummaryDto"
    }
  },
  "required": [
    "authorId",
    "createdAt",
    "digest",
    "graphBytes",
    "id",
    "restoredFromRevision",
    "revision",
    "summary"
  ],
  "type": "object"
}
```

## StudioProjectSaveDto

Related models: [StudioCommandEnvelopeDto](models-32.md#studiocommandenvelopedto), [StudioCommandSummaryDto](models-32.md#studiocommandsummarydto), [StudioProjectEnvelopeDto](models-32.md#studioprojectenvelopedto).

```json
{
  "properties": {
    "clientId": {
      "description": "Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "commands": {
      "description": "The canonical commands the engine applied to produce this document (FL-92). Each is checked against the catalogue and the head, and the revision summary is counted from them.",
      "items": {
        "$ref": "#/components/schemas/StudioCommandEnvelopeDto"
      },
      "maxItems": 500,
      "type": "array"
    },
    "envelope": {
      "$ref": "#/components/schemas/StudioProjectEnvelopeDto"
    },
    "expectedRevision": {
      "description": "The head this document was built on",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "requestKey": {
      "description": "Stable per attempt; a retry carries the same key",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "summary": {
      "$ref": "#/components/schemas/StudioCommandSummaryDto"
    }
  },
  "required": [
    "clientId",
    "envelope",
    "expectedRevision",
    "requestKey"
  ],
  "type": "object"
}
```

## StudioProjectSaveResponseDto

Related models: [StudioProjectLeaseDto](models-33.md#studioprojectleasedto), [StudioProjectResourcesDto](models-33.md#studioprojectresourcesdto).

```json
{
  "properties": {
    "digest": {
      "description": "Digest of the head envelope",
      "type": "string"
    },
    "lease": {
      "$ref": "#/components/schemas/StudioProjectLeaseDto"
    },
    "replayed": {
      "description": "This request key was already accepted; the earlier result is returned",
      "type": "boolean"
    },
    "resources": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioProjectResourcesDto"
        }
      ],
      "description": "FL-101: how the sources of a newly written revision resolved; absent when nothing was written, null when the resolution could not run",
      "nullable": true
    },
    "revision": {
      "description": "The head after this request",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "revisionId": {
      "description": "The revision row; null when nothing was written",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "unchanged": {
      "description": "The document equals the head, so no revision was written",
      "type": "boolean"
    }
  },
  "required": [
    "digest",
    "lease",
    "replayed",
    "revision",
    "revisionId",
    "unchanged"
  ],
  "type": "object"
}
```

## StudioProjectShelf


```json
{
  "description": "`active`, `archived` (put away, read-only) or `trashed` (restorable until `purgeAfter`)",
  "enum": [
    "active",
    "archived",
    "trashed"
  ],
  "type": "string"
}
```

## StudioProjectSort


```json
{
  "description": "`updated` newest change first, `recent` last opened first, `name` alphabetical",
  "enum": [
    "updated",
    "recent",
    "name"
  ],
  "type": "string"
}
```

## StudioProjectTrashEmptyResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Projects deleted for good",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "count"
  ],
  "type": "object"
}
```

## StudioProjectUpdateDto


```json
{
  "properties": {
    "archived": {
      "description": "Archive (read-only, off the active shelf) or bring back",
      "type": "boolean"
    },
    "name": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "spaceId": {
      "description": "Set or clear the reviewing shared space",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "thumbnailAssetId": {
      "description": "A library asset you can read, shown as the poster; null clears it",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## StudioRenderCandidateDto

Related models: [StudioExportFormat](models-32.md#studioexportformat).

```json
{
  "properties": {
    "dolbyVision": {
      "type": "boolean"
    },
    "gpuMemoryBytes": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "hdr10": {
      "type": "boolean"
    },
    "maxBitDepth": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "outputFormats": {
      "description": "Output formats whose exact writer and container this session verified",
      "items": {
        "$ref": "#/components/schemas/StudioExportFormat"
      },
      "type": "array"
    }
  },
  "required": [
    "dolbyVision",
    "gpuMemoryBytes",
    "hdr10",
    "maxBitDepth",
    "outputFormats"
  ],
  "type": "object"
}
```

## StudioRenderEvidenceDto

Related models: [MediaOperationDestination](models-15.md#mediaoperationdestination), [StudioRenderCandidateDto](models-33.md#studiorendercandidatedto).

```json
{
  "properties": {
    "candidates": {
      "description": "Per-session StudioExport proof; aggregate fields must not authorize an export",
      "items": {
        "$ref": "#/components/schemas/StudioRenderCandidateDto"
      },
      "type": "array"
    },
    "codecs": {
      "description": "Encoders and decoders qualified sessions verified",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "destination": {
      "$ref": "#/components/schemas/MediaOperationDestination"
    },
    "dolbyVision": {
      "description": "A qualified session verified Dolby Vision output",
      "type": "boolean"
    },
    "gpuMemoryBytes": {
      "description": "Largest GPU memory a qualified session verified, or null",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "hdr10": {
      "description": "A qualified session verified HDR10 output",
      "type": "boolean"
    },
    "maxBitDepth": {
      "description": "Highest bit depth a qualified session verified (8 when none said more)",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "sessions": {
      "description": "Qualified live render sessions for this destination",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "codecs",
    "destination",
    "dolbyVision",
    "gpuMemoryBytes",
    "hdr10",
    "maxBitDepth",
    "sessions"
  ],
  "type": "object"
}
```

## StudioRestoredVersionDto

Related models: [AssetRestorationMode](models-06.md#assetrestorationmode), [AssetRestorationSourceType](models-06.md#assetrestorationsourcetype), [StudioRestoredVersionUnavailable](models-33.md#studiorestoredversionunavailable).

```json
{
  "properties": {
    "assetId": {
      "description": "The library original it was made from; never replaced by it",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "available": {
      "description": "Whether it can be placed and rendered now",
      "type": "boolean"
    },
    "durationSeconds": {
      "description": "Length of a video, in seconds",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "expiresAt": {
      "description": "When the result will be removed, when it has a retention date",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "height": {
      "description": "Pixel height of the restored file",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "mediaId": {
      "description": "The media id a clip of this version carries: `restored-<restorationId>`",
      "type": "string"
    },
    "mode": {
      "$ref": "#/components/schemas/AssetRestorationMode"
    },
    "originalFileName": {
      "description": "The original’s file name, for the bin label",
      "type": "string"
    },
    "restorationId": {
      "description": "The restoration",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "restoredAt": {
      "description": "When the full result finished",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "smoothMotionFactor": {
      "description": "Frame-rate factor of a Smooth motion version",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "sourceType": {
      "$ref": "#/components/schemas/AssetRestorationSourceType"
    },
    "unavailable": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioRestoredVersionUnavailable"
        }
      ],
      "nullable": true
    },
    "upscale": {
      "description": "Upscale factor of a restoration; 1 for Smooth motion",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "width": {
      "description": "Pixel width of the restored file",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "assetId",
    "available",
    "durationSeconds",
    "expiresAt",
    "height",
    "mediaId",
    "mode",
    "originalFileName",
    "restorationId",
    "restoredAt",
    "smoothMotionFactor",
    "sourceType",
    "unavailable",
    "upscale",
    "width"
  ],
  "type": "object"
}
```

## StudioRestoredVersionUnavailable


```json
{
  "description": "Why the restored version cannot be placed",
  "enum": [
    "discarded",
    "expired",
    "not-ready",
    "locked",
    "trashed",
    "offline",
    "hidden-content"
  ],
  "type": "string"
}
```

## StudioReverseConformApplyDto


```json
{
  "properties": {
    "clientId": {
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "clientId",
    "operationId"
  ],
  "type": "object"
}
```

## StudioReverseConformEnqueueDto


```json
{
  "properties": {
    "clientId": {
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "command": {
      "properties": {
        "id": {
          "enum": [
            "job.enqueueReverseConform"
          ],
          "type": "string"
        },
        "idempotencyKey": {
          "pattern": "^[\\w.:-]{1,128}$",
          "type": "string"
        },
        "issuedAt": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "payload": {
          "properties": {
            "clipId": {
              "pattern": "^[\\w.:-]{1,128}$",
              "type": "string"
            },
            "destinationId": {
              "enum": [
                "local"
              ],
              "type": "string"
            }
          },
          "required": [
            "clipId",
            "destinationId"
          ],
          "type": "object"
        },
        "revision": {
          "maximum": 9007199254740991,
          "minimum": 1,
          "type": "integer"
        }
      },
      "required": [
        "id",
        "payload",
        "revision",
        "idempotencyKey",
        "issuedAt"
      ],
      "type": "object"
    }
  },
  "required": [
    "clientId",
    "command"
  ],
  "type": "object"
}
```

## StudioReverseConformQueuedDto


```json
{
  "properties": {
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "operationId"
  ],
  "type": "object"
}
```

## StudioReverseConformResultDto


```json
{
  "properties": {
    "browserPreview": {
      "properties": {
        "checksum": {
          "pattern": "^[a-f0-9]{64}$",
          "type": "string"
        },
        "contentType": {
          "enum": [
            "video/mp4"
          ],
          "type": "string"
        },
        "delivery": {
          "enum": [
            "authenticated"
          ],
          "type": "string"
        },
        "generatedId": {
          "pattern": "^[\\w.:-]{1,128}$",
          "type": "string"
        },
        "profile": {
          "enum": [
            "h264-main-3.2-aac-lc-v1"
          ],
          "type": "string"
        }
      },
      "required": [
        "generatedId",
        "checksum",
        "contentType",
        "profile",
        "delivery"
      ],
      "type": "object"
    },
    "clipId": {
      "nullable": true,
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "frameRate": {
      "properties": {
        "den": {
          "maximum": 9007199254740991,
          "minimum": 1,
          "type": "integer"
        },
        "num": {
          "maximum": 9007199254740991,
          "minimum": 1,
          "type": "integer"
        }
      },
      "required": [
        "num",
        "den"
      ],
      "type": "object"
    },
    "frames": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "generatedId": {
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "height": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "projectId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "sourceRevision": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "width": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "browserPreview",
    "clipId",
    "frameRate",
    "frames",
    "generatedId",
    "height",
    "operationId",
    "projectId",
    "sourceRevision",
    "width"
  ],
  "type": "object"
}
```

## StudioTimeDto


```json
{
  "properties": {
    "den": {
      "description": "Denominator",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "num": {
      "description": "Numerator; zero is the start of the sequence",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "den",
    "num"
  ],
  "type": "object"
}
```

## StudioUnsupportedSourceDto

Related models: [DecodeRefusal](models-10.md#decoderefusal).

```json
{
  "properties": {
    "assetId": {
      "description": "The library video placed in the project",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "reason": {
      "description": "Why, in plain words",
      "type": "string"
    },
    "refusal": {
      "$ref": "#/components/schemas/DecodeRefusal"
    }
  },
  "required": [
    "assetId",
    "reason",
    "refusal"
  ],
  "type": "object"
}
```

## StudioWorkspaceDto


```json
{
  "properties": {
    "engineRevision": {
      "description": "The engine revision that wrote the layout",
      "nullable": true,
      "type": "string"
    },
    "layout": {
      "additionalProperties": {},
      "description": "The engine layout as the same JSON value it was saved as (key order and spacing are not kept); null when none is stored",
      "nullable": true,
      "type": "object"
    },
    "savedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "engineRevision",
    "layout",
    "savedAt"
  ],
  "type": "object"
}
```

## StudioWorkspaceSaveDto


```json
{
  "properties": {
    "engineRevision": {
      "description": "The pinned engine revision writing it",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "layout": {
      "additionalProperties": {},
      "description": "The engine layout; stored and returned as the same JSON value (key order and spacing are not kept)",
      "type": "object"
    }
  },
  "required": [
    "engineRevision",
    "layout"
  ],
  "type": "object"
}
```

## SuppressionResponse

Related models: [SuppressionScope](models-33.md#suppressionscope).

```json
{
  "properties": {
    "personIds": {
      "description": "Person IDs to suppress from locked browsing sessions",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "petIds": {
      "description": "Pet IDs to suppress from locked browsing sessions",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "scope": {
      "$ref": "#/components/schemas/SuppressionScope",
      "description": "Whether suppression applies only to owned assets or all visible assets"
    },
    "tagIds": {
      "description": "Tag IDs to suppress from locked browsing sessions",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "personIds",
    "petIds",
    "scope",
    "tagIds"
  ],
  "type": "object"
}
```

## SuppressionScope


```json
{
  "enum": [
    "owned",
    "visible"
  ],
  "type": "string"
}
```

## SuppressionUpdate

Related models: [SuppressionScope](models-33.md#suppressionscope).

```json
{
  "properties": {
    "personIds": {
      "description": "Person IDs to suppress from locked browsing sessions",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "petIds": {
      "description": "Pet IDs to suppress from locked browsing sessions",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "scope": {
      "$ref": "#/components/schemas/SuppressionScope",
      "description": "Whether suppression applies only to owned assets or all visible assets"
    },
    "tagIds": {
      "description": "Tag IDs to suppress from locked browsing sessions",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "type": "object"
}
```

## SyncAckDeleteDto

Related models: [SyncEntityType](models-34.md#syncentitytype).

```json
{
  "properties": {
    "types": {
      "description": "Sync entity types to delete acks for",
      "items": {
        "$ref": "#/components/schemas/SyncEntityType"
      },
      "type": "array"
    }
  },
  "type": "object"
}
```

## SyncAckDto


```json
{
  "properties": {
    "ack": {
      "description": "Acknowledgment ID",
      "type": "string"
    },
    "type": {
      "enum": [
        "AlbumAssetAccessV1",
        "AlbumAssetAccessDeleteV1",
        "PartnerAssetAccessV1",
        "PartnerAssetAccessDeleteV1",
        "PinnedCollectionV1",
        "PinnedCollectionDeleteV1",
        "AssetTrashStateV1",
        "AssetTrashStateDeleteV1",
        "DuplicateGroupV1",
        "DuplicateGroupDeleteV1",
        "SharedSpaceV1",
        "SharedSpaceDeleteV1",
        "SharedSpaceMemberV1",
        "SharedSpaceMemberDeleteV1",
        "SharedSpaceAlbumV1",
        "SharedSpaceAlbumDeleteV1",
        "SharedSpacePersonV1",
        "SharedSpacePersonDeleteV1",
        "PetV1",
        "PetDeleteV1",
        "PetObservationV1",
        "PetObservationDeleteV1",
        "TagV1",
        "TagDeleteV1",
        "AssetTagV1",
        "AssetTagDeleteV1",
        "AuthUserV1",
        "AuthUserV2",
        "UserV1",
        "UserDeleteV1",
        "AssetV1",
        "AssetV2",
        "AssetV3",
        "AssetBootstrapV1",
        "AssetDeleteV2",
        "AssetDeleteV1",
        "AssetExifV1",
        "AssetEditV1",
        "AssetEditDeleteV1",
        "AssetMetadataV1",
        "AssetMetadataDeleteV1",
        "AssetOcrV1",
        "AssetOcrDeleteV1",
        "PartnerV1",
        "PartnerDeleteV1",
        "PartnerAssetV1",
        "PartnerAssetV2",
        "PartnerAssetBackfillV1",
        "PartnerAssetBackfillV2",
        "PartnerAssetDeleteV1",
        "PartnerAssetExifV1",
        "PartnerAssetExifBackfillV1",
        "PartnerStackBackfillV1",
        "PartnerStackDeleteV1",
        "PartnerStackV1",
        "AlbumV1",
        "AlbumV2",
        "AlbumV3",
        "AlbumBootstrapV1",
        "AlbumDeleteV2",
        "AlbumDeleteV1",
        "AlbumUserV1",
        "AlbumUserBackfillV1",
        "AlbumUserDeleteV1",
        "AlbumAssetCreateV1",
        "AlbumAssetCreateV2",
        "AlbumAssetUpdateV1",
        "AlbumAssetUpdateV2",
        "AlbumAssetBackfillV1",
        "AlbumAssetBackfillV2",
        "AlbumAssetExifCreateV1",
        "AlbumAssetExifUpdateV1",
        "AlbumAssetExifBackfillV1",
        "AlbumToAssetV1",
        "AlbumToAssetDeleteV1",
        "AlbumToAssetBackfillV1",
        "MemoryV1",
        "MemoryDeleteV1",
        "MemoryToAssetV1",
        "MemoryToAssetDeleteV1",
        "StackV1",
        "StackDeleteV1",
        "PersonV1",
        "PersonDeleteV1",
        "AssetFaceV1",
        "AssetFaceV2",
        "AssetFaceV3",
        "AssetFaceDeleteV1",
        "UserMetadataV1",
        "PinnedCollectionsV1",
        "UserMetadataDeleteV1",
        "SyncAckV1",
        "SyncResetV1",
        "SyncCompleteV1"
      ],
      "type": "string"
    }
  },
  "required": [
    "ack",
    "type"
  ],
  "type": "object"
}
```

## SyncAckSetDto


```json
{
  "properties": {
    "acks": {
      "description": "Acknowledgment IDs (max 1000)",
      "items": {
        "type": "string"
      },
      "maxItems": 1000,
      "type": "array"
    }
  },
  "required": [
    "acks"
  ],
  "type": "object"
}
```

## SyncAckV1


```json
{
  "properties": {},
  "type": "object"
}
```

## SyncAckV2Dto

Related models: [SyncEntityType](models-34.md#syncentitytype).

```json
{
  "properties": {
    "ack": {
      "description": "Acknowledgment ID",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/SyncEntityType"
    }
  },
  "required": [
    "ack",
    "type"
  ],
  "type": "object"
}
```

## SyncAlbumAssetAccessDeleteV1


```json
{
  "description": "Drop this album-source asset and its descriptive mirror data, preserving independently authorized sources.",
  "properties": {
    "albumId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "assetId"
  ],
  "type": "object"
}
```

## SyncAlbumAssetAccessV1

Related models: [SyncAssetV2](models-34.md#syncassetv2).

```json
{
  "properties": {
    "albumId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "asset": {
      "$ref": "#/components/schemas/SyncAssetV2"
    }
  },
  "required": [
    "albumId",
    "asset"
  ],
  "type": "object"
}
```

## SyncAlbumDeleteV1


```json
{
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumId"
  ],
  "type": "object"
}
```

## SyncAlbumSourceLinkDeleteV1


```json
{
  "properties": {
    "linkId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "linkId"
  ],
  "type": "object"
}
```

## SyncAlbumSourceLinkV1

Related models: [AlbumSourceKind](models-02.md#albumsourcekind).

```json
{
  "properties": {
    "albumId": {
      "description": "The server album the source is linked to",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "createdAt": {
      "description": "When the link was made",
      "format": "date-time",
      "type": "string"
    },
    "deviceKey": {
      "description": "The device the source id belongs to, when it is device-local",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Link ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/AlbumSourceKind"
    },
    "lastSourceName": {
      "description": "The phone name the server album last followed (the rename guard)",
      "type": "string"
    },
    "sourceId": {
      "description": "The source on the phone",
      "type": "string"
    },
    "updatedAt": {
      "description": "When the link last changed",
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "createdAt",
    "deviceKey",
    "id",
    "kind",
    "lastSourceName",
    "sourceId",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncAlbumToAssetDeleteV1


```json
{
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "assetId"
  ],
  "type": "object"
}
```

## SyncAlbumToAssetV1


```json
{
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "assetId"
  ],
  "type": "object"
}
```

## SyncAlbumUserDeleteV1


```json
{
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "userId"
  ],
  "type": "object"
}
```

## SyncAlbumUserV1

Related models: [AlbumUserRole](models-02.md#albumuserrole).

```json
{
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "role": {
      "$ref": "#/components/schemas/AlbumUserRole"
    },
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "role",
    "userId"
  ],
  "type": "object"
}
```

## SyncAlbumV1

Related models: [AssetOrder](models-05.md#assetorder).

```json
{
  "properties": {
    "createdAt": {
      "description": "Created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "description": {
      "description": "Album description",
      "type": "string"
    },
    "id": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isActivityEnabled": {
      "description": "Is activity enabled",
      "type": "boolean"
    },
    "name": {
      "description": "Album name",
      "type": "string"
    },
    "order": {
      "$ref": "#/components/schemas/AssetOrder"
    },
    "ownerId": {
      "description": "Owner ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "thumbnailAssetId": {
      "description": "Thumbnail asset ID",
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "description": "Updated at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "description",
    "id",
    "isActivityEnabled",
    "name",
    "order",
    "ownerId",
    "thumbnailAssetId",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncAlbumV2

Related models: [AssetOrder](models-05.md#assetorder).

```json
{
  "properties": {
    "createdAt": {
      "description": "Created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "description": {
      "description": "Album description",
      "type": "string"
    },
    "id": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isActivityEnabled": {
      "description": "Is activity enabled",
      "type": "boolean"
    },
    "name": {
      "description": "Album name",
      "type": "string"
    },
    "order": {
      "$ref": "#/components/schemas/AssetOrder"
    },
    "thumbnailAssetId": {
      "description": "Thumbnail asset ID",
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "description": "Updated at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "description",
    "id",
    "isActivityEnabled",
    "name",
    "order",
    "thumbnailAssetId",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncAlbumV3

Related models: [AlbumKind](models-02.md#albumkind), [AssetOrder](models-05.md#assetorder).

```json
{
  "properties": {
    "createdAt": {
      "description": "Created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "deletedAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "description": {
      "description": "Album description",
      "type": "string"
    },
    "icon": {
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isActivityEnabled": {
      "description": "Is activity enabled",
      "type": "boolean"
    },
    "kind": {
      "$ref": "#/components/schemas/AlbumKind"
    },
    "name": {
      "description": "Album name",
      "type": "string"
    },
    "order": {
      "$ref": "#/components/schemas/AssetOrder"
    },
    "parentId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "sortOrder": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "thumbnailAssetId": {
      "description": "Thumbnail asset ID",
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "description": "Updated at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "deletedAt",
    "description",
    "icon",
    "id",
    "isActivityEnabled",
    "kind",
    "name",
    "order",
    "parentId",
    "sortOrder",
    "thumbnailAssetId",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncAssetDeleteV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId"
  ],
  "type": "object"
}
```

## SyncAssetEditDeleteV1


```json
{
  "properties": {
    "editId": {
      "description": "Edit ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "editId"
  ],
  "type": "object"
}
```

## SyncAssetEditV1


```json
{
  "properties": {
    "action": {
      "description": "Edit action; future values pass through unchanged",
      "type": "string"
    },
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "Edit ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "parameters": {
      "additionalProperties": {},
      "description": "Edit parameters",
      "type": "object"
    },
    "sequence": {
      "description": "Edit sequence",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "action",
    "assetId",
    "id",
    "parameters",
    "sequence"
  ],
  "type": "object"
}
```
