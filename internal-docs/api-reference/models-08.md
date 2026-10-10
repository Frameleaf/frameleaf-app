# Server API models 8

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## ClassificationPreviewDto

Related models: [ClassificationMediaType](models-07.md#classificationmediatype).

```json
{
  "properties": {
    "mediaType": {
      "$ref": "#/components/schemas/ClassificationMediaType",
      "default": "any"
    },
    "personIds": {
      "default": [],
      "description": "Match any of these people",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50,
      "type": "array"
    },
    "sampleSize": {
      "default": 500,
      "description": "How many of the newest items a visual preview reads",
      "maximum": 2000,
      "minimum": 1,
      "type": "integer"
    },
    "tagIds": {
      "default": [],
      "description": "Match any of these tags, or a tag beneath one of them",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50,
      "type": "array"
    },
    "takenAfter": {
      "default": null,
      "description": "Taken on or after this day (YYYY-MM-DD)",
      "nullable": true,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "type": "string"
    },
    "takenBefore": {
      "default": null,
      "description": "Taken on or before this day (YYYY-MM-DD)",
      "nullable": true,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "type": "string"
    },
    "threshold": {
      "default": 0.25,
      "description": "The confidence a visual phrase has to reach",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "visualQueries": {
      "default": [],
      "description": "Visual category phrases compared with each item",
      "items": {
        "maxLength": 120,
        "minLength": 1,
        "type": "string"
      },
      "maxItems": 10,
      "type": "array"
    }
  },
  "type": "object"
}
```

## ClassificationPreviewResponseDto

Related models: [ClassificationScoredAssetDto](models-08.md#classificationscoredassetdto).

```json
{
  "properties": {
    "exact": {
      "description": "True when `matched` counts the whole library, false for a bounded sample",
      "type": "boolean"
    },
    "items": {
      "description": "The first matches, best first",
      "items": {
        "$ref": "#/components/schemas/ClassificationScoredAssetDto"
      },
      "type": "array"
    },
    "matched": {
      "description": "Items that match among those read",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "sampled": {
      "description": "Items read: the whole library when exact, otherwise the newest items",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "visualSearchAvailable": {
      "description": "False when visual phrases cannot be compared right now",
      "type": "boolean"
    }
  },
  "required": [
    "exact",
    "items",
    "matched",
    "sampled",
    "visualSearchAvailable"
  ],
  "type": "object"
}
```

## ClassificationReviewDecision


```json
{
  "description": "Keep the matches, or turn them down and undo what the rule applied",
  "enum": [
    "accepted",
    "rejected"
  ],
  "type": "string"
}
```

## ClassificationRuleAction


```json
{
  "description": "What a classification rule does with a match",
  "enum": [
    "review",
    "tag"
  ],
  "type": "string"
}
```

## ClassificationRuleCountsDto


```json
{
  "properties": {
    "accepted": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "matched": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "rejected": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "suggested": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "accepted",
    "matched",
    "rejected",
    "suggested"
  ],
  "type": "object"
}
```

## ClassificationRuleCreateDto

Related models: [ClassificationMediaType](models-07.md#classificationmediatype), [ClassificationRuleAction](models-08.md#classificationruleaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/ClassificationRuleAction",
      "description": "Defaults to the server default rule action"
    },
    "albumName": {
      "description": "Name of the smart album",
      "maxLength": 120,
      "minLength": 1,
      "type": "string"
    },
    "archive": {
      "default": false,
      "description": "Archive matches; requires archiveConsent",
      "type": "boolean"
    },
    "archiveConsent": {
      "description": "The owner explicitly agrees that matches are archived",
      "type": "boolean"
    },
    "description": {
      "description": "Description of the smart album",
      "maxLength": 2000,
      "nullable": true,
      "type": "string"
    },
    "enabled": {
      "default": true,
      "type": "boolean"
    },
    "icon": {
      "description": "Icon of the smart album",
      "maxLength": 80,
      "type": "string"
    },
    "mediaType": {
      "$ref": "#/components/schemas/ClassificationMediaType",
      "default": "any"
    },
    "parentId": {
      "description": "Collection to create the smart album inside",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "personIds": {
      "default": [],
      "description": "Match any of these people",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50,
      "type": "array"
    },
    "tagIds": {
      "default": [],
      "description": "Match any of these tags, or a tag beneath one of them",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50,
      "type": "array"
    },
    "tagName": {
      "description": "The rule-owned tag a match receives; null tags nothing",
      "maxLength": 120,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "takenAfter": {
      "default": null,
      "description": "Taken on or after this day (YYYY-MM-DD)",
      "nullable": true,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "type": "string"
    },
    "takenBefore": {
      "default": null,
      "description": "Taken on or before this day (YYYY-MM-DD)",
      "nullable": true,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "type": "string"
    },
    "threshold": {
      "default": 0.25,
      "description": "The confidence a visual phrase has to reach",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "visualQueries": {
      "default": [],
      "description": "Visual category phrases compared with each item",
      "items": {
        "maxLength": 120,
        "minLength": 1,
        "type": "string"
      },
      "maxItems": 10,
      "type": "array"
    }
  },
  "required": [
    "albumName"
  ],
  "type": "object"
}
```

## ClassificationRuleResponseDto

Related models: [ClassificationMediaType](models-07.md#classificationmediatype), [ClassificationRuleAction](models-08.md#classificationruleaction), [ClassificationRuleCountsDto](models-08.md#classificationrulecountsdto), [ClassificationTagDto](models-08.md#classificationtagdto).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/ClassificationRuleAction"
    },
    "albumId": {
      "type": "string"
    },
    "albumName": {
      "type": "string"
    },
    "archive": {
      "type": "boolean"
    },
    "archiveConsentAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "counts": {
      "$ref": "#/components/schemas/ClassificationRuleCountsDto"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "enabled": {
      "type": "boolean"
    },
    "id": {
      "type": "string"
    },
    "lastAppliedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "mediaType": {
      "$ref": "#/components/schemas/ClassificationMediaType"
    },
    "personIds": {
      "description": "Match any of these people",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50,
      "type": "array"
    },
    "tag": {
      "allOf": [
        {
          "$ref": "#/components/schemas/ClassificationTagDto"
        }
      ],
      "nullable": true
    },
    "tagIds": {
      "description": "Match any of these tags, or a tag beneath one of them",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50,
      "type": "array"
    },
    "takenAfter": {
      "description": "Taken on or after this day (YYYY-MM-DD)",
      "nullable": true,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "type": "string"
    },
    "takenBefore": {
      "description": "Taken on or before this day (YYYY-MM-DD)",
      "nullable": true,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "type": "string"
    },
    "threshold": {
      "description": "The confidence a visual phrase has to reach",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    },
    "visualQueries": {
      "description": "Visual category phrases compared with each item",
      "items": {
        "maxLength": 120,
        "minLength": 1,
        "type": "string"
      },
      "maxItems": 10,
      "type": "array"
    }
  },
  "required": [
    "action",
    "albumId",
    "albumName",
    "archive",
    "archiveConsentAt",
    "counts",
    "createdAt",
    "enabled",
    "id",
    "lastAppliedAt",
    "mediaType",
    "personIds",
    "tag",
    "tagIds",
    "takenAfter",
    "takenBefore",
    "threshold",
    "updatedAt",
    "visualQueries"
  ],
  "type": "object"
}
```

## ClassificationRuleUpdateDto

Related models: [ClassificationMediaType](models-07.md#classificationmediatype), [ClassificationRuleAction](models-08.md#classificationruleaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/ClassificationRuleAction"
    },
    "archive": {
      "description": "Archive matches; turning it on requires archiveConsent",
      "type": "boolean"
    },
    "archiveConsent": {
      "description": "The owner explicitly agrees that matches are archived",
      "type": "boolean"
    },
    "enabled": {
      "description": "A disabled rule keeps what it applied and stops changing anything",
      "type": "boolean"
    },
    "mediaType": {
      "$ref": "#/components/schemas/ClassificationMediaType"
    },
    "personIds": {
      "description": "Match any of these people",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50,
      "type": "array"
    },
    "tagIds": {
      "description": "Match any of these tags, or a tag beneath one of them",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50,
      "type": "array"
    },
    "tagName": {
      "description": "The rule-owned tag a match receives; null tags nothing",
      "maxLength": 120,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "takenAfter": {
      "description": "Taken on or after this day (YYYY-MM-DD)",
      "nullable": true,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "type": "string"
    },
    "takenBefore": {
      "description": "Taken on or before this day (YYYY-MM-DD)",
      "nullable": true,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "type": "string"
    },
    "threshold": {
      "description": "The confidence a visual phrase has to reach",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "visualQueries": {
      "description": "Visual category phrases compared with each item",
      "items": {
        "maxLength": 120,
        "minLength": 1,
        "type": "string"
      },
      "maxItems": 10,
      "type": "array"
    }
  },
  "type": "object"
}
```

## ClassificationScoredAssetDto


```json
{
  "properties": {
    "assetId": {
      "type": "string"
    },
    "score": {
      "format": "double",
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "assetId",
    "score"
  ],
  "type": "object"
}
```

## ClassificationSettingsDto

Related models: [ClassificationRuleAction](models-08.md#classificationruleaction).

```json
{
  "properties": {
    "defaultAction": {
      "$ref": "#/components/schemas/ClassificationRuleAction"
    },
    "inlineLimit": {
      "description": "Changes above this many run as a durable bulk job",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "visualCategories": {
      "description": "Whether rules may use visual category phrases",
      "type": "boolean"
    },
    "visualSearchAvailable": {
      "description": "Whether visual phrases can be compared right now",
      "type": "boolean"
    }
  },
  "required": [
    "defaultAction",
    "inlineLimit",
    "visualCategories",
    "visualSearchAvailable"
  ],
  "type": "object"
}
```

## ClassificationTagDto


```json
{
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
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

## CloudBackupActiveRestoreDto

Related models: [CloudBackupRestoreScope](models-08.md#cloudbackuprestorescope), [CloudBackupRunState](models-08.md#cloudbackuprunstate).

```json
{
  "properties": {
    "bytes": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "bytesTotal": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "files": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "filesTotal": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "operationId": {
      "type": "string"
    },
    "progress": {
      "description": "0 to 100",
      "format": "double",
      "type": "number"
    },
    "scope": {
      "$ref": "#/components/schemas/CloudBackupRestoreScope"
    },
    "state": {
      "$ref": "#/components/schemas/CloudBackupRunState"
    }
  },
  "required": [
    "bytes",
    "bytesTotal",
    "files",
    "filesTotal",
    "operationId",
    "progress",
    "scope",
    "state"
  ],
  "type": "object"
}
```

## CloudBackupActiveRunDto

Related models: [CloudBackupRunPhase](models-08.md#cloudbackuprunphase), [CloudBackupRunState](models-08.md#cloudbackuprunstate), [CloudBackupTask](models-08.md#cloudbackuptask).

```json
{
  "properties": {
    "bytesUploaded": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "checked": {
      "description": "verify: files checked so far",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "operationId": {
      "type": "string"
    },
    "phase": {
      "$ref": "#/components/schemas/CloudBackupRunPhase"
    },
    "progress": {
      "description": "0 to 100",
      "format": "double",
      "type": "number"
    },
    "skipped": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "state": {
      "$ref": "#/components/schemas/CloudBackupRunState"
    },
    "task": {
      "$ref": "#/components/schemas/CloudBackupTask"
    },
    "uploaded": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "bytesUploaded",
    "checked",
    "operationId",
    "phase",
    "progress",
    "skipped",
    "state",
    "task",
    "uploaded"
  ],
  "type": "object"
}
```

## CloudBackupAlbumState


```json
{
  "description": "deleted: the album is gone; missing-items: some of its items are no longer in it; complete: nothing to bring back",
  "enum": [
    "deleted",
    "missing-items",
    "complete"
  ],
  "type": "string"
}
```

## CloudBackupBucketState


```json
{
  "description": "empty: ready to claim; claimed: holds a Frameleaf claim; not-empty: holds other files",
  "enum": [
    "empty",
    "claimed",
    "not-empty"
  ],
  "type": "string"
}
```

## CloudBackupCheckDto

Related models: [CloudBackupS3Dto](models-08.md#cloudbackups3dto).

```json
{
  "properties": {
    "s3": {
      "$ref": "#/components/schemas/CloudBackupS3Dto"
    }
  },
  "required": [
    "s3"
  ],
  "type": "object"
}
```

## CloudBackupCheckResponseDto

Related models: [CloudBackupBucketState](models-08.md#cloudbackupbucketstate).

```json
{
  "properties": {
    "message": {
      "description": "What the check found, in plain words",
      "type": "string"
    },
    "ok": {
      "description": "The bucket can be claimed for this server",
      "type": "boolean"
    },
    "state": {
      "$ref": "#/components/schemas/CloudBackupBucketState"
    }
  },
  "required": [
    "message",
    "ok",
    "state"
  ],
  "type": "object"
}
```

## CloudBackupEscrowDto


```json
{
  "properties": {
    "passphrase": {
      "description": "Wraps the bucket key before it is sent; never stored and never sent to Frameleaf Cloud",
      "maxLength": 1024,
      "minLength": 12,
      "type": "string"
    }
  },
  "required": [
    "passphrase"
  ],
  "type": "object"
}
```

## CloudBackupEscrowStatusDto


```json
{
  "properties": {
    "available": {
      "description": "Server key mode and a linked server: escrow can be turned on",
      "type": "boolean"
    },
    "stored": {
      "type": "boolean"
    },
    "storedAt": {
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "available",
    "stored",
    "storedAt"
  ],
  "type": "object"
}
```

## CloudBackupGeneratedKeyDto


```json
{
  "properties": {
    "createdAt": {
      "type": "string"
    },
    "fingerprint": {
      "description": "The key fingerprint that matches a key file to its bucket",
      "type": "string"
    },
    "key": {
      "description": "The new bucket key (base64). Shown once, for the recovery kit; never returned again",
      "type": "string"
    },
    "recoveryCode": {
      "description": "The key as the recovery kit writes it",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "fingerprint",
    "key",
    "recoveryCode"
  ],
  "type": "object"
}
```

## CloudBackupItemFilter


```json
{
  "description": "all items; only items no longer in the library; only items still in the library (or its trash)",
  "enum": [
    "all",
    "deleted",
    "in-library"
  ],
  "type": "string"
}
```

## CloudBackupItemState


```json
{
  "description": "Whether the item is in the library now, in the trash, or gone",
  "enum": [
    "active",
    "trashed",
    "deleted"
  ],
  "type": "string"
}
```

## CloudBackupKeyMode


```json
{
  "description": "server: generated by this server and kept next to its identity; own-stored: your own key with a copy on this server; own-memory: your own key, never saved",
  "enum": [
    "server",
    "own-stored",
    "own-memory"
  ],
  "type": "string"
}
```

## CloudBackupLastPruneDto


```json
{
  "properties": {
    "at": {
      "type": "string"
    },
    "bytesRemoved": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "dryRun": {
      "type": "boolean"
    },
    "dumpsRemoved": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "manifestsKept": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "manifestsRemoved": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "objectsRemoved": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "operationId": {
      "type": "string"
    }
  },
  "required": [
    "at",
    "bytesRemoved",
    "dryRun",
    "dumpsRemoved",
    "manifestsKept",
    "manifestsRemoved",
    "objectsRemoved",
    "operationId"
  ],
  "type": "object"
}
```

## CloudBackupLastRestoreDto

Related models: [CloudBackupRestoreScope](models-08.md#cloudbackuprestorescope), [CloudBackupRestoreStatus](models-08.md#cloudbackuprestorestatus).

```json
{
  "properties": {
    "at": {
      "type": "string"
    },
    "bytes": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "databaseFile": {
      "description": "The restored dump, listed by the maintenance restore",
      "nullable": true,
      "type": "string"
    },
    "destination": {
      "description": "The folder a files restore wrote to",
      "nullable": true,
      "type": "string"
    },
    "detailsRestored": {
      "description": "Items still in the library whose details came back",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "files": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "manifestKey": {
      "type": "string"
    },
    "operationId": {
      "type": "string"
    },
    "recreated": {
      "description": "Deleted items made again",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "replaced": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "scope": {
      "$ref": "#/components/schemas/CloudBackupRestoreScope"
    },
    "skipped": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "status": {
      "$ref": "#/components/schemas/CloudBackupRestoreStatus"
    }
  },
  "required": [
    "at",
    "bytes",
    "databaseFile",
    "destination",
    "detailsRestored",
    "error",
    "files",
    "manifestKey",
    "operationId",
    "recreated",
    "replaced",
    "scope",
    "skipped",
    "status"
  ],
  "type": "object"
}
```

## CloudBackupLastRunDto

Related models: [CloudBackupLastRunStatus](models-08.md#cloudbackuplastrunstatus).

```json
{
  "properties": {
    "bytesUploaded": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "finishedAt": {
      "nullable": true,
      "type": "string"
    },
    "missing": {
      "description": "Files that were not on disk",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "operationId": {
      "type": "string"
    },
    "skipped": {
      "description": "Files already in the bucket",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "startedAt": {
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/CloudBackupLastRunStatus"
    },
    "uploaded": {
      "description": "New or changed files uploaded",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "bytesUploaded",
    "error",
    "finishedAt",
    "missing",
    "operationId",
    "skipped",
    "startedAt",
    "status",
    "uploaded"
  ],
  "type": "object"
}
```

## CloudBackupLastRunStatus


```json
{
  "description": "How the last run went; waiting-for-key: an own-memory key is not loaded",
  "enum": [
    "running",
    "waiting-for-key",
    "completed",
    "failed",
    "cancelled"
  ],
  "type": "string"
}
```

## CloudBackupLastVerifyDto

Related models: [CloudBackupVerifyDepth](models-08.md#cloudbackupverifydepth), [CloudBackupVerifyStatus](models-08.md#cloudbackupverifystatus).

```json
{
  "properties": {
    "at": {
      "type": "string"
    },
    "checked": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "degradedManifests": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "depth": {
      "$ref": "#/components/schemas/CloudBackupVerifyDepth"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "mismatched": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "missing": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "operationId": {
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/CloudBackupVerifyStatus"
    }
  },
  "required": [
    "at",
    "checked",
    "degradedManifests",
    "depth",
    "error",
    "mismatched",
    "missing",
    "operationId",
    "status"
  ],
  "type": "object"
}
```

## CloudBackupLocationDto


```json
{
  "properties": {
    "city": {
      "type": "string"
    },
    "cityId": {
      "type": "string"
    },
    "country": {
      "type": "string"
    },
    "countryCode": {
      "type": "string"
    },
    "locationId": {
      "type": "string"
    }
  },
  "required": [
    "city",
    "cityId",
    "country",
    "countryCode",
    "locationId"
  ],
  "type": "object"
}
```

## CloudBackupManagedDto

Related models: [CloudBackupLocationDto](models-08.md#cloudbackuplocationdto).

```json
{
  "properties": {
    "allowanceBytes": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "extraBlocks": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "location": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudBackupLocationDto"
        }
      ],
      "nullable": true
    },
    "measuredAt": {
      "nullable": true,
      "type": "string"
    },
    "objects": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "quotaBytes": {
      "description": "Storage included with the plan; more is added in 1 TB blocks",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "readOnly": {
      "description": "Uploads are stopped; restores keep working",
      "type": "boolean"
    },
    "readOnlyReason": {
      "description": "Why uploads are stopped, as Frameleaf Cloud says: purge_hold, entitlement, unlinked, suspended, purging or plan_full (the plan is full; new items wait until it is upgraded). Open-ended: show an unknown value generically.",
      "nullable": true,
      "type": "string"
    },
    "refusal": {
      "description": "Why Frameleaf Cloud last refused backup storage",
      "nullable": true,
      "type": "string"
    },
    "storageId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "usedBytes": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "allowanceBytes",
    "extraBlocks",
    "measuredAt",
    "objects",
    "quotaBytes",
    "readOnly",
    "readOnlyReason",
    "refusal",
    "usedBytes"
  ],
  "type": "object"
}
```

## CloudBackupManifestAlbumDto

Related models: [CloudBackupAlbumState](models-08.md#cloudbackupalbumstate).

```json
{
  "properties": {
    "albumId": {
      "type": "string"
    },
    "items": {
      "description": "Items the album held in this backup",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "missing": {
      "description": "Of those, items no longer in the album",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "name": {
      "type": "string"
    },
    "ownerId": {
      "type": "string"
    },
    "ownerName": {
      "nullable": true,
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/CloudBackupAlbumState"
    }
  },
  "required": [
    "albumId",
    "items",
    "missing",
    "name",
    "ownerId",
    "ownerName",
    "state"
  ],
  "type": "object"
}
```

## CloudBackupManifestAlbumsDto


```json
{
  "properties": {
    "manifestKey": {
      "description": "The backup run’s manifest in the bucket",
      "pattern": "^m\\/\\d{8}T\\d{6}Z\\.json\\.gz$",
      "type": "string"
    }
  },
  "required": [
    "manifestKey"
  ],
  "type": "object"
}
```

## CloudBackupManifestAlbumsResponseDto

Related models: [CloudBackupManifestAlbumDto](models-08.md#cloudbackupmanifestalbumdto).

```json
{
  "properties": {
    "albums": {
      "description": "Deleted albums and albums missing items, by name",
      "items": {
        "$ref": "#/components/schemas/CloudBackupManifestAlbumDto"
      },
      "type": "array"
    },
    "hasDetails": {
      "description": "The backup records albums; false for a backup made before they were recorded",
      "type": "boolean"
    },
    "manifestKey": {
      "type": "string"
    }
  },
  "required": [
    "albums",
    "hasDetails",
    "manifestKey"
  ],
  "type": "object"
}
```

## CloudBackupManifestDto

Related models: [CloudBackupManifestStatus](models-08.md#cloudbackupmanifeststatus).

```json
{
  "properties": {
    "assets": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "bytes": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "createdAt": {
      "type": "string"
    },
    "databaseKey": {
      "description": "The database dump this backup pairs with",
      "nullable": true,
      "type": "string"
    },
    "files": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "finishedAt": {
      "nullable": true,
      "type": "string"
    },
    "key": {
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/CloudBackupManifestStatus"
    }
  },
  "required": [
    "assets",
    "bytes",
    "createdAt",
    "databaseKey",
    "files",
    "finishedAt",
    "key",
    "status"
  ],
  "type": "object"
}
```

## CloudBackupManifestItemDto

Related models: [CloudBackupItemState](models-08.md#cloudbackupitemstate).

```json
{
  "properties": {
    "assetId": {
      "type": "string"
    },
    "bytes": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "files": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "hasDetails": {
      "description": "The backup holds the item’s details, so a deleted item comes back as it was, not only as a file",
      "type": "boolean"
    },
    "locked": {
      "description": "A Locked item: never named in this list",
      "type": "boolean"
    },
    "modifiedAt": {
      "description": "When the original was last written before the backup",
      "nullable": true,
      "type": "string"
    },
    "name": {
      "description": "The original’s file name when it was backed up; empty for a Locked item",
      "type": "string"
    },
    "ownerId": {
      "nullable": true,
      "type": "string"
    },
    "ownerName": {
      "nullable": true,
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/CloudBackupItemState"
    }
  },
  "required": [
    "assetId",
    "bytes",
    "files",
    "hasDetails",
    "locked",
    "modifiedAt",
    "name",
    "ownerId",
    "ownerName",
    "state"
  ],
  "type": "object"
}
```

## CloudBackupManifestItemsDto

Related models: [CloudBackupItemFilter](models-08.md#cloudbackupitemfilter).

```json
{
  "properties": {
    "filter": {
      "$ref": "#/components/schemas/CloudBackupItemFilter"
    },
    "limit": {
      "description": "Items to return; 100 when absent",
      "maximum": 500,
      "minimum": 1,
      "type": "integer"
    },
    "manifestKey": {
      "description": "The backup run’s manifest in the bucket",
      "pattern": "^m\\/\\d{8}T\\d{6}Z\\.json\\.gz$",
      "type": "string"
    },
    "query": {
      "description": "Part of a file name",
      "maxLength": 200,
      "type": "string"
    }
  },
  "required": [
    "manifestKey"
  ],
  "type": "object"
}
```

## CloudBackupManifestItemsResponseDto

Related models: [CloudBackupManifestItemDto](models-08.md#cloudbackupmanifestitemdto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/CloudBackupManifestItemDto"
      },
      "type": "array"
    },
    "manifestKey": {
      "type": "string"
    },
    "total": {
      "description": "Items that match, of which at most `limit` are listed",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "items",
    "manifestKey",
    "total"
  ],
  "type": "object"
}
```

## CloudBackupManifestStatus


```json
{
  "enum": [
    "complete",
    "degraded"
  ],
  "type": "string"
}
```

## CloudBackupManifestsResponseDto

Related models: [CloudBackupManifestDto](models-08.md#cloudbackupmanifestdto).

```json
{
  "properties": {
    "manifests": {
      "description": "Kept backups, newest first",
      "items": {
        "$ref": "#/components/schemas/CloudBackupManifestDto"
      },
      "type": "array"
    }
  },
  "required": [
    "manifests"
  ],
  "type": "object"
}
```

## CloudBackupOwnerSetupEntitlement


```json
{
  "description": "not-applicable: not Frameleaf-managed storage; pending: not linked to Frameleaf Cloud, or the plan does not include cloud backup; seen: linked and not refused for the plan",
  "enum": [
    "not-applicable",
    "pending",
    "seen"
  ],
  "type": "string"
}
```

## CloudBackupOwnerSetupFirstRun


```json
{
  "description": "done: a backup has succeeded; queued/running: a backup is waiting or in progress; failed: the last run failed; not-started: no run yet",
  "enum": [
    "not-started",
    "queued",
    "running",
    "done",
    "failed"
  ],
  "type": "string"
}
```

## CloudBackupOwnerSetupResponseDto

Related models: [CloudBackupOwnerSetupEntitlement](models-08.md#cloudbackupownersetupentitlement), [CloudBackupOwnerSetupFirstRun](models-08.md#cloudbackupownersetupfirstrun), [CloudBackupTargetSetting](models-08.md#cloudbackuptargetsetting).

```json
{
  "properties": {
    "bucketClaimed": {
      "description": "A bucket holds this server’s Frameleaf claim",
      "type": "boolean"
    },
    "claimedAt": {
      "description": "When the bucket was claimed",
      "nullable": true,
      "type": "string"
    },
    "entitlement": {
      "$ref": "#/components/schemas/CloudBackupOwnerSetupEntitlement"
    },
    "firstRun": {
      "$ref": "#/components/schemas/CloudBackupOwnerSetupFirstRun"
    },
    "keyLoaded": {
      "description": "The backup key is loaded on this server",
      "type": "boolean"
    },
    "nextRunAt": {
      "description": "The next scheduled backup, when cloud backup is set up and on",
      "nullable": true,
      "type": "string"
    },
    "target": {
      "$ref": "#/components/schemas/CloudBackupTargetSetting"
    }
  },
  "required": [
    "bucketClaimed",
    "claimedAt",
    "entitlement",
    "firstRun",
    "keyLoaded",
    "nextRunAt",
    "target"
  ],
  "type": "object"
}
```

## CloudBackupPruneDto


```json
{
  "properties": {
    "dryRun": {
      "description": "Count what the clean-up would remove without removing anything; a clean-up needs a dry run first",
      "type": "boolean"
    }
  },
  "required": [
    "dryRun"
  ],
  "type": "object"
}
```

## CloudBackupRestoreDetails


```json
{
  "description": "How the details of an item still in the library come back. keep: only the file; fill: backed-up values fill empty fields; replace: fields that differ go back to the backup’s values",
  "enum": [
    "keep",
    "fill",
    "replace"
  ],
  "type": "string"
}
```

## CloudBackupRestoreDto

Related models: [CloudBackupRestoreDetails](models-08.md#cloudbackuprestoredetails), [CloudBackupRestoreScope](models-08.md#cloudbackuprestorescope).

```json
{
  "properties": {
    "albumId": {
      "description": "album: the album to restore",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "assetIds": {
      "description": "files: the items to restore (every item when absent); asset: exactly one item",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 10000,
      "type": "array"
    },
    "details": {
      "$ref": "#/components/schemas/CloudBackupRestoreDetails",
      "description": "asset and album: how details of items still in the library come back; keep when absent"
    },
    "manifestKey": {
      "description": "The backup run’s manifest in the bucket",
      "pattern": "^m\\/\\d{8}T\\d{6}Z\\.json\\.gz$",
      "type": "string"
    },
    "scope": {
      "$ref": "#/components/schemas/CloudBackupRestoreScope"
    }
  },
  "required": [
    "manifestKey",
    "scope"
  ],
  "type": "object"
}
```

## CloudBackupRestoreScope


```json
{
  "description": "files: into a restore folder for Library Care; asset: one item back in place (made again when it was deleted); album: an album and its members (made again when deleted); database: the dump for the maintenance restore; library: every file back in place and the dump",
  "enum": [
    "files",
    "asset",
    "album",
    "database",
    "library"
  ],
  "type": "string"
}
```

## CloudBackupRestoreStatus


```json
{
  "enum": [
    "completed",
    "failed",
    "cancelled"
  ],
  "type": "string"
}
```

## CloudBackupRunPhase


```json
{
  "description": "Where a run has got to: the database dump, the bucket listing, assets, profile images, the manifest",
  "enum": [
    "database",
    "reconcile",
    "assets",
    "profiles",
    "manifest",
    "done"
  ],
  "type": "string"
}
```

## CloudBackupRunState


```json
{
  "description": "The run in progress: waiting for a worker, running, stopping at its next checkpoint, paused, stopping",
  "enum": [
    "queued",
    "running",
    "pausing",
    "paused",
    "cancelling"
  ],
  "type": "string"
}
```

## CloudBackupS3Dto


```json
{
  "properties": {
    "accessKeyId": {
      "description": "Access key ID",
      "maxLength": 256,
      "type": "string"
    },
    "bucket": {
      "description": "An empty bucket dedicated to this server",
      "maxLength": 63,
      "type": "string"
    },
    "endpoint": {
      "description": "Storage address (HTTPS)",
      "maxLength": 2048,
      "type": "string"
    },
    "region": {
      "description": "Region; empty reads it from the storage address",
      "maxLength": 64,
      "type": "string"
    },
    "secretAccessKey": {
      "description": "Secret access key; empty uses the one stored for the same address, bucket and access key",
      "maxLength": 4096,
      "type": "string"
    }
  },
  "required": [
    "accessKeyId",
    "bucket",
    "endpoint",
    "secretAccessKey"
  ],
  "type": "object"
}
```

## CloudBackupSetupDto

Related models: [CloudBackupKeyMode](models-08.md#cloudbackupkeymode), [CloudBackupS3Dto](models-08.md#cloudbackups3dto), [CloudBackupTarget](models-08.md#cloudbackuptarget).

```json
{
  "properties": {
    "acknowledgement": {
      "description": "own-memory only: \"I understand\" that a lost key makes every backup permanently unreadable",
      "maxLength": 64,
      "type": "string"
    },
    "key": {
      "description": "The bucket key: the key file, the base64 key or the recovery code. Never returned",
      "maxLength": 4096,
      "minLength": 1,
      "type": "string"
    },
    "keyMode": {
      "$ref": "#/components/schemas/CloudBackupKeyMode"
    },
    "s3": {
      "$ref": "#/components/schemas/CloudBackupS3Dto"
    },
    "target": {
      "$ref": "#/components/schemas/CloudBackupTarget"
    }
  },
  "required": [
    "key",
    "keyMode",
    "target"
  ],
  "type": "object"
}
```

## CloudBackupStatusResponseDto

Related models: [CloudBackupActiveRestoreDto](models-08.md#cloudbackupactiverestoredto), [CloudBackupActiveRunDto](models-08.md#cloudbackupactiverundto), [CloudBackupEscrowStatusDto](models-08.md#cloudbackupescrowstatusdto), [CloudBackupKeyMode](models-08.md#cloudbackupkeymode), [CloudBackupLastPruneDto](models-08.md#cloudbackuplastprunedto), [CloudBackupLastRestoreDto](models-08.md#cloudbackuplastrestoredto), [CloudBackupLastRunDto](models-08.md#cloudbackuplastrundto), [CloudBackupLastVerifyDto](models-08.md#cloudbackuplastverifydto), [CloudBackupManagedDto](models-08.md#cloudbackupmanageddto), [CloudBackupTargetSetting](models-08.md#cloudbackuptargetsetting).

```json
{
  "properties": {
    "activeRestore": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudBackupActiveRestoreDto"
        }
      ],
      "nullable": true
    },
    "activeRun": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudBackupActiveRunDto"
        }
      ],
      "nullable": true
    },
    "bucket": {
      "nullable": true,
      "type": "string"
    },
    "claimedAt": {
      "nullable": true,
      "type": "string"
    },
    "configured": {
      "description": "A bucket is claimed and cloud backup is on",
      "type": "boolean"
    },
    "endpoint": {
      "nullable": true,
      "type": "string"
    },
    "escrow": {
      "$ref": "#/components/schemas/CloudBackupEscrowStatusDto"
    },
    "instanceId": {
      "nullable": true,
      "type": "string"
    },
    "keyFingerprint": {
      "nullable": true,
      "type": "string"
    },
    "keyLoaded": {
      "description": "The key is available to this server; false in own-memory mode until unlocked",
      "type": "boolean"
    },
    "keyMode": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudBackupKeyMode"
        }
      ],
      "nullable": true
    },
    "lastManifestKey": {
      "nullable": true,
      "type": "string"
    },
    "lastPrune": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudBackupLastPruneDto"
        }
      ],
      "nullable": true
    },
    "lastRestore": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudBackupLastRestoreDto"
        }
      ],
      "nullable": true
    },
    "lastRun": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudBackupLastRunDto"
        }
      ],
      "nullable": true
    },
    "lastSuccessAt": {
      "nullable": true,
      "type": "string"
    },
    "lastVerify": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudBackupLastVerifyDto"
        }
      ],
      "nullable": true
    },
    "managed": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudBackupManagedDto"
        }
      ],
      "description": "Frameleaf-managed storage only",
      "nullable": true
    },
    "managedAvailable": {
      "description": "Frameleaf-managed storage can be chosen: this server is linked to Frameleaf Cloud",
      "type": "boolean"
    },
    "region": {
      "nullable": true,
      "type": "string"
    },
    "target": {
      "$ref": "#/components/schemas/CloudBackupTargetSetting"
    },
    "usage": {
      "description": "Unique files this server has in the bucket and their size",
      "nullable": true,
      "properties": {
        "bytes": {
          "maximum": 9007199254740991,
          "minimum": -9007199254740991,
          "type": "integer"
        },
        "objects": {
          "maximum": 9007199254740991,
          "minimum": -9007199254740991,
          "type": "integer"
        }
      },
      "required": [
        "objects",
        "bytes"
      ],
      "type": "object"
    }
  },
  "required": [
    "activeRestore",
    "activeRun",
    "bucket",
    "claimedAt",
    "configured",
    "endpoint",
    "escrow",
    "instanceId",
    "keyFingerprint",
    "keyLoaded",
    "keyMode",
    "lastManifestKey",
    "lastPrune",
    "lastRestore",
    "lastRun",
    "lastSuccessAt",
    "lastVerify",
    "managed",
    "managedAvailable",
    "region",
    "target",
    "usage"
  ],
  "type": "object"
}
```

## CloudBackupTarget


```json
{
  "description": "managed: Frameleaf-managed storage; byo-s3: your own S3-compatible bucket",
  "enum": [
    "managed",
    "byo-s3"
  ],
  "type": "string"
}
```

## CloudBackupTargetSetting


```json
{
  "description": "off: no cloud backup; managed: Frameleaf-managed storage; byo-s3: your own S3-compatible bucket",
  "enum": [
    "off",
    "managed",
    "byo-s3"
  ],
  "type": "string"
}
```

## CloudBackupTask


```json
{
  "description": "backup: a backup run; verify: a check of the backed-up files; prune: a clean-up of runs past retention",
  "enum": [
    "backup",
    "verify",
    "prune"
  ],
  "type": "string"
}
```

## CloudBackupUnlockDto


```json
{
  "properties": {
    "key": {
      "description": "The key file, the base64 key or the recovery code. Kept in memory only",
      "maxLength": 4096,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "key"
  ],
  "type": "object"
}
```

## CloudBackupVerifyDepth


```json
{
  "description": "sample: fetch and check this week’s 1/52 of the files; full: check every referenced file is there",
  "enum": [
    "sample",
    "full"
  ],
  "type": "string"
}
```

## CloudBackupVerifyDto

Related models: [CloudBackupVerifyDepth](models-08.md#cloudbackupverifydepth).

```json
{
  "properties": {
    "depth": {
      "$ref": "#/components/schemas/CloudBackupVerifyDepth"
    }
  },
  "required": [
    "depth"
  ],
  "type": "object"
}
```

## CloudBackupVerifyStatus


```json
{
  "enum": [
    "passed",
    "degraded",
    "failed"
  ],
  "type": "string"
}
```

## CloudHeartbeatField


```json
{
  "enum": [
    "version",
    "bootId",
    "uptimeSec",
    "health",
    "endpoints",
    "remoteAccess",
    "permissions",
    "licenseKid",
    "capabilities",
    "remoteAccessSettings",
    "cloudMl",
    "cloudBackup",
    "licenseState"
  ],
  "type": "string"
}
```

## CloudLinkPendingDto


```json
{
  "properties": {
    "expiresAt": {
      "type": "string"
    },
    "intervalSeconds": {
      "description": "How often this server asks whether the code was approved",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "userCode": {
      "description": "The code to enter on the approval page, XXXX-XXXX",
      "type": "string"
    },
    "verificationUri": {
      "type": "string"
    },
    "verificationUriComplete": {
      "description": "The approval page with the code filled in; shown as a QR code",
      "type": "string"
    }
  },
  "required": [
    "expiresAt",
    "intervalSeconds",
    "userCode",
    "verificationUri",
    "verificationUriComplete"
  ],
  "type": "object"
}
```

## CloudLinkRefusal


```json
{
  "description": "Why Frameleaf Cloud refused the last link: instance-limit: the plan has no room for another server; server-refused: the server was removed from the account or the account is suspended; instance-id-taken: this server, or another one with its ID, is still registered; key-already-linked: this server’s key is already linked (a copied identity directory); region-mismatch: the account keeps its data in another region than the one this server asked for (FC-18)",
  "enum": [
    "instance-limit",
    "server-refused",
    "instance-id-taken",
    "key-already-linked",
    "region-mismatch"
  ],
  "type": "string"
}
```

## CloudLinkResult


```json
{
  "description": "How the current or last device authorization stands",
  "enum": [
    "pending",
    "approved",
    "denied",
    "expired"
  ],
  "type": "string"
}
```

## CloudLinkState


```json
{
  "description": "not-configured: FRAMELEAF_CLOUD_URL is unset and nothing is contacted; unlinked: configured but not linked; pending: waiting for approval of a device code; linked; revoked: Frameleaf Cloud ended the link",
  "enum": [
    "not-configured",
    "unlinked",
    "pending",
    "linked",
    "revoked"
  ],
  "type": "string"
}
```

## CloudMlCatalogResponseDto

Related models: [CloudMlModelDto](models-09.md#cloudmlmodeldto).

```json
{
  "properties": {
    "models": {
      "description": "Models Frameleaf Cloud offers now; retired models are left out",
      "items": {
        "$ref": "#/components/schemas/CloudMlModelDto"
      },
      "type": "array"
    }
  },
  "required": [
    "models"
  ],
  "type": "object"
}
```

## CloudMlConnection


```json
{
  "description": "not-configured: FRAMELEAF_CLOUD_URL is unset; not-linked: the server is not linked to a Frameleaf account; ready: the regional gateway answered; unavailable: linked but the cloud did not answer",
  "enum": [
    "not-configured",
    "not-linked",
    "ready",
    "unavailable"
  ],
  "type": "string"
}
```

## CloudMlConsentFeaturesDto


```json
{
  "properties": {
    "identityNames": {
      "type": "boolean"
    },
    "medicalSignals": {
      "type": "boolean"
    },
    "ocrAddon": {
      "type": "boolean"
    }
  },
  "required": [
    "identityNames",
    "medicalSignals",
    "ocrAddon"
  ],
  "type": "object"
}
```

## CloudMlConsentHistoryResponseDto

Related models: [CloudMlConsentRecordDto](models-08.md#cloudmlconsentrecorddto).

```json
{
  "properties": {
    "records": {
      "items": {
        "$ref": "#/components/schemas/CloudMlConsentRecordDto"
      },
      "type": "array"
    }
  },
  "required": [
    "records"
  ],
  "type": "object"
}
```

## CloudMlConsentRecordDto

Related models: [CloudMlConsentFeaturesDto](models-08.md#cloudmlconsentfeaturesdto).

```json
{
  "properties": {
    "acceptedAt": {
      "type": "string"
    },
    "acceptedBy": {
      "type": "string"
    },
    "features": {
      "$ref": "#/components/schemas/CloudMlConsentFeaturesDto"
    },
    "revokedAt": {
      "nullable": true,
      "type": "string"
    },
    "version": {
      "type": "string"
    }
  },
  "required": [
    "acceptedAt",
    "acceptedBy",
    "features",
    "revokedAt",
    "version"
  ],
  "type": "object"
}
```
