# Server API models 27

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## PreservationItemState


```json
{
  "description": "`pending`, `copied`, `failed` or `skipped` for an export; `listed` for an item read from a package",
  "enum": [
    "pending",
    "copied",
    "failed",
    "skipped",
    "listed"
  ],
  "type": "string"
}
```

## PreservationItemsResponseDto

Related models: [PreservationItemDto](models-26.md#preservationitemdto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/PreservationItemDto"
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

## PreservationManifestSummaryDto


```json
{
  "properties": {
    "complete": {
      "description": "Every selected item was written; a complete package can still be damaged later",
      "type": "boolean"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "exported": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "failed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "includeLocked": {
      "type": "boolean"
    },
    "includeMetadata": {
      "type": "boolean"
    },
    "locked": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "packageId": {
      "description": "The package’s own identity, from its manifest",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "producerVersion": {
      "type": "string"
    },
    "scopeDescription": {
      "type": "string"
    },
    "skipped": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "complete",
    "createdAt",
    "exported",
    "failed",
    "includeLocked",
    "includeMetadata",
    "locked",
    "packageId",
    "producerVersion",
    "scopeDescription",
    "skipped"
  ],
  "type": "object"
}
```

## PreservationPackageCountsDto


```json
{
  "properties": {
    "copied": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "failed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "listed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "locked": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "pending": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "skipped": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "copied",
    "failed",
    "listed",
    "locked",
    "pending",
    "skipped",
    "total"
  ],
  "type": "object"
}
```

## PreservationPackageDto

Related models: [MediaOperationDto](models-16.md#mediaoperationdto), [PreservationManifestSummaryDto](models-27.md#preservationmanifestsummarydto), [PreservationPackageCountsDto](models-27.md#preservationpackagecountsdto), [PreservationPackageFormat](models-27.md#preservationpackageformat), [PreservationPackageOrigin](models-27.md#preservationpackageorigin), [PreservationPackageStatus](models-27.md#preservationpackagestatus), [PreservationSupportDto](models-27.md#preservationsupportdto), [PreservationVerificationDto](models-27.md#preservationverificationdto).

```json
{
  "properties": {
    "counts": {
      "$ref": "#/components/schemas/PreservationPackageCountsDto"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "downloadable": {
      "type": "boolean"
    },
    "expiresAt": {
      "description": "When an uploaded package is discarded",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "format": {
      "$ref": "#/components/schemas/PreservationPackageFormat"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "includeLocked": {
      "type": "boolean"
    },
    "includeMetadata": {
      "type": "boolean"
    },
    "lockedContent": {
      "description": "It holds Locked items: downloading it needs an unlocked session",
      "type": "boolean"
    },
    "manifest": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PreservationManifestSummaryDto"
        }
      ],
      "nullable": true
    },
    "name": {
      "type": "string"
    },
    "operation": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaOperationDto"
        }
      ],
      "description": "The newest job on this package",
      "nullable": true
    },
    "origin": {
      "$ref": "#/components/schemas/PreservationPackageOrigin"
    },
    "restorable": {
      "type": "boolean"
    },
    "scopeDescription": {
      "nullable": true,
      "type": "string"
    },
    "sizeBytes": {
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/PreservationPackageStatus"
    },
    "support": {
      "items": {
        "$ref": "#/components/schemas/PreservationSupportDto"
      },
      "type": "array"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    },
    "verification": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PreservationVerificationDto"
        }
      ],
      "nullable": true
    }
  },
  "required": [
    "counts",
    "createdAt",
    "downloadable",
    "expiresAt",
    "format",
    "id",
    "includeLocked",
    "includeMetadata",
    "lockedContent",
    "manifest",
    "name",
    "operation",
    "origin",
    "restorable",
    "scopeDescription",
    "sizeBytes",
    "status",
    "support",
    "updatedAt",
    "verification"
  ],
  "type": "object"
}
```

## PreservationPackageFormat


```json
{
  "description": "How the package is stored on this server",
  "enum": [
    "directory",
    "zip"
  ],
  "type": "string"
}
```

## PreservationPackageOrigin


```json
{
  "description": "`export`: written by this server; `upload`: a package you uploaded; `server`: a package an administrator named on this server",
  "enum": [
    "export",
    "upload",
    "server"
  ],
  "type": "string"
}
```

## PreservationPackageStatus


```json
{
  "description": "`building`: being written or not yet read; `ready`: every selected item is in it; `incomplete`: some items could not be copied; `unreadable`: its manifest or index could not be believed; `removed`: its files were deleted",
  "enum": [
    "building",
    "ready",
    "incomplete",
    "unreadable",
    "removed"
  ],
  "type": "string"
}
```

## PreservationPreviewDto

Related models: [PreservationScopeDto](models-27.md#preservationscopedto).

```json
{
  "properties": {
    "includeLocked": {
      "description": "Count Locked items as included; needs an unlocked session",
      "type": "boolean"
    },
    "scope": {
      "$ref": "#/components/schemas/PreservationScopeDto"
    }
  },
  "type": "object"
}
```

## PreservationPreviewResponseDto

Related models: [PreservationSupportDto](models-27.md#preservationsupportdto).

```json
{
  "properties": {
    "bytes": {
      "type": "string"
    },
    "freeBytes": {
      "description": "Free space where the package would be written",
      "nullable": true,
      "type": "string"
    },
    "includedBytes": {
      "type": "string"
    },
    "includedItems": {
      "description": "Items the export would include",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "items": {
      "description": "Items matching, Locked ones not counted",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "lockedAllowed": {
      "description": "This session is unlocked, so Locked items may be included",
      "type": "boolean"
    },
    "lockedBytes": {
      "type": "string"
    },
    "lockedItems": {
      "description": "Locked items matching",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxItems": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "support": {
      "items": {
        "$ref": "#/components/schemas/PreservationSupportDto"
      },
      "type": "array"
    },
    "withinLimit": {
      "type": "boolean"
    }
  },
  "required": [
    "bytes",
    "freeBytes",
    "includedBytes",
    "includedItems",
    "items",
    "lockedAllowed",
    "lockedBytes",
    "lockedItems",
    "maxItems",
    "support",
    "withinLimit"
  ],
  "type": "object"
}
```

## PreservationRestoreCountsDto


```json
{
  "properties": {
    "conflicts": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "existing": {
      "description": "Originals the library already holds; they are matched, never copied again",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "failed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "findings": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "locked": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "matched": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "new": {
      "description": "Originals the library does not hold",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "pending": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "ready": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "restored": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "skipped": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "trashed": {
      "description": "Originals the library holds in the trash; restore them from the trash first",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "conflicts",
    "existing",
    "failed",
    "findings",
    "locked",
    "matched",
    "new",
    "pending",
    "ready",
    "restored",
    "skipped",
    "total",
    "trashed"
  ],
  "type": "object"
}
```

## PreservationRestoreCreateDto

Related models: [PreservationDecision](models-26.md#preservationdecision).

```json
{
  "properties": {
    "conflictDefault": {
      "$ref": "#/components/schemas/PreservationDecision",
      "description": "What to do where the package and the library disagree and you have not chosen; `keep` when omitted"
    },
    "name": {
      "maxLength": 120,
      "minLength": 1,
      "type": "string"
    },
    "packageId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "requestKey": {
      "description": "Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "restoreEditRecipes": {
      "description": "Restore edit recipes; edited versions are rendered again",
      "type": "boolean"
    }
  },
  "required": [
    "packageId"
  ],
  "type": "object"
}
```

## PreservationRestoreDto

Related models: [MediaOperationDto](models-16.md#mediaoperationdto), [PreservationDecision](models-26.md#preservationdecision), [PreservationRestoreCountsDto](models-27.md#preservationrestorecountsdto), [PreservationRestoreStatus](models-27.md#preservationrestorestatus), [PreservationSupportDto](models-27.md#preservationsupportdto).

```json
{
  "properties": {
    "albums": {
      "description": "Albums and collections in the package",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "conflictDefault": {
      "$ref": "#/components/schemas/PreservationDecision"
    },
    "counts": {
      "$ref": "#/components/schemas/PreservationRestoreCountsDto"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "operation": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaOperationDto"
        }
      ],
      "description": "The newest job on this restoration",
      "nullable": true
    },
    "packageId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "people": {
      "description": "Named people in the package",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "reasonKey": {
      "nullable": true,
      "type": "string"
    },
    "restoreEditRecipes": {
      "type": "boolean"
    },
    "status": {
      "$ref": "#/components/schemas/PreservationRestoreStatus"
    },
    "support": {
      "items": {
        "$ref": "#/components/schemas/PreservationSupportDto"
      },
      "type": "array"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "albums",
    "conflictDefault",
    "counts",
    "createdAt",
    "id",
    "name",
    "operation",
    "packageId",
    "people",
    "reasonKey",
    "restoreEditRecipes",
    "status",
    "support",
    "updatedAt"
  ],
  "type": "object"
}
```

## PreservationRestoreItemDto

Related models: [PreservationConflictDto](models-26.md#preservationconflictdto), [PreservationRestoreItemState](models-27.md#preservationrestoreitemstate), [PreservationRestoreMatch](models-27.md#preservationrestorematch).

```json
{
  "properties": {
    "applied": {
      "type": "boolean"
    },
    "assetId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "conflicts": {
      "items": {
        "$ref": "#/components/schemas/PreservationConflictDto"
      },
      "type": "array"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "findings": {
      "description": "Translation keys for what the restore left for you to look at",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "locked": {
      "description": "Locked in the package or in your library; listed only to an unlocked session",
      "type": "boolean"
    },
    "match": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PreservationRestoreMatch"
        }
      ],
      "nullable": true
    },
    "name": {
      "nullable": true,
      "type": "string"
    },
    "reasonKey": {
      "nullable": true,
      "type": "string"
    },
    "sourceAssetId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/PreservationRestoreItemState"
    }
  },
  "required": [
    "applied",
    "assetId",
    "conflicts",
    "error",
    "findings",
    "id",
    "locked",
    "match",
    "name",
    "reasonKey",
    "sourceAssetId",
    "state"
  ],
  "type": "object"
}
```

## PreservationRestoreItemFilter


```json
{
  "enum": [
    "conflicts",
    "failed",
    "findings"
  ],
  "type": "string"
}
```

## PreservationRestoreItemState


```json
{
  "enum": [
    "pending",
    "ready",
    "failed",
    "creating",
    "restored",
    "matched",
    "skipped"
  ],
  "type": "string"
}
```

## PreservationRestoreItemsResponseDto

Related models: [PreservationRestoreItemDto](models-27.md#preservationrestoreitemdto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/PreservationRestoreItemDto"
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

## PreservationRestoreMatch


```json
{
  "enum": [
    "new",
    "existing",
    "trashed"
  ],
  "type": "string"
}
```

## PreservationRestoreStatus


```json
{
  "description": "`reviewing`: the package is being checked; `ready`: review the findings, then restore; `restoring`; `completed`; `unreadable`: the package cannot be believed",
  "enum": [
    "reviewing",
    "ready",
    "restoring",
    "completed",
    "unreadable"
  ],
  "type": "string"
}
```

## PreservationScopeDto

Related models: [SearchFilter](models-30.md#searchfilter).

```json
{
  "description": "What to preserve. Only your own items are ever included: never a partner’s or a shared album’s.",
  "properties": {
    "assetIds": {
      "description": "Exactly these items of yours, instead of a filter",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 100000,
      "minItems": 1,
      "type": "array"
    },
    "filter": {
      "$ref": "#/components/schemas/SearchFilter",
      "description": "Your items matching these conditions; the whole library when empty"
    }
  },
  "type": "object"
}
```

## PreservationServerPackageCreateDto


```json
{
  "properties": {
    "name": {
      "maxLength": 120,
      "minLength": 1,
      "type": "string"
    },
    "path": {
      "description": "A package directory or ZIP file on this server, outside its media storage",
      "maxLength": 4096,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "path"
  ],
  "type": "object"
}
```

## PreservationSupportCategory


```json
{
  "description": "A kind of information a package may carry",
  "enum": [
    "originals",
    "dates",
    "places",
    "descriptions",
    "ratings",
    "favorites",
    "archive",
    "locked",
    "albums",
    "tags",
    "people",
    "editRecipes",
    "livePhotos",
    "stacks",
    "documentCorrections",
    "momentNotes",
    "generatedDescriptions",
    "generatedMoments",
    "cameraDetails",
    "sharing",
    "pets",
    "studioProjects",
    "memories"
  ],
  "type": "string"
}
```

## PreservationSupportDto

Related models: [PreservationSupportCategory](models-27.md#preservationsupportcategory), [PreservationSupportLevel](models-27.md#preservationsupportlevel).

```json
{
  "properties": {
    "category": {
      "$ref": "#/components/schemas/PreservationSupportCategory"
    },
    "level": {
      "$ref": "#/components/schemas/PreservationSupportLevel"
    }
  },
  "required": [
    "category",
    "level"
  ],
  "type": "object"
}
```

## PreservationSupportLevel


```json
{
  "description": "`restored`: comes back as it was; `restored-when-empty`: only where the library has none; `provenance-only`: kept as a record, never applied; `not-included`: not in a package",
  "enum": [
    "restored",
    "restored-when-empty",
    "provenance-only",
    "not-included"
  ],
  "type": "string"
}
```

## PreservationUploadCreateDto


```json
{
  "properties": {
    "file": {
      "description": "A `.frameleaf-preservation.zip` package",
      "format": "binary",
      "type": "string"
    }
  },
  "required": [
    "file"
  ],
  "type": "object"
}
```

## PreservationVerificationDto

Related models: [PreservationVerificationStatus](models-27.md#preservationverificationstatus).

```json
{
  "properties": {
    "changed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "checked": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "documentsChanged": {
      "description": "Index documents whose digest no longer matches",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "finishedAt": {
      "format": "date-time",
      "type": "string"
    },
    "missing": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "ok": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "reasonKey": {
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/PreservationVerificationStatus"
    },
    "unexpected": {
      "description": "Files in the package its manifest does not account for",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "changed",
    "checked",
    "documentsChanged",
    "finishedAt",
    "missing",
    "ok",
    "reasonKey",
    "status",
    "unexpected"
  ],
  "type": "object"
}
```

## PreservationVerificationStatus


```json
{
  "description": "`verified`: every file matches; `problems`: some are missing or changed; `unreadable`: the manifest or index cannot be believed",
  "enum": [
    "verified",
    "problems",
    "unreadable"
  ],
  "type": "string"
}
```

## PreservationVerifyState


```json
{
  "description": "The latest verification of this item",
  "enum": [
    "ok",
    "missing",
    "changed"
  ],
  "type": "string"
}
```

## PrivacyResponse

Related models: [SuppressionResponse](models-34.md#suppressionresponse).

```json
{
  "description": "Privacy preferences",
  "properties": {
    "suppression": {
      "$ref": "#/components/schemas/SuppressionResponse"
    }
  },
  "required": [
    "suppression"
  ],
  "type": "object"
}
```

## PrivacyUpdate

Related models: [SuppressionUpdate](models-34.md#suppressionupdate).

```json
{
  "description": "Privacy preferences",
  "properties": {
    "suppression": {
      "$ref": "#/components/schemas/SuppressionUpdate"
    }
  },
  "type": "object"
}
```

## PublicConfigDto

Related models: [FrameleafPublicConfigDto](models-12.md#frameleafpublicconfigdto), [PublicConfigFrameleafCloudDto](models-27.md#publicconfigframeleafclouddto), [PublicConfigOAuthDto](models-27.md#publicconfigoauthdto), [PublicConfigPasswordLoginDto](models-27.md#publicconfigpasswordlogindto), [PublicConfigServerDto](models-27.md#publicconfigserverdto), [PublicConfigThemeDto](models-27.md#publicconfigthemedto).

```json
{
  "properties": {
    "frameleaf": {
      "$ref": "#/components/schemas/FrameleafPublicConfigDto"
    },
    "frameleafCloud": {
      "$ref": "#/components/schemas/PublicConfigFrameleafCloudDto"
    },
    "oauth": {
      "$ref": "#/components/schemas/PublicConfigOAuthDto"
    },
    "passwordLogin": {
      "$ref": "#/components/schemas/PublicConfigPasswordLoginDto"
    },
    "server": {
      "$ref": "#/components/schemas/PublicConfigServerDto"
    },
    "theme": {
      "$ref": "#/components/schemas/PublicConfigThemeDto"
    }
  },
  "required": [
    "frameleaf",
    "frameleafCloud",
    "oauth",
    "passwordLogin",
    "server",
    "theme"
  ],
  "type": "object"
}
```

## PublicConfigFrameleafCloudDto

Related models: [PublicConfigFrameleafSignInDto](models-27.md#publicconfigframeleafsignindto).

```json
{
  "properties": {
    "signIn": {
      "$ref": "#/components/schemas/PublicConfigFrameleafSignInDto"
    }
  },
  "required": [
    "signIn"
  ],
  "type": "object"
}
```

## PublicConfigFrameleafSignInDto


```json
{
  "properties": {
    "buttonText": {
      "description": "Sign in with Frameleaf button text",
      "maxLength": 100,
      "type": "string"
    },
    "showOnLocalLogin": {
      "description": "Show Sign in with Frameleaf on the local sign-in page too",
      "type": "boolean"
    }
  },
  "required": [
    "buttonText",
    "showOnLocalLogin"
  ],
  "type": "object"
}
```

## PublicConfigOAuthDto


```json
{
  "properties": {
    "autoLaunch": {
      "description": "Auto launch",
      "type": "boolean"
    },
    "buttonText": {
      "description": "Button text",
      "type": "string"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    }
  },
  "required": [
    "autoLaunch",
    "buttonText",
    "enabled"
  ],
  "type": "object"
}
```

## PublicConfigPasswordLoginDto


```json
{
  "properties": {
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## PublicConfigServerDto


```json
{
  "properties": {
    "loginPageMessage": {
      "description": "Login page message",
      "type": "string"
    },
    "name": {
      "description": "Server name shown in settings; empty uses the host name",
      "maxLength": 100,
      "type": "string"
    }
  },
  "required": [
    "loginPageMessage",
    "name"
  ],
  "type": "object"
}
```

## PublicConfigThemeDto


```json
{
  "properties": {
    "customCss": {
      "description": "Custom CSS for theming",
      "type": "string"
    }
  },
  "required": [
    "customCss"
  ],
  "type": "object"
}
```

## PurchaseResponse


```json
{
  "properties": {
    "hideBuyButtonUntil": {
      "description": "Date until which to hide buy button",
      "type": "string"
    },
    "showSupportBadge": {
      "description": "Whether to show support badge",
      "type": "boolean"
    }
  },
  "required": [
    "hideBuyButtonUntil",
    "showSupportBadge"
  ],
  "type": "object"
}
```

## PurchaseUpdate


```json
{
  "properties": {
    "hideBuyButtonUntil": {
      "description": "Date until which to hide buy button",
      "type": "string"
    },
    "showSupportBadge": {
      "description": "Whether to show support badge",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## PushActivityTokenDto


```json
{
  "properties": {
    "kind": {
      "description": "The Live Activity type",
      "enum": [
        "cloud-backup-activation"
      ],
      "type": "string"
    },
    "token": {
      "description": "The ActivityKit push token of this activity",
      "maxLength": 4096,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "kind",
    "token"
  ],
  "type": "object"
}
```

## PushApnsEnvironment


```json
{
  "description": "iOS only: the APNs environment of the tokens. A development build gets sandbox tokens, which only APNs sandbox delivers. Default production.",
  "enum": [
    "production",
    "sandbox"
  ],
  "type": "string"
}
```

## PushDeviceActivityDto


```json
{
  "properties": {
    "activityId": {
      "type": "string"
    },
    "kind": {
      "type": "string"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "activityId",
    "kind",
    "updatedAt"
  ],
  "type": "object"
}
```

## PushDeviceListResponseDto

Related models: [PushDeviceResponseDto](models-27.md#pushdeviceresponsedto).

```json
{
  "properties": {
    "devices": {
      "items": {
        "$ref": "#/components/schemas/PushDeviceResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "devices"
  ],
  "type": "object"
}
```

## PushDeviceRegisterDto

Related models: [PushApnsEnvironment](models-27.md#pushapnsenvironment), [PushPlatform](models-27.md#pushplatform), [PushPreferencesDto](models-27.md#pushpreferencesdto).

```json
{
  "properties": {
    "apnsEnvironment": {
      "$ref": "#/components/schemas/PushApnsEnvironment"
    },
    "backupDeviceKey": {
      "description": "This device's phone backup identity (the backup device registry's deviceKey), for stale-backup wake-ups",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "platform": {
      "$ref": "#/components/schemas/PushPlatform"
    },
    "preferences": {
      "$ref": "#/components/schemas/PushPreferencesDto"
    },
    "publicKey": {
      "description": "The device's X25519 public key: its raw 32 bytes, base64url (CryptoKit `rawRepresentation`). Every payload is encrypted to it (frameleaf-push-v1; see docs/developer/push-envelope-v1).",
      "maxLength": 64,
      "minLength": 1,
      "type": "string"
    },
    "pushToStartToken": {
      "description": "iOS only: the ActivityKit push-to-start token",
      "maxLength": 4096,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "pushToken": {
      "description": "The APNs device token or FCM registration token",
      "maxLength": 4096,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "platform",
    "publicKey",
    "pushToken"
  ],
  "type": "object"
}
```

## PushDeviceResponseDto

Related models: [PushApnsEnvironment](models-27.md#pushapnsenvironment), [PushDeviceActivityDto](models-27.md#pushdeviceactivitydto), [PushPlatform](models-27.md#pushplatform), [PushPreferencesResponseDto](models-27.md#pushpreferencesresponsedto).

```json
{
  "description": "A registered push device. Push tokens are never returned.",
  "properties": {
    "activities": {
      "items": {
        "$ref": "#/components/schemas/PushDeviceActivityDto"
      },
      "type": "array"
    },
    "apnsEnvironment": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PushApnsEnvironment"
        }
      ],
      "description": "iOS: the APNs environment; null for Android",
      "nullable": true
    },
    "backupDeviceKey": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "current": {
      "description": "Whether this is the device of the session asking",
      "type": "boolean"
    },
    "hasPushToStartToken": {
      "type": "boolean"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "lastDeliveredAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "platform": {
      "$ref": "#/components/schemas/PushPlatform"
    },
    "preferences": {
      "$ref": "#/components/schemas/PushPreferencesResponseDto"
    },
    "publicKeyFingerprint": {
      "description": "A short fingerprint of the registered public key; never the token",
      "type": "string"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "activities",
    "apnsEnvironment",
    "backupDeviceKey",
    "createdAt",
    "current",
    "hasPushToStartToken",
    "id",
    "lastDeliveredAt",
    "platform",
    "preferences",
    "publicKeyFingerprint",
    "updatedAt"
  ],
  "type": "object"
}
```

## PushDeviceUpdateDto

Related models: [PushApnsEnvironment](models-27.md#pushapnsenvironment), [PushPreferencesDto](models-27.md#pushpreferencesdto).

```json
{
  "properties": {
    "apnsEnvironment": {
      "$ref": "#/components/schemas/PushApnsEnvironment"
    },
    "backupDeviceKey": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "preferences": {
      "$ref": "#/components/schemas/PushPreferencesDto"
    },
    "publicKey": {
      "description": "The device's X25519 public key: its raw 32 bytes, base64url (CryptoKit `rawRepresentation`). Every payload is encrypted to it (frameleaf-push-v1; see docs/developer/push-envelope-v1).",
      "maxLength": 64,
      "minLength": 1,
      "type": "string"
    },
    "pushToStartToken": {
      "description": "iOS only: a rotated ActivityKit push-to-start token, or null",
      "maxLength": 4096,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "pushToken": {
      "description": "A rotated APNs or FCM token",
      "maxLength": 4096,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

## PushEventType


```json
{
  "description": "FL-228: an event this server delivers as a push notification",
  "enum": [
    "backup-needs-attention",
    "backup-stale",
    "cloud-backup-activation",
    "shared-activity",
    "memories",
    "render-finished",
    "access-changed"
  ],
  "type": "string"
}
```

## PushPlatform


```json
{
  "description": "FL-228: the push service a device receives notifications through",
  "enum": [
    "ios",
    "android"
  ],
  "type": "string"
}
```

## PushPreferencesDto


```json
{
  "description": "Which events this device is told about; an omitted event keeps its current setting (on by default)",
  "properties": {
    "accessChanged": {
      "type": "boolean"
    },
    "backupNeedsAttention": {
      "type": "boolean"
    },
    "backupStale": {
      "type": "boolean"
    },
    "cloudBackupActivation": {
      "type": "boolean"
    },
    "memories": {
      "type": "boolean"
    },
    "renderFinished": {
      "type": "boolean"
    },
    "sharedActivity": {
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## PushPreferencesResponseDto


```json
{
  "properties": {
    "accessChanged": {
      "type": "boolean"
    },
    "backupNeedsAttention": {
      "type": "boolean"
    },
    "backupStale": {
      "type": "boolean"
    },
    "cloudBackupActivation": {
      "type": "boolean"
    },
    "memories": {
      "type": "boolean"
    },
    "renderFinished": {
      "type": "boolean"
    },
    "sharedActivity": {
      "type": "boolean"
    }
  },
  "required": [
    "accessChanged",
    "backupNeedsAttention",
    "backupStale",
    "cloudBackupActivation",
    "memories",
    "renderFinished",
    "sharedActivity"
  ],
  "type": "object"
}
```

## PushStatusResponseDto

Related models: [PushEventType](models-27.md#pusheventtype), [PushUnavailableReason](models-27.md#pushunavailablereason).

```json
{
  "properties": {
    "available": {
      "description": "Whether this server delivers push notifications now (it must be linked)",
      "type": "boolean"
    },
    "encryption": {
      "description": "How payloads are encrypted to the device key",
      "properties": {
        "cipher": {
          "enum": [
            "AES-256-GCM"
          ],
          "type": "string"
        },
        "kdf": {
          "enum": [
            "HKDF-SHA256"
          ],
          "type": "string"
        },
        "keyAgreement": {
          "enum": [
            "X25519"
          ],
          "type": "string"
        },
        "scheme": {
          "enum": [
            "frameleaf-push-v1"
          ],
          "type": "string"
        }
      },
      "required": [
        "scheme",
        "keyAgreement",
        "kdf",
        "cipher"
      ],
      "type": "object"
    },
    "events": {
      "description": "The events this server can deliver",
      "items": {
        "$ref": "#/components/schemas/PushEventType"
      },
      "type": "array"
    },
    "reason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PushUnavailableReason"
        }
      ],
      "description": "Why push is unavailable; null when available",
      "nullable": true
    },
    "registered": {
      "description": "Whether the session asking has registered its device",
      "type": "boolean"
    }
  },
  "required": [
    "available",
    "encryption",
    "events",
    "reason",
    "registered"
  ],
  "type": "object"
}
```

## PushUnavailableReason


```json
{
  "description": "FL-228: why push notifications are unavailable on this server",
  "enum": [
    "not-configured",
    "not-linked",
    "clone-suspected"
  ],
  "type": "string"
}
```

## QueueCommand


```json
{
  "description": "Queue command to execute",
  "enum": [
    "start",
    "pause",
    "resume",
    "empty",
    "clear-failed"
  ],
  "type": "string"
}
```

## QueueCommandDto

Related models: [QueueCommand](models-27.md#queuecommand).

```json
{
  "properties": {
    "command": {
      "$ref": "#/components/schemas/QueueCommand"
    },
    "force": {
      "description": "Force the command execution (if applicable)",
      "type": "boolean"
    }
  },
  "required": [
    "command"
  ],
  "type": "object"
}
```

## QueueDeleteDto


```json
{
  "properties": {
    "failed": {
      "description": "If true, will also remove failed jobs from the queue.",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v2.4.0",
          "state": "Added"
        },
        {
          "version": "v2.4.0",
          "state": "Alpha"
        }
      ],
      "x-immich-state": "Alpha"
    }
  },
  "type": "object"
}
```

## QueueJobAccountDto


```json
{
  "properties": {
    "id": {
      "description": "Account ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "Account name",
      "type": "string"
    }
  },
  "required": [
    "id",
    "name"
  ],
  "type": "object"
}
```

## QueueJobResponseDto

Related models: [JobName](models-14.md#jobname), [QueueJobAccountDto](models-27.md#queuejobaccountdto), [QueueJobWorkerDto](models-27.md#queuejobworkerdto).

```json
{
  "properties": {
    "account": {
      "$ref": "#/components/schemas/QueueJobAccountDto",
      "description": "The account whose item the job works on, when the job names an asset, person, library or account"
    },
    "attemptsMade": {
      "description": "How many times the job has been attempted",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "data": {
      "additionalProperties": {},
      "description": "Job data payload",
      "type": "object"
    },
    "failedReason": {
      "description": "Why the last attempt failed, for a failed job",
      "type": "string"
    },
    "id": {
      "description": "Job ID",
      "type": "string"
    },
    "name": {
      "$ref": "#/components/schemas/JobName"
    },
    "timestamp": {
      "description": "Job creation timestamp",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "worker": {
      "$ref": "#/components/schemas/QueueJobWorkerDto",
      "description": "Where the job runs or ran"
    }
  },
  "required": [
    "data",
    "name",
    "timestamp",
    "worker"
  ],
  "type": "object"
}
```

## QueueJobStatus


```json
{
  "description": "Queue job status",
  "enum": [
    "active",
    "failed",
    "completed",
    "delayed",
    "waiting",
    "paused"
  ],
  "type": "string"
}
```

## QueueJobWorkerDto

Related models: [QueueJobWorkerKind](models-27.md#queuejobworkerkind).

```json
{
  "properties": {
    "kind": {
      "$ref": "#/components/schemas/QueueJobWorkerKind"
    },
    "name": {
      "description": "The processing destination name, for a machine-learning worker",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "kind",
    "name"
  ],
  "type": "object"
}
```

## QueueJobWorkerKind


```json
{
  "description": "Where a queue job runs",
  "enum": [
    "server",
    "local",
    "lan",
    "frameleaf-cloud"
  ],
  "type": "string"
}
```

## QueueName


```json
{
  "description": "Queue name",
  "enum": [
    "thumbnailGeneration",
    "metadataExtraction",
    "videoConversion",
    "faceDetection",
    "facialRecognition",
    "smartSearch",
    "duplicateDetection",
    "videoDuplicateDetection",
    "backgroundTask",
    "storageTemplateMigration",
    "migration",
    "search",
    "sidecar",
    "library",
    "notifications",
    "backupDatabase",
    "ocr",
    "imageEnrichment",
    "imageDescription",
    "nsfwDetection",
    "mediaHealth",
    "workflow",
    "integrityCheck",
    "editor",
    "petRecognition"
  ],
  "type": "string"
}
```

## QueueOwnerStatisticsResponseDto


```json
{
  "properties": {
    "active": {
      "description": "Number of active jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "completed": {
      "description": "Number of completed jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "delayed": {
      "description": "Number of delayed jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "failed": {
      "description": "Number of failed jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "paused": {
      "description": "Number of paused jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "truncated": {
      "description": "Whether a state had more jobs than were scanned, so its count is a lower bound",
      "type": "boolean"
    },
    "waiting": {
      "description": "Number of waiting jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "active",
    "completed",
    "delayed",
    "failed",
    "paused",
    "truncated",
    "waiting"
  ],
  "type": "object"
}
```

## QueueResponseDto

Related models: [QueueName](models-27.md#queuename), [QueueStatisticsDto](models-27.md#queuestatisticsdto).

```json
{
  "properties": {
    "hasUnfinishedWork": {
      "description": "Whether durable work remains, including delayed, paused and unadmitted work",
      "type": "boolean"
    },
    "isPaused": {
      "description": "Whether the queue is paused",
      "type": "boolean"
    },
    "name": {
      "$ref": "#/components/schemas/QueueName"
    },
    "statistics": {
      "$ref": "#/components/schemas/QueueStatisticsDto"
    }
  },
  "required": [
    "hasUnfinishedWork",
    "isPaused",
    "name",
    "statistics"
  ],
  "type": "object"
}
```

## QueueResponseLegacyDto

Related models: [QueueStatisticsDto](models-27.md#queuestatisticsdto), [QueueStatusLegacyDto](models-27.md#queuestatuslegacydto).

```json
{
  "properties": {
    "jobCounts": {
      "$ref": "#/components/schemas/QueueStatisticsDto"
    },
    "queueStatus": {
      "$ref": "#/components/schemas/QueueStatusLegacyDto"
    },
    "runId": {
      "description": "Durable run created by a batch start",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "jobCounts",
    "queueStatus"
  ],
  "type": "object"
}
```

## QueueRetryFailedResponseDto


```json
{
  "properties": {
    "count": {
      "description": "How many failed jobs were put back in the queue",
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

## QueueRunDto

Related models: [QueueName](models-27.md#queuename).

```json
{
  "properties": {
    "active": {
      "description": "Jobs running now",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "canPause": {
      "description": "Whether this queue can be paused; background tasks cannot",
      "type": "boolean"
    },
    "isPaused": {
      "description": "Whether the queue is paused",
      "type": "boolean"
    },
    "lastProgressAt": {
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "name": {
      "$ref": "#/components/schemas/QueueName"
    },
    "noDispatchBacklog": {
      "type": "boolean"
    },
    "processed": {
      "description": "Jobs finished, completed or failed, since this run started",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "startedAt": {
      "description": "When this run was first seen with work",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "state": {
      "enum": [
        "running",
        "retrying",
        "delayed",
        "paused",
        "waiting",
        "blocked",
        "unavailable",
        "needs_attention",
        "completed",
        "completed_with_errors",
        "cancelled"
      ],
      "type": "string"
    },
    "total": {
      "description": "processed + active + waiting",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "unavailable": {
      "description": "Status could not be read; zero counts are unknown, not idle",
      "type": "boolean"
    },
    "waiting": {
      "description": "Jobs waiting to start, including those held by a paused queue",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "active",
    "canPause",
    "isPaused",
    "name",
    "processed",
    "startedAt",
    "total",
    "waiting"
  ],
  "type": "object"
}
```

## QueueStatisticsDto


```json
{
  "properties": {
    "active": {
      "description": "Number of active jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "completed": {
      "description": "Number of completed jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "delayed": {
      "description": "Number of delayed jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "failed": {
      "description": "Number of failed jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "paused": {
      "description": "Number of paused jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "waiting": {
      "description": "Number of waiting jobs",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "active",
    "completed",
    "delayed",
    "failed",
    "paused",
    "waiting"
  ],
  "type": "object"
}
```

## QueueStatusLegacyDto


```json
{
  "properties": {
    "isActive": {
      "description": "Whether the queue is currently active (has running jobs)",
      "type": "boolean"
    },
    "isPaused": {
      "description": "Whether the queue is paused",
      "type": "boolean"
    }
  },
  "required": [
    "isActive",
    "isPaused"
  ],
  "type": "object"
}
```

## QueueUpdateDto


```json
{
  "properties": {
    "isPaused": {
      "description": "Whether to pause the queue",
      "type": "boolean"
    }
  },
  "type": "object"
}
```
