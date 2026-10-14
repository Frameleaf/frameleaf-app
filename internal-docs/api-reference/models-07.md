# Server API models 7

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## BestPhotoAssetResponseDto

Related models: [AssetStackResponseDto](models-06.md#assetstackresponsedto), [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [BestPhotoScoreDto](models-07.md#bestphotoscoredto), [ExifResponseDto](models-12.md#exifresponsedto), [ImageEncodingInfo](models-14.md#imageencodinginfo), [LandmarkSummaryDto](models-15.md#landmarksummarydto), [PartnerOriginDto](models-19.md#partnerorigindto), [PersonResponseDto](models-19.md#personresponsedto), [TagResponseDto](models-38.md#tagresponsedto), [UserResponseDto](models-40.md#userresponsedto).

```json
{
  "properties": {
    "bestPhotoScore": {
      "$ref": "#/components/schemas/BestPhotoScoreDto"
    },
    "checksum": {
      "description": "Base64-encoded file checksum. SHA-256 (44 chars) for assets uploaded after the SHA-256 transition; SHA-1 (28 chars) for legacy assets. Use the asset `checksumAlgorithm` field to disambiguate when length-based detection is insufficient.",
      "type": "string"
    },
    "createdAt": {
      "description": "The UTC timestamp when the asset was originally uploaded to Frameleaf.",
      "format": "date-time",
      "type": "string"
    },
    "duplicateId": {
      "description": "Duplicate group ID",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "duration": {
      "description": "Video/gif duration in milliseconds (null for static images)",
      "maximum": 2147483647,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "exifInfo": {
      "$ref": "#/components/schemas/ExifResponseDto"
    },
    "fileCreatedAt": {
      "description": "The actual UTC timestamp when the file was created/captured, preserving timezone information. This is the authoritative timestamp for chronological sorting within timeline groups. Combined with timezone data, this can be used to determine the exact moment the photo was taken.",
      "format": "date-time",
      "type": "string"
    },
    "fileModifiedAt": {
      "description": "The UTC timestamp when the file was last modified on the filesystem. This reflects the last time the physical file was changed, which may be different from when the photo was originally taken.",
      "format": "date-time",
      "type": "string"
    },
    "hasMetadata": {
      "description": "Whether asset has metadata",
      "type": "boolean"
    },
    "height": {
      "description": "Asset height",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "id": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "imageEncoding": {
      "$ref": "#/components/schemas/ImageEncodingInfo",
      "description": "Source image color encoding; unprocessed or unavailable evidence remains unknown"
    },
    "imageRenditions": {
      "description": "Available current still renditions; omitted when file evidence was not loaded",
      "properties": {
        "hdrFullsize": {
          "type": "boolean"
        },
        "hdrPreview": {
          "type": "boolean"
        },
        "sdrFullsize": {
          "type": "boolean"
        },
        "sdrPreview": {
          "type": "boolean"
        }
      },
      "required": [
        "sdrPreview",
        "sdrFullsize",
        "hdrPreview",
        "hdrFullsize"
      ],
      "type": "object"
    },
    "isArchived": {
      "description": "Is archived",
      "type": "boolean"
    },
    "isEdited": {
      "description": "Is edited",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v2.5.0",
          "state": "Added"
        },
        {
          "version": "v2.5.0",
          "state": "Beta"
        }
      ],
      "x-immich-state": "Beta"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean"
    },
    "isOffline": {
      "description": "Is offline",
      "type": "boolean"
    },
    "isTrashed": {
      "description": "Is trashed",
      "type": "boolean"
    },
    "landmarks": {
      "description": "Landmarks this asset was taken at, the most specific first. Only on the single-asset response.",
      "items": {
        "$ref": "#/components/schemas/LandmarkSummaryDto"
      },
      "type": "array"
    },
    "libraryId": {
      "description": "Library ID",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v1",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    },
    "livePhotoVideoId": {
      "description": "Live photo video ID",
      "nullable": true,
      "type": "string"
    },
    "localDateTime": {
      "description": "The local date and time when the photo/video was taken, derived from EXIF metadata. This represents the photographer's local time regardless of timezone, stored as a timezone-agnostic timestamp. Used for timeline grouping by \"local\" days and months.",
      "format": "date-time",
      "type": "string"
    },
    "origin": {
      "$ref": "#/components/schemas/PartnerOriginDto",
      "description": "Present on your own asset when partner sharing copied it from another library (GET /assets/{id})"
    },
    "originalFileName": {
      "description": "Original file name",
      "type": "string"
    },
    "originalMimeType": {
      "description": "Original MIME type",
      "type": "string"
    },
    "originalPath": {
      "description": "Original file path",
      "type": "string"
    },
    "owner": {
      "$ref": "#/components/schemas/UserResponseDto"
    },
    "ownerId": {
      "description": "Owner user ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "people": {
      "items": {
        "$ref": "#/components/schemas/PersonResponseDto"
      },
      "type": "array"
    },
    "resized": {
      "description": "Is resized",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v1.113.0",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    },
    "stack": {
      "allOf": [
        {
          "$ref": "#/components/schemas/AssetStackResponseDto"
        }
      ],
      "nullable": true
    },
    "tags": {
      "items": {
        "$ref": "#/components/schemas/TagResponseDto"
      },
      "type": "array"
    },
    "thumbhash": {
      "description": "Thumbhash for thumbnail generation (base64) also used as the c query param for thumbnail cache busting.",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "updatedAt": {
      "description": "The UTC timestamp when the asset record was last updated in the database. This is automatically maintained by the database and reflects when any field in the asset was last modified.",
      "format": "date-time",
      "type": "string"
    },
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility"
    },
    "width": {
      "description": "Asset width",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "bestPhotoScore",
    "checksum",
    "createdAt",
    "duration",
    "fileCreatedAt",
    "fileModifiedAt",
    "hasMetadata",
    "height",
    "id",
    "isArchived",
    "isEdited",
    "isFavorite",
    "isOffline",
    "isTrashed",
    "localDateTime",
    "originalFileName",
    "originalPath",
    "ownerId",
    "thumbhash",
    "type",
    "updatedAt",
    "visibility",
    "width"
  ],
  "type": "object"
}
```

## BestPhotoScoreDto


```json
{
  "properties": {
    "aestheticScore": {
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "nullable": true,
      "type": "number"
    },
    "bestFrameTimestampMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "computedAt": {
      "format": "date-time",
      "type": "string"
    },
    "diversityScore": {
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "nullable": true,
      "type": "number"
    },
    "frameMetadata": {
      "additionalProperties": {},
      "nullable": true,
      "type": "object"
    },
    "frameScore": {
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "nullable": true,
      "type": "number"
    },
    "metadata": {
      "additionalProperties": {},
      "nullable": true,
      "type": "object"
    },
    "score": {
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "scoreVersion": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "subjectScore": {
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "nullable": true,
      "type": "number"
    },
    "technicalScore": {
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "aestheticScore",
    "bestFrameTimestampMs",
    "computedAt",
    "diversityScore",
    "frameMetadata",
    "frameScore",
    "metadata",
    "score",
    "scoreVersion",
    "subjectScore",
    "technicalScore"
  ],
  "type": "object"
}
```

## BestPhotosResponseDto

Related models: [BestPhotoAssetResponseDto](models-07.md#bestphotoassetresponsedto).

```json
{
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/BestPhotoAssetResponseDto"
      },
      "type": "array"
    },
    "nextPage": {
      "nullable": true,
      "type": "string"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "count",
    "items",
    "nextPage",
    "total"
  ],
  "type": "object"
}
```

## BirthdayMemoryDto


```json
{
  "properties": {
    "age": {
      "description": "Age reached on this birthday",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "date": {
      "description": "The birthday this year, 'yyyy-MM-dd'",
      "type": "string"
    },
    "kind": {
      "description": "Discriminator for a birthday",
      "enum": [
        "birthday"
      ],
      "type": "string"
    },
    "name": {
      "description": "Their name when the memory was made",
      "type": "string"
    },
    "subject": {
      "description": "Whether the birthday is a person's or a pet's",
      "enum": [
        "person",
        "pet"
      ],
      "type": "string"
    },
    "subjectId": {
      "description": "The owner's person or pet whose birthday it is",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "year": {
      "description": "Year of this birthday",
      "maximum": 9999,
      "minimum": 1000,
      "type": "integer"
    }
  },
  "required": [
    "age",
    "date",
    "kind",
    "name",
    "subject",
    "subjectId",
    "year"
  ],
  "type": "object"
}
```

## BoolFilter


```json
{
  "properties": {
    "eq": {
      "type": "boolean"
    }
  },
  "required": [
    "eq"
  ],
  "type": "object"
}
```

## BuddyAcceptDto


```json
{
  "additionalProperties": false,
  "properties": {
    "instanceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "quotaBytes": {
      "maximum": 9007199254740991,
      "minimum": 10737418240,
      "type": "integer"
    },
    "retention": {
      "additionalProperties": false,
      "properties": {
        "days": {
          "enum": [
            30
          ],
          "format": "double",
          "type": "number"
        },
        "monthly": {
          "enum": [
            12
          ],
          "format": "double",
          "type": "number"
        }
      },
      "required": [
        "days",
        "monthly"
      ],
      "type": "object"
    },
    "token": {
      "pattern": "^[A-Za-z0-9_-]{43}$",
      "type": "string"
    },
    "version": {
      "enum": [
        1
      ],
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "instanceId",
    "quotaBytes",
    "retention",
    "token",
    "version"
  ],
  "type": "object"
}
```

## BuddyApplyDto


```json
{
  "additionalProperties": false,
  "properties": {
    "confirm": {
      "enum": [
        true
      ],
      "type": "boolean"
    },
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "confirm",
    "operationId"
  ],
  "type": "object"
}
```

## BuddyApplyResponseDto


```json
{
  "properties": {
    "jwt": {
      "type": "string"
    }
  },
  "required": [
    "jwt"
  ],
  "type": "object"
}
```

## BuddyBrowseDto


```json
{
  "properties": {
    "albums": {
      "items": {
        "properties": {
          "id": {
            "type": "string"
          },
          "items": {
            "format": "double",
            "type": "number"
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "name",
          "items"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "items": {
      "items": {
        "properties": {
          "bytes": {
            "format": "double",
            "type": "number"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "ownerId": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "name",
          "bytes"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "nextOffset": {
      "format": "double",
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "albums",
    "items",
    "nextOffset"
  ],
  "type": "object"
}
```

## BuddyControlDto


```json
{
  "additionalProperties": false,
  "properties": {
    "action": {
      "enum": [
        "start",
        "pause-sending",
        "resume-sending",
        "pause-receiving",
        "resume-receiving",
        "restart",
        "verify"
      ],
      "type": "string"
    }
  },
  "required": [
    "action"
  ],
  "type": "object"
}
```

## BuddyEscrowDto


```json
{
  "additionalProperties": false,
  "properties": {
    "blob": {
      "maxLength": 32768,
      "minLength": 64,
      "pattern": "^[A-Za-z0-9_-]+$",
      "type": "string"
    },
    "vaultId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "version": {
      "enum": [
        1
      ],
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "blob",
    "vaultId",
    "version"
  ],
  "type": "object"
}
```

## BuddyEscrowImportDto


```json
{
  "additionalProperties": false,
  "properties": {
    "escrow": {
      "additionalProperties": false,
      "properties": {
        "blob": {
          "maxLength": 32768,
          "minLength": 64,
          "pattern": "^[A-Za-z0-9_-]+$",
          "type": "string"
        },
        "vaultId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "version": {
          "enum": [
            1
          ],
          "format": "double",
          "type": "number"
        }
      },
      "required": [
        "version",
        "vaultId",
        "blob"
      ],
      "type": "object"
    },
    "passphrase": {
      "maxLength": 1024,
      "minLength": 12,
      "type": "string"
    }
  },
  "required": [
    "escrow",
    "passphrase"
  ],
  "type": "object"
}
```

## BuddyEscrowWrapDto


```json
{
  "additionalProperties": false,
  "properties": {
    "passphrase": {
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

## BuddyInviteDto


```json
{
  "additionalProperties": false,
  "properties": {
    "instanceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "quotaBytes": {
      "maximum": 9007199254740991,
      "minimum": 10737418240,
      "type": "integer"
    },
    "retention": {
      "additionalProperties": false,
      "properties": {
        "days": {
          "enum": [
            30
          ],
          "format": "double",
          "type": "number"
        },
        "monthly": {
          "enum": [
            12
          ],
          "format": "double",
          "type": "number"
        }
      },
      "required": [
        "days",
        "monthly"
      ],
      "type": "object"
    },
    "targetAccountId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "version": {
      "enum": [
        1
      ],
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "instanceId",
    "quotaBytes",
    "retention",
    "targetAccountId",
    "version"
  ],
  "type": "object"
}
```

## BuddyInviteResponseDto


```json
{
  "additionalProperties": false,
  "properties": {
    "expiresAt": {
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "invitationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "token": {
      "pattern": "^[A-Za-z0-9_-]{43}$",
      "type": "string"
    },
    "version": {
      "enum": [
        1
      ],
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "expiresAt",
    "invitationId",
    "token",
    "version"
  ],
  "type": "object"
}
```

## BuddyKitDto


```json
{
  "additionalProperties": false,
  "properties": {
    "current": {
      "exclusiveMinimum": true,
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "keys": {
      "additionalProperties": {
        "pattern": "^[\\w-]{43}$",
        "type": "string"
      },
      "type": "object"
    },
    "vaultId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "version": {
      "enum": [
        1
      ],
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "current",
    "keys",
    "vaultId",
    "version"
  ],
  "type": "object"
}
```

## BuddyPreflightDto


```json
{
  "properties": {
    "configurationFiles": {
      "items": {
        "properties": {
          "available": {
            "type": "boolean"
          },
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path",
          "available"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "databaseBytes": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "hostingAvailableBytes": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "items": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "mounts": {
      "items": {
        "properties": {
          "available": {
            "type": "boolean"
          },
          "path": {
            "type": "string"
          }
        },
        "required": [
          "path",
          "available"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "originalBytes": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "stagingAvailableBytes": {
      "format": "double",
      "type": "number"
    },
    "timezone": {
      "type": "string"
    },
    "unknownSizes": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "configurationFiles",
    "databaseBytes",
    "hostingAvailableBytes",
    "items",
    "mounts",
    "originalBytes",
    "stagingAvailableBytes",
    "timezone",
    "unknownSizes"
  ],
  "type": "object"
}
```

## BuddyPreflightRequestDto


```json
{
  "additionalProperties": false,
  "properties": {
    "configurationFiles": {
      "default": [],
      "items": {
        "maxLength": 4096,
        "minLength": 1,
        "type": "string"
      },
      "maxItems": 32,
      "type": "array"
    },
    "directory": {
      "default": "",
      "maxLength": 4096,
      "type": "string"
    }
  },
  "type": "object"
}
```

## BuddyProbeResponseDto


```json
{
  "properties": {
    "ok": {
      "type": "boolean"
    }
  },
  "required": [
    "ok"
  ],
  "type": "object"
}
```

## BuddyRelationshipDto


```json
{
  "additionalProperties": false,
  "properties": {
    "action": {
      "enum": [
        "confirm",
        "end",
        "block"
      ],
      "type": "string"
    }
  },
  "required": [
    "action"
  ],
  "type": "object"
}
```

## BuddyRestoreCheckpointDto


```json
{
  "properties": {
    "operation": {
      "nullable": true,
      "properties": {
        "error": {
          "nullable": true,
          "type": "string"
        },
        "id": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "phase": {
          "type": "string"
        },
        "progress": {
          "format": "double",
          "nullable": true,
          "type": "number"
        },
        "recoveryId": {
          "nullable": true,
          "type": "string"
        },
        "state": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "state",
        "progress",
        "phase",
        "recoveryId",
        "error"
      ],
      "type": "object"
    }
  },
  "required": [
    "operation"
  ],
  "type": "object"
}
```

## BuddyRestoreDto


```json
{
  "additionalProperties": false,
  "properties": {
    "albumId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "assetIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      },
      "maxItems": 100,
      "minItems": 1,
      "type": "array"
    },
    "confirm": {
      "default": false,
      "type": "boolean"
    },
    "mode": {
      "default": "keep",
      "enum": [
        "keep",
        "replace"
      ],
      "type": "string"
    },
    "scope": {
      "enum": [
        "asset",
        "album",
        "library",
        "settings",
        "server"
      ],
      "type": "string"
    },
    "snapshotId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "scope",
    "snapshotId"
  ],
  "type": "object"
}
```

## BuddyRestoreResponseDto


```json
{
  "properties": {
    "bytes": {
      "format": "double",
      "type": "number"
    },
    "conflicts": {
      "format": "double",
      "type": "number"
    },
    "items": {
      "format": "double",
      "type": "number"
    },
    "metadataItems": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "mode": {
      "enum": [
        "keep",
        "replace"
      ],
      "type": "string"
    },
    "operationId": {
      "nullable": true,
      "type": "string"
    },
    "state": {
      "type": "string"
    }
  },
  "required": [
    "bytes",
    "conflicts",
    "items",
    "mode",
    "operationId",
    "state"
  ],
  "type": "object"
}
```

## BuddyRestoreStatusDto


```json
{
  "properties": {
    "error": {
      "nullable": true,
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "phase": {
      "type": "string"
    },
    "progress": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "recoveryId": {
      "nullable": true,
      "type": "string"
    },
    "state": {
      "type": "string"
    }
  },
  "required": [
    "error",
    "id",
    "phase",
    "progress",
    "recoveryId",
    "state"
  ],
  "type": "object"
}
```

## BuddySettingsDto


```json
{
  "additionalProperties": false,
  "properties": {
    "bootConfiguration": {
      "additionalProperties": false,
      "properties": {
        "environmentKeys": {
          "items": {
            "enum": [
              "FRAMELEAF_BUILD_DATA",
              "FRAMELEAF_BUILD",
              "FRAMELEAF_BUILD_URL",
              "FRAMELEAF_BUILD_IMAGE",
              "FRAMELEAF_BUILD_IMAGE_URL",
              "FRAMELEAF_CONFIG_FILE",
              "FRAMELEAF_HELMET_FILE",
              "FRAMELEAF_ENV",
              "FRAMELEAF_HOST",
              "FRAMELEAF_IGNORE_MOUNT_CHECK_ERRORS",
              "FRAMELEAF_IMPORT_ROOTS",
              "FRAMELEAF_LOG_LEVEL",
              "FRAMELEAF_LOG_FORMAT",
              "FRAMELEAF_MEDIA_LOCATION",
              "FRAMELEAF_ALLOW_EXTERNAL_PLUGINS",
              "FRAMELEAF_PLUGINS_INSTALL_FOLDER",
              "FRAMELEAF_PORT",
              "FRAMELEAF_REPOSITORY",
              "FRAMELEAF_SHUTDOWN_GRACE_SECONDS",
              "FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS",
              "FRAMELEAF_REPOSITORY_URL",
              "FRAMELEAF_SOURCE_REF",
              "FRAMELEAF_SOURCE_COMMIT",
              "FRAMELEAF_SOURCE_COMMIT_URL",
              "FRAMELEAF_ALLOW_SETUP",
              "FRAMELEAF_TRUSTED_PROXIES",
              "FRAMELEAF_WORKERS_INCLUDE",
              "FRAMELEAF_WORKERS_EXCLUDE",
              "FRAMELEAF_RECOVERY_ROOTS",
              "FRAMELEAF_ANDROID_RELEASE_URL",
              "FRAMELEAF_ANDROID_APP_ID",
              "FRAMELEAF_ANDROID_SIGNING_SHA256",
              "FRAMELEAF_IOS_APP_URL",
              "FRAMELEAF_CLOUD_URL",
              "FRAMELEAF_PUSH_URL",
              "FRAMELEAF_LICENSE_EXTRA_JWKS_FILE",
              "FRAMELEAF_IDENTITY_DIR",
              "FRAMELEAF_LINK_TOKEN",
              "FRAMELEAF_SETUP_CODE",
              "FRAMELEAF_EDGE_PORT",
              "FRAMELEAF_EDGE_BIND",
              "FRAMELEAF_ACME_DIRECTORY_URL",
              "FRAMELEAF_EDGE_SECRET",
              "FRAMELEAF_LOCAL_URL",
              "FRAMELEAF_TRUSTED_LAN_CIDRS",
              "FRAMELEAF_ANDROID_STORE_URL",
              "FRAMELEAF_DOCS_URL",
              "FRAMELEAF_SUPPORT_URL",
              "FRAMELEAF_BUG_FEATURE_URL",
              "FRAMELEAF_SOURCE_URL",
              "DB_DATABASE_NAME",
              "DB_HOSTNAME",
              "DB_PASSWORD",
              "DB_PORT",
              "DB_SKIP_MIGRATIONS",
              "DB_SSL_MODE",
              "DB_URL",
              "DB_USERNAME",
              "DB_VECTOR_EXTENSION",
              "NO_COLOR"
            ],
            "type": "string"
          },
          "maxItems": 60,
          "type": "array"
        },
        "version": {
          "enum": [
            1
          ],
          "type": "number"
        }
      },
      "required": [
        "version",
        "environmentKeys"
      ],
      "type": "object"
    },
    "configurationFiles": {
      "default": [],
      "items": {
        "maxLength": 4096,
        "minLength": 1,
        "type": "string"
      },
      "maxItems": 32,
      "type": "array"
    },
    "directory": {
      "maxLength": 4096,
      "minLength": 1,
      "type": "string"
    },
    "downloadMbps": {
      "default": 20,
      "format": "double",
      "maximum": 10000,
      "minimum": 1,
      "type": "number"
    },
    "includeDerived": {
      "default": false,
      "type": "boolean"
    },
    "pausedReceiving": {
      "default": false,
      "type": "boolean"
    },
    "pausedSending": {
      "default": false,
      "type": "boolean"
    },
    "quotaBytes": {
      "maximum": 9007199254740991,
      "minimum": 10737418240,
      "type": "integer"
    },
    "schedule": {
      "default": "0 2 * * *",
      "maxLength": 128,
      "minLength": 1,
      "type": "string"
    },
    "timezone": {
      "maxLength": 128,
      "minLength": 1,
      "type": "string"
    },
    "uploadMbps": {
      "default": 20,
      "format": "double",
      "maximum": 10000,
      "minimum": 1,
      "type": "number"
    },
    "windowEnd": {
      "default": "00:00",
      "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$",
      "type": "string"
    },
    "windowStart": {
      "default": "00:00",
      "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$",
      "type": "string"
    }
  },
  "required": [
    "directory",
    "quotaBytes",
    "timezone"
  ],
  "type": "object"
}
```

## BuddySnapshotListDto


```json
{
  "properties": {
    "nextOffset": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "snapshots": {
      "items": {
        "properties": {
          "createdAt": {
            "type": "string"
          },
          "id": {
            "type": "string"
          },
          "keyVersion": {
            "format": "double",
            "type": "number"
          },
          "sequence": {
            "format": "double",
            "type": "number"
          }
        },
        "required": [
          "id",
          "createdAt",
          "sequence",
          "keyVersion"
        ],
        "type": "object"
      },
      "type": "array"
    }
  },
  "required": [
    "nextOffset",
    "snapshots"
  ],
  "type": "object"
}
```

## BuddyStatusDto


```json
{
  "properties": {
    "availableBytes": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "capacityUpdatedAt": {
      "nullable": true,
      "type": "string"
    },
    "configured": {
      "type": "boolean"
    },
    "connection": {
      "nullable": true,
      "type": "string"
    },
    "enabled": {
      "type": "boolean"
    },
    "hosting": {
      "properties": {
        "committedBytes": {
          "format": "double",
          "type": "number"
        },
        "quotaBytes": {
          "format": "double",
          "type": "number"
        },
        "reservedBytes": {
          "format": "double",
          "type": "number"
        }
      },
      "required": [
        "committedBytes",
        "reservedBytes",
        "quotaBytes"
      ],
      "type": "object"
    },
    "instanceId": {
      "type": "string"
    },
    "keyFingerprint": {
      "nullable": true,
      "type": "string"
    },
    "lastCompleteAt": {
      "nullable": true,
      "type": "string"
    },
    "lastVerifiedAt": {
      "nullable": true,
      "type": "string"
    },
    "pairing": {
      "additionalProperties": false,
      "nullable": true,
      "properties": {
        "pairId": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "readUntil": {
          "format": "date-time",
          "nullable": true,
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
          "type": "string"
        },
        "state": {
          "enum": [
            "pending",
            "active",
            "ended",
            "blocked"
          ],
          "type": "string"
        },
        "vaults": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "destinationInstanceId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                "type": "string"
              },
              "destinationKey": {
                "additionalProperties": false,
                "properties": {
                  "crv": {
                    "enum": [
                      "Ed25519"
                    ],
                    "type": "string"
                  },
                  "kty": {
                    "enum": [
                      "OKP"
                    ],
                    "type": "string"
                  },
                  "x": {
                    "pattern": "^[A-Za-z0-9_-]{43}$",
                    "type": "string"
                  }
                },
                "required": [
                  "kty",
                  "crv",
                  "x"
                ],
                "type": "object"
              },
              "quotaBytes": {
                "maximum": 9007199254740991,
                "minimum": 10737418240,
                "type": "integer"
              },
              "retention": {
                "additionalProperties": false,
                "properties": {
                  "days": {
                    "enum": [
                      30
                    ],
                    "format": "double",
                    "type": "number"
                  },
                  "monthly": {
                    "enum": [
                      12
                    ],
                    "format": "double",
                    "type": "number"
                  }
                },
                "required": [
                  "days",
                  "monthly"
                ],
                "type": "object"
              },
              "sourceInstanceId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                "type": "string"
              },
              "sourceKey": {
                "additionalProperties": false,
                "properties": {
                  "crv": {
                    "enum": [
                      "Ed25519"
                    ],
                    "type": "string"
                  },
                  "kty": {
                    "enum": [
                      "OKP"
                    ],
                    "type": "string"
                  },
                  "x": {
                    "pattern": "^[A-Za-z0-9_-]{43}$",
                    "type": "string"
                  }
                },
                "required": [
                  "kty",
                  "crv",
                  "x"
                ],
                "type": "object"
              },
              "vaultId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                "type": "string"
              }
            },
            "required": [
              "vaultId",
              "sourceInstanceId",
              "destinationInstanceId",
              "sourceKey",
              "destinationKey",
              "quotaBytes",
              "retention"
            ],
            "type": "object"
          },
          "maxItems": 2,
          "minItems": 2,
          "type": "array"
        },
        "version": {
          "enum": [
            1
          ],
          "format": "double",
          "type": "number"
        }
      },
      "required": [
        "version",
        "pairId",
        "state",
        "readUntil",
        "vaults"
      ],
      "type": "object"
    },
    "pendingObjects": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "recoveryVerified": {
      "type": "boolean"
    },
    "run": {
      "nullable": true,
      "properties": {
        "error": {
          "nullable": true,
          "type": "string"
        },
        "finishedAt": {
          "nullable": true,
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "objects": {
          "format": "double",
          "type": "number"
        },
        "startedAt": {
          "type": "string"
        },
        "state": {
          "type": "string"
        },
        "totalBytes": {
          "format": "double",
          "type": "number"
        },
        "uploadedBytes": {
          "format": "double",
          "type": "number"
        },
        "uploadedObjects": {
          "format": "double",
          "type": "number"
        }
      },
      "required": [
        "id",
        "state",
        "startedAt",
        "finishedAt",
        "uploadedBytes",
        "totalBytes",
        "objects",
        "uploadedObjects",
        "error"
      ],
      "type": "object"
    },
    "settings": {
      "additionalProperties": false,
      "nullable": true,
      "properties": {
        "bootConfiguration": {
          "additionalProperties": false,
          "properties": {
            "environmentKeys": {
              "items": {
                "enum": [
                  "FRAMELEAF_BUILD_DATA",
                  "FRAMELEAF_BUILD",
                  "FRAMELEAF_BUILD_URL",
                  "FRAMELEAF_BUILD_IMAGE",
                  "FRAMELEAF_BUILD_IMAGE_URL",
                  "FRAMELEAF_CONFIG_FILE",
                  "FRAMELEAF_HELMET_FILE",
                  "FRAMELEAF_ENV",
                  "FRAMELEAF_HOST",
                  "FRAMELEAF_IGNORE_MOUNT_CHECK_ERRORS",
                  "FRAMELEAF_IMPORT_ROOTS",
                  "FRAMELEAF_LOG_LEVEL",
                  "FRAMELEAF_LOG_FORMAT",
                  "FRAMELEAF_MEDIA_LOCATION",
                  "FRAMELEAF_ALLOW_EXTERNAL_PLUGINS",
                  "FRAMELEAF_PLUGINS_INSTALL_FOLDER",
                  "FRAMELEAF_PORT",
                  "FRAMELEAF_REPOSITORY",
                  "FRAMELEAF_SHUTDOWN_GRACE_SECONDS",
                  "FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS",
                  "FRAMELEAF_REPOSITORY_URL",
                  "FRAMELEAF_SOURCE_REF",
                  "FRAMELEAF_SOURCE_COMMIT",
                  "FRAMELEAF_SOURCE_COMMIT_URL",
                  "FRAMELEAF_ALLOW_SETUP",
                  "FRAMELEAF_TRUSTED_PROXIES",
                  "FRAMELEAF_WORKERS_INCLUDE",
                  "FRAMELEAF_WORKERS_EXCLUDE",
                  "FRAMELEAF_RECOVERY_ROOTS",
                  "FRAMELEAF_ANDROID_RELEASE_URL",
                  "FRAMELEAF_ANDROID_APP_ID",
                  "FRAMELEAF_ANDROID_SIGNING_SHA256",
                  "FRAMELEAF_IOS_APP_URL",
                  "FRAMELEAF_CLOUD_URL",
                  "FRAMELEAF_PUSH_URL",
                  "FRAMELEAF_LICENSE_EXTRA_JWKS_FILE",
                  "FRAMELEAF_IDENTITY_DIR",
                  "FRAMELEAF_LINK_TOKEN",
                  "FRAMELEAF_SETUP_CODE",
                  "FRAMELEAF_EDGE_PORT",
                  "FRAMELEAF_EDGE_BIND",
                  "FRAMELEAF_ACME_DIRECTORY_URL",
                  "FRAMELEAF_EDGE_SECRET",
                  "FRAMELEAF_LOCAL_URL",
                  "FRAMELEAF_TRUSTED_LAN_CIDRS",
                  "FRAMELEAF_ANDROID_STORE_URL",
                  "FRAMELEAF_DOCS_URL",
                  "FRAMELEAF_SUPPORT_URL",
                  "FRAMELEAF_BUG_FEATURE_URL",
                  "FRAMELEAF_SOURCE_URL",
                  "DB_DATABASE_NAME",
                  "DB_HOSTNAME",
                  "DB_PASSWORD",
                  "DB_PORT",
                  "DB_SKIP_MIGRATIONS",
                  "DB_SSL_MODE",
                  "DB_URL",
                  "DB_USERNAME",
                  "DB_VECTOR_EXTENSION",
                  "NO_COLOR"
                ],
                "type": "string"
              },
              "maxItems": 60,
              "type": "array"
            },
            "version": {
              "enum": [
                1
              ],
              "type": "number"
            }
          },
          "required": [
            "version",
            "environmentKeys"
          ],
          "type": "object"
        },
        "configurationFiles": {
          "default": [],
          "items": {
            "maxLength": 4096,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 32,
          "type": "array"
        },
        "directory": {
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "downloadMbps": {
          "default": 20,
          "format": "double",
          "maximum": 10000,
          "minimum": 1,
          "type": "number"
        },
        "includeDerived": {
          "default": false,
          "type": "boolean"
        },
        "pausedReceiving": {
          "default": false,
          "type": "boolean"
        },
        "pausedSending": {
          "default": false,
          "type": "boolean"
        },
        "quotaBytes": {
          "maximum": 9007199254740991,
          "minimum": 10737418240,
          "type": "integer"
        },
        "schedule": {
          "default": "0 2 * * *",
          "maxLength": 128,
          "minLength": 1,
          "type": "string"
        },
        "timezone": {
          "maxLength": 128,
          "minLength": 1,
          "type": "string"
        },
        "uploadMbps": {
          "default": 20,
          "format": "double",
          "maximum": 10000,
          "minimum": 1,
          "type": "number"
        },
        "windowEnd": {
          "default": "00:00",
          "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$",
          "type": "string"
        },
        "windowStart": {
          "default": "00:00",
          "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$",
          "type": "string"
        }
      },
      "required": [
        "directory",
        "quotaBytes",
        "timezone"
      ],
      "type": "object"
    },
    "transferMbps": {
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "availableBytes",
    "capacityUpdatedAt",
    "configured",
    "connection",
    "enabled",
    "hosting",
    "instanceId",
    "keyFingerprint",
    "lastCompleteAt",
    "lastVerifiedAt",
    "pairing",
    "pendingObjects",
    "recoveryVerified",
    "run",
    "settings",
    "transferMbps"
  ],
  "type": "object"
}
```

## BulkIdErrorReason


```json
{
  "description": "Error reason",
  "enum": [
    "duplicate",
    "no_permission",
    "not_found",
    "unknown",
    "validation"
  ],
  "type": "string"
}
```

## BulkIdResponseDto

Related models: [BulkIdErrorReason](models-07.md#bulkiderrorreason).

```json
{
  "properties": {
    "error": {
      "$ref": "#/components/schemas/BulkIdErrorReason"
    },
    "errorMessage": {
      "type": "string"
    },
    "id": {
      "description": "ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "success": {
      "description": "Whether operation succeeded",
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "success"
  ],
  "type": "object"
}
```

## BulkIdsDto


```json
{
  "properties": {
    "ids": {
      "description": "IDs to process",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "ids"
  ],
  "type": "object"
}
```

## CQMode


```json
{
  "description": "CQ mode",
  "enum": [
    "auto",
    "cqp",
    "icq"
  ],
  "type": "string"
}
```

## CalendarHeatmapResponseDto


```json
{
  "properties": {
    "from": {
      "description": "Start date in UTC",
      "example": "2024-01-01",
      "type": "string"
    },
    "series": {
      "items": {
        "properties": {
          "count": {
            "description": "Activity count",
            "maximum": 9007199254740991,
            "minimum": 0,
            "type": "integer"
          },
          "date": {
            "description": "Date in UTC",
            "example": "2024-01-01",
            "type": "string"
          }
        },
        "required": [
          "date",
          "count"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "to": {
      "description": "End date in UTC",
      "example": "2024-12-31",
      "type": "string"
    },
    "totalCount": {
      "description": "Total activity count over the period",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "from",
    "series",
    "to",
    "totalCount"
  ],
  "type": "object"
}
```

## CalendarHeatmapType


```json
{
  "description": "Type of calendar heatmap",
  "enum": [
    "Upload",
    "Taken"
  ],
  "type": "string"
}
```

## CastMediaKind


```json
{
  "description": "Which rendition the receiver gets: the original file, the edited preview image, or the video stream",
  "enum": [
    "original",
    "preview",
    "video"
  ],
  "type": "string"
}
```

## CastMediaUrlCreateDto

Related models: [CastMediaKind](models-07.md#castmediakind).

```json
{
  "properties": {
    "kind": {
      "$ref": "#/components/schemas/CastMediaKind"
    }
  },
  "required": [
    "kind"
  ],
  "type": "object"
}
```
