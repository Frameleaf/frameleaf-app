# Server API models 35

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## StudioProjectCreateDto

Related models: [StudioProjectEnvelopeDto](models-35.md#studioprojectenvelopedto).

```json
{
  "properties": {
    "clientId": {
      "description": "This editor instance; it receives the lease",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "envelope": {
      "$ref": "#/components/schemas/StudioProjectEnvelopeDto",
      "description": "An initial document, saved as revision 1"
    },
    "name": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "requestKey": {
      "description": "Owner-scoped idempotency key for project creation; reuse requires the same payload",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "spaceId": {
      "description": "Share the project with a shared space for review",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "clientId",
    "name"
  ],
  "type": "object"
}
```

## StudioProjectDetailDto

Related models: [StudioProjectAccess](models-34.md#studioprojectaccess), [StudioProjectEnvelopeDto](models-35.md#studioprojectenvelopedto), [StudioProjectLeaseDto](models-35.md#studioprojectleasedto), [StudioProjectResourcesDto](models-35.md#studioprojectresourcesdto), [StudioProjectShelf](models-35.md#studioprojectshelf).

```json
{
  "properties": {
    "access": {
      "$ref": "#/components/schemas/StudioProjectAccess"
    },
    "archivedAt": {
      "description": "When the owner archived it",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "deletedAt": {
      "description": "When it was moved to the trash",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "digest": {
      "description": "Key-sorted SHA-256 of the head envelope; null when withheld",
      "nullable": true,
      "type": "string"
    },
    "duplicatedFromId": {
      "description": "The project this one was duplicated from; null for a reviewer",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
    "id": {
      "description": "Studio project ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "importedFromBundle": {
      "description": "The project was read in from a portable bundle; always false for a reviewer",
      "type": "boolean"
    },
    "lastOpenedAt": {
      "description": "When an editor last opened it; null for a reviewer",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "lease": {
      "$ref": "#/components/schemas/StudioProjectLeaseDto"
    },
    "name": {
      "type": "string"
    },
    "ownerId": {
      "description": "The only account that may write",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "purgeAfter": {
      "description": "When a trashed project is deleted for good; its library media is never touched",
      "format": "date-time",
      "nullable": true,
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
    "revision": {
      "description": "Head revision number; 0 until the first save",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "shelf": {
      "$ref": "#/components/schemas/StudioProjectShelf"
    },
    "spaceId": {
      "description": "Shared space whose members may review the project",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "thumbnailAssetId": {
      "description": "Library asset the owner chose as the poster; null for a reviewer",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    },
    "withheld": {
      "description": "The graph was withheld because a source is unavailable to you",
      "type": "boolean"
    }
  },
  "required": [
    "access",
    "archivedAt",
    "createdAt",
    "deletedAt",
    "digest",
    "duplicatedFromId",
    "envelope",
    "id",
    "importedFromBundle",
    "lastOpenedAt",
    "lease",
    "name",
    "ownerId",
    "purgeAfter",
    "resources",
    "revision",
    "shelf",
    "spaceId",
    "thumbnailAssetId",
    "updatedAt",
    "withheld"
  ],
  "type": "object"
}
```

## StudioProjectDiffDto

Related models: [StudioCommandSummaryDto](models-34.md#studiocommandsummarydto).

```json
{
  "properties": {
    "added": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "byteDelta": {
      "description": "Size change of the serialized graph",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "changed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "commands": {
      "$ref": "#/components/schemas/StudioCommandSummaryDto",
      "description": "Commands the saves between the two revisions reported"
    },
    "from": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "identical": {
      "description": "The two envelopes have the same digest",
      "type": "boolean"
    },
    "paths": {
      "description": "Changed graph paths, aggregated and capped",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "removed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "to": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "truncated": {
      "description": "More paths changed than are listed",
      "type": "boolean"
    }
  },
  "required": [
    "added",
    "byteDelta",
    "changed",
    "commands",
    "from",
    "identical",
    "paths",
    "removed",
    "to",
    "truncated"
  ],
  "type": "object"
}
```

## StudioProjectDto

Related models: [StudioProjectAccess](models-34.md#studioprojectaccess), [StudioProjectLeaseDto](models-35.md#studioprojectleasedto), [StudioProjectShelf](models-35.md#studioprojectshelf).

```json
{
  "properties": {
    "access": {
      "$ref": "#/components/schemas/StudioProjectAccess"
    },
    "archivedAt": {
      "description": "When the owner archived it",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "deletedAt": {
      "description": "When it was moved to the trash",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "duplicatedFromId": {
      "description": "The project this one was duplicated from; null for a reviewer",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "Studio project ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "importedFromBundle": {
      "description": "The project was read in from a portable bundle; always false for a reviewer",
      "type": "boolean"
    },
    "lastOpenedAt": {
      "description": "When an editor last opened it; null for a reviewer",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "lease": {
      "$ref": "#/components/schemas/StudioProjectLeaseDto"
    },
    "name": {
      "type": "string"
    },
    "ownerId": {
      "description": "The only account that may write",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "purgeAfter": {
      "description": "When a trashed project is deleted for good; its library media is never touched",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "revision": {
      "description": "Head revision number; 0 until the first save",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "shelf": {
      "$ref": "#/components/schemas/StudioProjectShelf"
    },
    "spaceId": {
      "description": "Shared space whose members may review the project",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "thumbnailAssetId": {
      "description": "Library asset the owner chose as the poster; null for a reviewer",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "access",
    "archivedAt",
    "createdAt",
    "deletedAt",
    "duplicatedFromId",
    "id",
    "importedFromBundle",
    "lastOpenedAt",
    "lease",
    "name",
    "ownerId",
    "purgeAfter",
    "revision",
    "shelf",
    "spaceId",
    "thumbnailAssetId",
    "updatedAt"
  ],
  "type": "object"
}
```

## StudioProjectDuplicateDto


```json
{
  "properties": {
    "name": {
      "description": "Name of the copy; the client supplies the translated default",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

## StudioProjectEnvelopeDto


```json
{
  "properties": {
    "engine": {
      "description": "The engine that produced the graph; `freecut`",
      "type": "string"
    },
    "engineRevision": {
      "description": "Pinned engine revision the editor was built from",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "graph": {
      "additionalProperties": {},
      "description": "Opaque engine document, stored and returned byte for byte",
      "type": "object"
    },
    "schemaVersion": {
      "description": "Envelope shape version; the server accepts exactly one",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "engine",
    "engineRevision",
    "graph",
    "schemaVersion"
  ],
  "type": "object"
}
```

## StudioProjectHistoryResponseDto

Related models: [StudioProjectRevisionDto](models-35.md#studioprojectrevisiondto).

```json
{
  "properties": {
    "items": {
      "description": "Newest first",
      "items": {
        "$ref": "#/components/schemas/StudioProjectRevisionDto"
      },
      "type": "array"
    },
    "total": {
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

## StudioProjectImportCreateDto


```json
{
  "properties": {
    "file": {
      "description": "The file to import",
      "format": "binary",
      "type": "string"
    },
    "id": {
      "description": "The media id the editor gave this file; retrying the same file with it is idempotent",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "file",
    "id"
  ],
  "type": "object"
}
```

## StudioProjectImportDto

Related models: [StudioProjectImportKind](models-35.md#studioprojectimportkind).

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

## StudioProjectInventoryDto

Related models: [StudioProjectImportDto](models-35.md#studioprojectimportdto), [StudioProjectResourceUseDto](models-35.md#studioprojectresourceusedto).

```json
{
  "properties": {
    "fonts": {
      "description": "Font families the head graph names",
      "items": {
        "$ref": "#/components/schemas/StudioProjectResourceUseDto"
      },
      "type": "array"
    },
    "keptFiles": {
      "description": "Files kept with the project (FL-103, FL-105)",
      "items": {
        "$ref": "#/components/schemas/StudioProjectImportDto"
      },
      "type": "array"
    },
    "luts": {
      "description": "Bundled LUTs the head graph names",
      "items": {
        "$ref": "#/components/schemas/StudioProjectResourceUseDto"
      },
      "type": "array"
    },
    "models": {
      "description": "Models the head graph names",
      "items": {
        "$ref": "#/components/schemas/StudioProjectResourceUseDto"
      },
      "type": "array"
    },
    "projectId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "revision": {
      "description": "The head revision the graph references were read from; 0 for an empty project",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "fonts",
    "keptFiles",
    "luts",
    "models",
    "projectId",
    "revision"
  ],
  "type": "object"
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

Related models: [StudioProjectDto](models-35.md#studioprojectdto).

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

## StudioProjectResourceKind


```json
{
  "description": "What the graph references",
  "enum": [
    "font",
    "lut",
    "model"
  ],
  "type": "string"
}
```

## StudioProjectResourceUseDto

Related models: [StudioProjectResourceKind](models-35.md#studioprojectresourcekind).

```json
{
  "properties": {
    "allowed": {
      "description": "Whether it may run on this server",
      "type": "boolean"
    },
    "detail": {
      "description": "Why not, when it may not",
      "nullable": true,
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/StudioProjectResourceKind"
    },
    "license": {
      "nullable": true,
      "type": "string"
    },
    "name": {
      "description": "As written in the graph",
      "type": "string"
    },
    "rightsId": {
      "description": "The rights row it resolves to",
      "type": "string"
    }
  },
  "required": [
    "allowed",
    "detail",
    "kind",
    "license",
    "name",
    "rightsId"
  ],
  "type": "object"
}
```

## StudioProjectResourcesDto

Related models: [StudioUnsupportedSourceDto](models-36.md#studiounsupportedsourcedto).

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

Related models: [StudioCommandSummaryDto](models-34.md#studiocommandsummarydto), [StudioProjectEnvelopeDto](models-35.md#studioprojectenvelopedto), [StudioProjectResourcesDto](models-35.md#studioprojectresourcesdto).

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

Related models: [StudioCommandSummaryDto](models-34.md#studiocommandsummarydto).

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

Related models: [StudioCommandEnvelopeDto](models-34.md#studiocommandenvelopedto), [StudioCommandSummaryDto](models-34.md#studiocommandsummarydto), [StudioProjectEnvelopeDto](models-35.md#studioprojectenvelopedto).

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

Related models: [StudioProjectLeaseDto](models-35.md#studioprojectleasedto), [StudioProjectResourcesDto](models-35.md#studioprojectresourcesdto).

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

## StudioRationalDto


```json
{
  "properties": {
    "den": {
      "description": "Denominator, positive; the pair is reduced",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "num": {
      "description": "Numerator",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
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

## StudioRenderCandidateDto

Related models: [StudioExportFormat](models-34.md#studioexportformat).

```json
{
  "properties": {
    "dolbyVision": {
      "type": "boolean"
    },
    "embeddedOutputFormats": {
      "description": "Output formats whose MP4 mov_text profile and encoder this same session verified",
      "items": {
        "$ref": "#/components/schemas/StudioExportFormat"
      },
      "maxItems": 1,
      "type": "array"
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
    },
    "sidecarOutputFormats": {
      "description": "Output formats whose versioned paired SRT profile this same session verified",
      "items": {
        "$ref": "#/components/schemas/StudioExportFormat"
      },
      "maxItems": 1,
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

Related models: [MediaOperationDestination](models-16.md#mediaoperationdestination), [StudioRenderCandidateDto](models-35.md#studiorendercandidatedto).

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

## StudioResourceApprovalDto


```json
{
  "description": "The owner approval the allowed rows come from",
  "nullable": true,
  "properties": {
    "approvedBy": {
      "type": "string"
    },
    "approvedOn": {
      "type": "string"
    }
  },
  "required": [
    "approvedBy",
    "approvedOn"
  ],
  "type": "object"
}
```

## StudioResourceInventoryDto

Related models: [StudioResourceApprovalDto](models-35.md#studioresourceapprovaldto), [StudioResourceItemDto](models-35.md#studioresourceitemdto).

```json
{
  "properties": {
    "approval": {
      "$ref": "#/components/schemas/StudioResourceApprovalDto"
    },
    "distributionApproved": {
      "description": "Whether the engine as a whole may be redistributed; false blocks every redistribution use",
      "type": "boolean"
    },
    "items": {
      "description": "Every reviewed resource, sorted by id",
      "items": {
        "$ref": "#/components/schemas/StudioResourceItemDto"
      },
      "type": "array"
    }
  },
  "required": [
    "approval",
    "distributionApproved",
    "items"
  ],
  "type": "object"
}
```

## StudioResourceItemDto

Related models: [StudioResourceItemKind](models-35.md#studioresourceitemkind), [StudioResourceUsesDto](models-35.md#studioresourceusesdto), [StudioWorkerCapability](models-36.md#studioworkercapability).

```json
{
  "properties": {
    "approvedOn": {
      "description": "The date the owner approved this exact row, or null",
      "nullable": true,
      "type": "string"
    },
    "capability": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioWorkerCapability"
        }
      ],
      "description": "The worker capability that runs it (GET /ml-destinations/capabilities says whether one is available), or null when the editor alone uses it",
      "nullable": true
    },
    "id": {
      "description": "The rights row id, e.g. font:Roboto or model:onnx-community/whisper-base_timestamped",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/StudioResourceItemKind"
    },
    "license": {
      "description": "The licence, as reviewed; null when the review records none",
      "nullable": true,
      "type": "string"
    },
    "name": {
      "description": "The name a graph or a job uses: a font family, a model id",
      "type": "string"
    },
    "producers": {
      "description": "For a model: the generated-file producers it serves (transcript, tts, musicgen)",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "restrictions": {
      "additionalProperties": {
        "type": "string"
      },
      "description": "Why the owner withheld a use, by use name (redistribution, localRuntime, hostedUse)",
      "type": "object"
    },
    "uses": {
      "$ref": "#/components/schemas/StudioResourceUsesDto"
    }
  },
  "required": [
    "approvedOn",
    "capability",
    "id",
    "kind",
    "license",
    "name",
    "producers",
    "restrictions",
    "uses"
  ],
  "type": "object"
}
```

## StudioResourceItemKind


```json
{
  "description": "What the resource is",
  "enum": [
    "font",
    "lut",
    "audio",
    "model",
    "voice",
    "weights",
    "tool",
    "runtime",
    "asset"
  ],
  "type": "string"
}
```

## StudioResourceUsesDto


```json
{
  "properties": {
    "hostedUse": {
      "description": "May run on Frameleaf Cloud",
      "type": "boolean"
    },
    "localRuntime": {
      "description": "May run on this server or a LAN worker",
      "type": "boolean"
    },
    "redistribution": {
      "description": "May be copied to someone else (a bundle, a download)",
      "type": "boolean"
    }
  },
  "required": [
    "hostedUse",
    "localRuntime",
    "redistribution"
  ],
  "type": "object"
}
```

## StudioRestoredVersionDto

Related models: [AssetRestorationMode](models-06.md#assetrestorationmode), [AssetRestorationSourceType](models-06.md#assetrestorationsourcetype), [StudioRestoredVersionUnavailable](models-35.md#studiorestoredversionunavailable).

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

## StudioTranscriptionCreateDto


```json
{
  "properties": {
    "clipId": {
      "description": "A video or audio clip on the main timeline of the head revision",
      "pattern": "^[\\w-]{1,128}$",
      "type": "string"
    },
    "destinationId": {
      "description": "The machine-learning destination to run on, named explicitly",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "language": {
      "description": "A BCP 47 language tag such as `en` or `pt-BR`, or `auto` to detect the language",
      "maxLength": 35,
      "minLength": 2,
      "type": "string"
    }
  },
  "required": [
    "clipId",
    "destinationId",
    "language"
  ],
  "type": "object"
}
```

## StudioTranscriptionCue

Related models: [StudioTranscriptionTime](models-36.md#studiotranscriptiontime).

```json
{
  "properties": {
    "end": {
      "$ref": "#/components/schemas/StudioTranscriptionTime"
    },
    "start": {
      "$ref": "#/components/schemas/StudioTranscriptionTime"
    },
    "text": {
      "type": "string"
    }
  },
  "required": [
    "end",
    "start",
    "text"
  ],
  "type": "object"
}
```

## StudioTranscriptionDto

Related models: [MediaOperationStatus](models-17.md#mediaoperationstatus), [StudioTranscriptionResultDto](models-36.md#studiotranscriptionresultdto).

```json
{
  "properties": {
    "clipId": {
      "pattern": "^[\\w-]{1,128}$",
      "type": "string"
    },
    "destinationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "language": {
      "description": "The language asked for (`auto` or a BCP 47 tag)",
      "type": "string"
    },
    "progress": {
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "projectId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "result": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioTranscriptionResultDto"
        }
      ],
      "description": "Present once the job has completed",
      "nullable": true
    },
    "revision": {
      "description": "The revision whose clip was transcribed",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    }
  },
  "required": [
    "clipId",
    "destinationId",
    "error",
    "id",
    "language",
    "progress",
    "projectId",
    "result",
    "revision",
    "status"
  ],
  "type": "object"
}
```

## StudioTranscriptionQueuedDto

Related models: [MediaOperationStatus](models-17.md#mediaoperationstatus).

```json
{
  "properties": {
    "id": {
      "description": "The job id; follow it in Activity (`/media-operations/{id}`)",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    }
  },
  "required": [
    "id",
    "status"
  ],
  "type": "object"
}
```
