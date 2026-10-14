# Server API models 39

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## TimelineHighlightResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Number of assets in this year or month, the same as the time buckets report",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "highlightAssetIds": {
      "description": "The next best assets in capture order (month cards only), never including the key photo",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "keyAssetId": {
      "description": "Key photo: highest Best Photos score, then highest star rating, then most recent capture",
      "nullable": true,
      "type": "string"
    },
    "places": {
      "description": "Up to three most frequent places (city, else state, else country), busiest first. Empty when the viewer may not see locations",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "timeBucket": {
      "description": "First day of the year or month in YYYY-MM-DD format, as in GET /timeline/buckets",
      "example": "2024-01-01",
      "type": "string"
    }
  },
  "required": [
    "count",
    "highlightAssetIds",
    "keyAssetId",
    "places",
    "timeBucket"
  ],
  "type": "object"
}
```

## TimelineOrderedSort


```json
{
  "description": "filename: by original file name (locale-aware), then newest capture; rating: highest star rating first (unrated counts as 0), then newest capture",
  "enum": [
    "filename",
    "rating"
  ],
  "type": "string"
}
```

## ToggleParameters


```json
{
  "properties": {
    "enabled": {
      "default": true,
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## ToneMapping


```json
{
  "description": "Tone mapping",
  "enum": [
    "hable",
    "mobius",
    "reinhard",
    "disabled"
  ],
  "type": "string"
}
```

## TranscodeHWAccel


```json
{
  "description": "Transcode hardware acceleration",
  "enum": [
    "nvenc",
    "qsv",
    "vaapi",
    "rkmpp",
    "disabled"
  ],
  "type": "string"
}
```

## TranscodePolicy


```json
{
  "description": "Transcode policy",
  "enum": [
    "all",
    "optimal",
    "bitrate",
    "required",
    "disabled"
  ],
  "type": "string"
}
```

## TrashApplyDto

Related models: [TrashReviewAction](models-39.md#trashreviewaction), [UtilityActivityTool](models-40.md#utilityactivitytool).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/TrashReviewAction"
    },
    "ids": {
      "description": "The chosen items, for trash, restore and delete. Ignored by restore-all and empty.",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "type": "array"
    },
    "source": {
      "$ref": "#/components/schemas/UtilityActivityTool",
      "description": "The utility the change was made from. A move to the trash or a restore from Large files is kept in its activity history."
    },
    "token": {
      "description": "The token returned by the review",
      "maxLength": 128,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "action",
    "token"
  ],
  "type": "object"
}
```

## TrashItemResponseDto

Related models: [AssetTypeEnum](models-06.md#assettypeenum).

```json
{
  "properties": {
    "fileSizeInByte": {
      "description": "Size of the original, in bytes, when known",
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
    "isLocked": {
      "description": "Locked media; only listed for its owner in an unlocked session",
      "type": "boolean"
    },
    "isOffline": {
      "description": "The library scan found this external original missing and manages it; trash actions do not change it",
      "type": "boolean"
    },
    "originalFileName": {
      "description": "Original file name",
      "type": "string"
    },
    "trashedAt": {
      "description": "When the item was moved to the trash",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    }
  },
  "required": [
    "fileSizeInByte",
    "id",
    "isLocked",
    "isOffline",
    "originalFileName",
    "trashedAt",
    "type"
  ],
  "type": "object"
}
```

## TrashItemSort


```json
{
  "description": "Trash order: most recently deleted, largest original, or file name",
  "enum": [
    "recent",
    "size",
    "name"
  ],
  "type": "string"
}
```

## TrashItemsResponseDto

Related models: [TrashItemResponseDto](models-39.md#trashitemresponsedto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/TrashItemResponseDto"
      },
      "type": "array"
    },
    "nextPage": {
      "description": "The next page number, or null on the last page",
      "nullable": true,
      "type": "string"
    },
    "total": {
      "description": "Items matching the filters",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "items",
    "nextPage",
    "total"
  ],
  "type": "object"
}
```

## TrashResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Number of items in trash",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "count"
  ],
  "type": "object"
}
```

## TrashReviewAction


```json
{
  "description": "A reviewed change to items in, or into, the trash",
  "enum": [
    "trash",
    "restore",
    "restore-all",
    "delete",
    "empty"
  ],
  "type": "string"
}
```

## TrashReviewDto

Related models: [TrashReviewAction](models-39.md#trashreviewaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/TrashReviewAction"
    },
    "ids": {
      "description": "The chosen items, for trash, restore and delete. Ignored by restore-all and empty.",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "type": "array"
    }
  },
  "required": [
    "action"
  ],
  "type": "object"
}
```

## TrashReviewResponseDto

Related models: [TrashReviewAction](models-39.md#trashreviewaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/TrashReviewAction"
    },
    "bytes": {
      "description": "Combined size of their originals, in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "count": {
      "description": "Items the action will change",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "names": {
      "description": "The first file names, alphabetically",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "retainedBytes": {
      "description": "Size of those shared originals, in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "retainedOriginals": {
      "description": "Items whose original another item still uses; deleting them does not free that file",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "token": {
      "description": "Fingerprint of the reviewed set; apply refuses when the set has changed",
      "type": "string"
    }
  },
  "required": [
    "action",
    "bytes",
    "count",
    "names",
    "retainedBytes",
    "retainedOriginals",
    "token"
  ],
  "type": "object"
}
```

## TrashSummaryResponseDto


```json
{
  "properties": {
    "bytes": {
      "description": "Combined size of their originals, in bytes. Not the space deleting them frees.",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "count": {
      "description": "Items in your trash this session can see",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "offline": {
      "description": "Of those, external-library originals that went missing; the library scan manages them",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "pendingDeletion": {
      "description": "Items already permanently deleted whose files are still being removed from storage",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "bytes",
    "count",
    "offline",
    "pendingDeletion"
  ],
  "type": "object"
}
```

## TrimParameters

Related models: [VideoTrimMode](models-40.md#videotrimmode).

```json
{
  "properties": {
    "endMs": {
      "description": "Trim end time in milliseconds",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "mode": {
      "$ref": "#/components/schemas/VideoTrimMode"
    },
    "startMs": {
      "description": "Trim start time in milliseconds",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "endMs",
    "startMs"
  ],
  "type": "object"
}
```

## UpdateAlbumDto

Related models: [AssetOrder](models-06.md#assetorder).

```json
{
  "properties": {
    "albumName": {
      "description": "Album name",
      "type": "string"
    },
    "albumThumbnailAssetId": {
      "description": "Album thumbnail asset ID. Picking an item stops the cover following the newest item.",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "coverFollowsNewest": {
      "description": "Always use the newest item as the cover (true), or keep the current cover from now on (false). Cannot be true together with albumThumbnailAssetId.",
      "type": "boolean"
    },
    "description": {
      "description": "Album description",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v3",
          "state": "Updated",
          "description": "Sending an empty string is deprecated; send null instead. Empty strings will no longer be coerced to null in v4."
        }
      ]
    },
    "icon": {
      "description": "Icon: any Material Design Icons name (null = clear / use default icon)",
      "maxLength": 80,
      "nullable": true,
      "type": "string"
    },
    "isActivityEnabled": {
      "description": "Enable activity feed",
      "type": "boolean"
    },
    "order": {
      "$ref": "#/components/schemas/AssetOrder"
    },
    "parentId": {
      "description": "Collection to move the album into (null = move to top-level, omit = no change)",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "sortOrder": {
      "description": "Sibling display position. Lower values appear first. Computed by the client as a midpoint.",
      "format": "double",
      "type": "number"
    }
  },
  "type": "object"
}
```

## UpdateAlbumUserDto

Related models: [AlbumUserRole](models-02.md#albumuserrole).

```json
{
  "properties": {
    "role": {
      "$ref": "#/components/schemas/AlbumUserRole"
    }
  },
  "required": [
    "role"
  ],
  "type": "object"
}
```

## UpdateAssetDto

Related models: [AssetVisibility](models-06.md#assetvisibility).

```json
{
  "properties": {
    "city": {
      "description": "City name; kept over reverse geocoding until the item is moved again",
      "maxLength": 255,
      "nullable": true,
      "type": "string"
    },
    "country": {
      "description": "Country name; kept over reverse geocoding until the item is moved again",
      "maxLength": 255,
      "nullable": true,
      "type": "string"
    },
    "dateTimeOriginal": {
      "description": "Original date and time",
      "type": "string"
    },
    "description": {
      "description": "Asset description",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "latitude": {
      "description": "Latitude coordinate; null together with a null longitude removes the location",
      "format": "double",
      "maximum": 90,
      "minimum": -90,
      "nullable": true,
      "type": "number"
    },
    "livePhotoVideoId": {
      "description": "Live photo video ID",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "longitude": {
      "description": "Longitude coordinate; null together with a null latitude removes the location",
      "format": "double",
      "maximum": 180,
      "minimum": -180,
      "nullable": true,
      "type": "number"
    },
    "rating": {
      "description": "Rating in range [1-5] (starred), -1 (rejected), or null (unrated)",
      "maximum": 5,
      "minimum": -1,
      "nullable": true,
      "type": "integer",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        },
        {
          "version": "v3",
          "state": "Updated",
          "description": "Using 0 as a rating is no longer valid."
        }
      ],
      "x-immich-state": "Stable"
    },
    "state": {
      "description": "State or region name; kept over reverse geocoding until the item is moved again",
      "maxLength": 255,
      "nullable": true,
      "type": "string"
    },
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility"
    }
  },
  "type": "object"
}
```

## UpdateLibraryDto


```json
{
  "properties": {
    "exclusionPatterns": {
      "description": "Exclusion patterns (max 128)",
      "items": {
        "maxLength": 1024,
        "type": "string"
      },
      "maxItems": 128,
      "type": "array"
    },
    "importPaths": {
      "description": "Import paths (max 128)",
      "items": {
        "maxLength": 1024,
        "type": "string"
      },
      "maxItems": 128,
      "type": "array"
    },
    "name": {
      "description": "Library name",
      "maxLength": 160,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

## UsageByUserDto


```json
{
  "properties": {
    "photos": {
      "description": "Number of photos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "quotaSizeInBytes": {
      "description": "User quota size in bytes (null if unlimited)",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "usage": {
      "description": "Total storage usage in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usagePhotos": {
      "description": "Storage usage for photos in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usageVideos": {
      "description": "Storage usage for videos in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "userName": {
      "description": "User name",
      "type": "string"
    },
    "videos": {
      "description": "Number of videos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "photos",
    "quotaSizeInBytes",
    "usage",
    "usagePhotos",
    "usageVideos",
    "userId",
    "userName",
    "videos"
  ],
  "type": "object"
}
```

## UserAdminCreateDto

Related models: [UserAvatarColor](models-39.md#useravatarcolor).

```json
{
  "properties": {
    "avatarColor": {
      "allOf": [
        {
          "$ref": "#/components/schemas/UserAvatarColor"
        }
      ],
      "nullable": true
    },
    "email": {
      "description": "User email",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "isAdmin": {
      "description": "Grant admin privileges",
      "type": "boolean"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "notify": {
      "description": "Send notification email",
      "type": "boolean"
    },
    "password": {
      "description": "User password",
      "type": "string"
    },
    "pinCode": {
      "description": "PIN code",
      "example": "123456",
      "nullable": true,
      "pattern": "^\\d{6}$",
      "type": "string"
    },
    "quotaSizeInBytes": {
      "description": "Storage quota in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "shouldChangePassword": {
      "description": "Require password change on next login",
      "type": "boolean"
    },
    "storageLabel": {
      "description": "Storage label",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "email",
    "name",
    "password"
  ],
  "type": "object"
}
```

## UserAdminDeleteDto


```json
{
  "properties": {
    "confirmEmail": {
      "description": "The account's email as the administrator typed it to confirm; when sent, the delete is refused unless it matches (case-insensitive)",
      "maxLength": 320,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "force": {
      "description": "Force delete even if user has assets",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## UserAdminHistoryEventResponseDto

Related models: [AdminAuditAction](models-01.md#adminauditaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/AdminAuditAction"
    },
    "actorId": {
      "description": "The administrator who did it; null once that account is gone",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "actorName": {
      "description": "That administrator's name; null once that account is gone",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "description": "When it happened",
      "format": "date-time",
      "type": "string"
    },
    "detail": {
      "description": "What the action carries: a quota in bytes, a storage label, a recovery period in days, a device name or the changed preference sections; null otherwise",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Event ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "libraryId": {
      "description": "The library a library event is about; null for account events and once the library is gone",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "subject": {
      "description": "The account's or library's name at the time",
      "type": "string"
    }
  },
  "required": [
    "action",
    "actorId",
    "actorName",
    "createdAt",
    "detail",
    "id",
    "libraryId",
    "subject"
  ],
  "type": "object"
}
```

## UserAdminHistoryResponseDto

Related models: [UserAdminHistoryEventResponseDto](models-39.md#useradminhistoryeventresponsedto).

```json
{
  "properties": {
    "events": {
      "description": "Newest first",
      "items": {
        "$ref": "#/components/schemas/UserAdminHistoryEventResponseDto"
      },
      "type": "array"
    },
    "hasMore": {
      "description": "True when older events exist beyond this page",
      "type": "boolean"
    }
  },
  "required": [
    "events",
    "hasMore"
  ],
  "type": "object"
}
```

## UserAdminPinCodeStateResponseDto


```json
{
  "properties": {
    "pinCode": {
      "description": "Whether the account has a PIN set",
      "type": "boolean"
    }
  },
  "required": [
    "pinCode"
  ],
  "type": "object"
}
```

## UserAdminResponseDto

Related models: [UserAvatarColor](models-39.md#useravatarcolor), [UserLicense](models-39.md#userlicense), [UserStatus](models-40.md#userstatus).

```json
{
  "properties": {
    "avatarColor": {
      "$ref": "#/components/schemas/UserAvatarColor"
    },
    "clusterGroupId": {
      "description": "Cluster group the user is a member of",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "deletedAt": {
      "description": "Deletion date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "email": {
      "description": "User email",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "id": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isAdmin": {
      "description": "Is admin user",
      "type": "boolean"
    },
    "license": {
      "allOf": [
        {
          "$ref": "#/components/schemas/UserLicense"
        }
      ],
      "nullable": true
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "oauthId": {
      "description": "OAuth ID",
      "type": "string"
    },
    "profileChangedAt": {
      "description": "Profile change date",
      "format": "date-time",
      "type": "string"
    },
    "profileImagePath": {
      "description": "Profile image path",
      "type": "string"
    },
    "quotaSizeInBytes": {
      "description": "Storage quota in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "quotaUsageInBytes": {
      "description": "Storage usage in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "shouldChangePassword": {
      "description": "Require password change on next login",
      "type": "boolean"
    },
    "status": {
      "$ref": "#/components/schemas/UserStatus"
    },
    "storageLabel": {
      "description": "Storage label",
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "avatarColor",
    "clusterGroupId",
    "createdAt",
    "deletedAt",
    "email",
    "id",
    "isAdmin",
    "license",
    "name",
    "oauthId",
    "profileChangedAt",
    "profileImagePath",
    "quotaSizeInBytes",
    "quotaUsageInBytes",
    "shouldChangePassword",
    "status",
    "storageLabel",
    "updatedAt"
  ],
  "type": "object"
}
```

## UserAdminUpdateDto

Related models: [UserAvatarColor](models-39.md#useravatarcolor).

```json
{
  "properties": {
    "avatarColor": {
      "allOf": [
        {
          "$ref": "#/components/schemas/UserAvatarColor"
        }
      ],
      "nullable": true
    },
    "email": {
      "description": "User email",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "isAdmin": {
      "description": "Grant admin privileges",
      "type": "boolean"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "password": {
      "description": "User password",
      "type": "string"
    },
    "pinCode": {
      "description": "PIN code",
      "example": "123456",
      "nullable": true,
      "pattern": "^\\d{6}$",
      "type": "string"
    },
    "quotaSizeInBytes": {
      "description": "Storage quota in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "shouldChangePassword": {
      "description": "Require password change on next login",
      "type": "boolean"
    },
    "storageLabel": {
      "description": "Storage label",
      "nullable": true,
      "type": "string"
    }
  },
  "type": "object"
}
```

## UserAvatarColor


```json
{
  "description": "User avatar color",
  "enum": [
    "primary",
    "pink",
    "red",
    "yellow",
    "blue",
    "green",
    "purple",
    "orange",
    "gray",
    "amber"
  ],
  "type": "string"
}
```

## UserConfigClipDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## UserConfigDto

Related models: [UserConfigFFmpegDto](models-39.md#userconfigffmpegdto), [UserConfigFrameleafCloudDto](models-39.md#userconfigframeleafclouddto), [UserConfigImageDto](models-39.md#userconfigimagedto), [UserConfigMachineLearningDto](models-39.md#userconfigmachinelearningdto), [UserConfigMapDto](models-39.md#userconfigmapdto), [UserConfigOAuthDto](models-39.md#userconfigoauthdto), [UserConfigPasswordLoginDto](models-39.md#userconfigpasswordlogindto), [UserConfigReverseGeocodingDto](models-39.md#userconfigreversegeocodingdto), [UserConfigServerDto](models-39.md#userconfigserverdto), [UserConfigThemeDto](models-39.md#userconfigthemedto), [UserConfigTrashDto](models-39.md#userconfigtrashdto), [UserConfigUserDto](models-39.md#userconfiguserdto).

```json
{
  "description": "Configuration properties that are visible to a logged user",
  "properties": {
    "ffmpeg": {
      "$ref": "#/components/schemas/UserConfigFFmpegDto"
    },
    "frameleafCloud": {
      "$ref": "#/components/schemas/UserConfigFrameleafCloudDto"
    },
    "image": {
      "$ref": "#/components/schemas/UserConfigImageDto"
    },
    "machineLearning": {
      "$ref": "#/components/schemas/UserConfigMachineLearningDto"
    },
    "map": {
      "$ref": "#/components/schemas/UserConfigMapDto"
    },
    "oauth": {
      "$ref": "#/components/schemas/UserConfigOAuthDto"
    },
    "passwordLogin": {
      "$ref": "#/components/schemas/UserConfigPasswordLoginDto"
    },
    "reverseGeocoding": {
      "$ref": "#/components/schemas/UserConfigReverseGeocodingDto"
    },
    "server": {
      "$ref": "#/components/schemas/UserConfigServerDto"
    },
    "theme": {
      "$ref": "#/components/schemas/UserConfigThemeDto"
    },
    "trash": {
      "$ref": "#/components/schemas/UserConfigTrashDto"
    },
    "user": {
      "$ref": "#/components/schemas/UserConfigUserDto"
    }
  },
  "required": [
    "ffmpeg",
    "frameleafCloud",
    "image",
    "machineLearning",
    "map",
    "oauth",
    "passwordLogin",
    "reverseGeocoding",
    "server",
    "theme",
    "trash",
    "user"
  ],
  "type": "object"
}
```

## UserConfigDuplicateDetectionDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## UserConfigFFmpegDto

Related models: [UserConfigFFmpegRealtimeDto](models-39.md#userconfigffmpegrealtimedto).

```json
{
  "properties": {
    "realtime": {
      "$ref": "#/components/schemas/UserConfigFFmpegRealtimeDto"
    }
  },
  "required": [
    "realtime"
  ],
  "type": "object"
}
```

## UserConfigFFmpegRealtimeDto

Related models: [HlsVideoResolution](models-13.md#hlsvideoresolution), [VideoCodec](models-40.md#videocodec).

```json
{
  "properties": {
    "enabled": {
      "description": "Enable real-time HLS transcoding (alpha)",
      "type": "boolean"
    },
    "resolutions": {
      "description": "Resolutions to use for real-time HLS transcoding",
      "items": {
        "$ref": "#/components/schemas/HlsVideoResolution"
      },
      "type": "array"
    },
    "videoCodecs": {
      "description": "Video codecs to use for real-time HLS transcoding",
      "items": {
        "$ref": "#/components/schemas/VideoCodec"
      },
      "type": "array"
    }
  },
  "required": [
    "enabled",
    "resolutions",
    "videoCodecs"
  ],
  "type": "object"
}
```

## UserConfigFacialRecognitionDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    },
    "minFaces": {
      "description": "Minimum number of faces required for recognition",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "enabled",
    "minFaces"
  ],
  "type": "object"
}
```

## UserConfigFrameleafCloudDto

Related models: [UserConfigFrameleafSignInDto](models-39.md#userconfigframeleafsignindto).

```json
{
  "properties": {
    "signIn": {
      "$ref": "#/components/schemas/UserConfigFrameleafSignInDto"
    }
  },
  "required": [
    "signIn"
  ],
  "type": "object"
}
```

## UserConfigFrameleafSignInDto


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

## UserConfigGeneratedFullsizeImageDto


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

## UserConfigGeneratedImageDto


```json
{
  "properties": {
    "size": {
      "description": "Size",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "size"
  ],
  "type": "object"
}
```

## UserConfigImageDescriptionDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## UserConfigImageDto

Related models: [UserConfigGeneratedFullsizeImageDto](models-39.md#userconfiggeneratedfullsizeimagedto), [UserConfigGeneratedImageDto](models-39.md#userconfiggeneratedimagedto).

```json
{
  "properties": {
    "fullsize": {
      "$ref": "#/components/schemas/UserConfigGeneratedFullsizeImageDto"
    },
    "preview": {
      "$ref": "#/components/schemas/UserConfigGeneratedImageDto"
    },
    "thumbnail": {
      "$ref": "#/components/schemas/UserConfigGeneratedImageDto"
    }
  },
  "required": [
    "fullsize",
    "preview",
    "thumbnail"
  ],
  "type": "object"
}
```

## UserConfigMachineLearningDto

Related models: [UserConfigClipDto](models-39.md#userconfigclipdto), [UserConfigDuplicateDetectionDto](models-39.md#userconfigduplicatedetectiondto), [UserConfigFacialRecognitionDto](models-39.md#userconfigfacialrecognitiondto), [UserConfigImageDescriptionDto](models-39.md#userconfigimagedescriptiondto), [UserConfigNsfwDetectionDto](models-39.md#userconfignsfwdetectiondto), [UserConfigOcrDto](models-39.md#userconfigocrdto).

```json
{
  "properties": {
    "clip": {
      "$ref": "#/components/schemas/UserConfigClipDto"
    },
    "duplicateDetection": {
      "$ref": "#/components/schemas/UserConfigDuplicateDetectionDto"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "facialRecognition": {
      "$ref": "#/components/schemas/UserConfigFacialRecognitionDto"
    },
    "imageDescription": {
      "$ref": "#/components/schemas/UserConfigImageDescriptionDto"
    },
    "nsfwDetection": {
      "$ref": "#/components/schemas/UserConfigNsfwDetectionDto"
    },
    "ocr": {
      "$ref": "#/components/schemas/UserConfigOcrDto"
    }
  },
  "required": [
    "clip",
    "duplicateDetection",
    "enabled",
    "facialRecognition",
    "imageDescription",
    "nsfwDetection",
    "ocr"
  ],
  "type": "object"
}
```

## UserConfigMapDto


```json
{
  "properties": {
    "darkStyle": {
      "description": "Dark map style URL",
      "format": "uri",
      "type": "string"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "lightStyle": {
      "description": "Light map style URL",
      "format": "uri",
      "type": "string"
    }
  },
  "required": [
    "darkStyle",
    "enabled",
    "lightStyle"
  ],
  "type": "object"
}
```

## UserConfigNsfwDetectionDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## UserConfigOAuthDto


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

## UserConfigOcrDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## UserConfigPasswordLoginDto


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

## UserConfigReverseGeocodingDto


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

## UserConfigServerDto


```json
{
  "properties": {
    "externalDomain": {
      "description": "External domain",
      "type": "string"
    },
    "loginPageMessage": {
      "description": "Login page message",
      "type": "string"
    },
    "name": {
      "description": "Server name shown in settings; empty uses the host name",
      "maxLength": 100,
      "type": "string"
    },
    "publicUsers": {
      "description": "Public users",
      "type": "boolean"
    }
  },
  "required": [
    "externalDomain",
    "loginPageMessage",
    "name",
    "publicUsers"
  ],
  "type": "object"
}
```

## UserConfigThemeDto


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

## UserConfigTrashDto


```json
{
  "properties": {
    "days": {
      "description": "Days",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    }
  },
  "required": [
    "days",
    "enabled"
  ],
  "type": "object"
}
```

## UserConfigUserDto


```json
{
  "properties": {
    "deleteDelay": {
      "description": "Delete delay",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "deleteDelay"
  ],
  "type": "object"
}
```

## UserLicense


```json
{
  "properties": {
    "activatedAt": {
      "description": "Activation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "keyHint": {
      "description": "Last four symbols of the key",
      "type": "string"
    },
    "kind": {
      "description": "Supporter key kind; personal keys are always individual",
      "enum": [
        "individual"
      ],
      "type": "string"
    }
  },
  "required": [
    "activatedAt",
    "keyHint",
    "kind"
  ],
  "type": "object"
}
```

## UserMeResponseDto

Related models: [ServerRole](models-32.md#serverrole), [UserAvatarColor](models-39.md#useravatarcolor), [UserLicense](models-39.md#userlicense), [UserStatus](models-40.md#userstatus).

```json
{
  "properties": {
    "avatarColor": {
      "$ref": "#/components/schemas/UserAvatarColor"
    },
    "canUpload": {
      "description": "Whether you may upload to this server, so an app shows backup (\"this phone backs up here\") only where it is true: false only for an API key without asset.upload",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    },
    "clusterGroupId": {
      "description": "Cluster group the user is a member of",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "deletedAt": {
      "description": "Deletion date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "email": {
      "description": "User email",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "id": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isAdmin": {
      "description": "Is admin user",
      "type": "boolean"
    },
    "license": {
      "allOf": [
        {
          "$ref": "#/components/schemas/UserLicense"
        }
      ],
      "nullable": true
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "oauthId": {
      "description": "OAuth ID",
      "type": "string"
    },
    "profileChangedAt": {
      "description": "Profile change date",
      "format": "date-time",
      "type": "string"
    },
    "profileImagePath": {
      "description": "Profile image path",
      "type": "string"
    },
    "quotaSizeInBytes": {
      "description": "Storage quota in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "quotaUsageInBytes": {
      "description": "Storage usage in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "serverRole": {
      "$ref": "#/components/schemas/ServerRole",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    },
    "shouldChangePassword": {
      "description": "Require password change on next login",
      "type": "boolean"
    },
    "status": {
      "$ref": "#/components/schemas/UserStatus"
    },
    "storageLabel": {
      "description": "Storage label",
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "avatarColor",
    "canUpload",
    "clusterGroupId",
    "createdAt",
    "deletedAt",
    "email",
    "id",
    "isAdmin",
    "license",
    "name",
    "oauthId",
    "profileChangedAt",
    "profileImagePath",
    "quotaSizeInBytes",
    "quotaUsageInBytes",
    "serverRole",
    "shouldChangePassword",
    "status",
    "storageLabel",
    "updatedAt"
  ],
  "type": "object"
}
```

## UserMetadataKey


```json
{
  "description": "User metadata key",
  "enum": [
    "preferences",
    "pinned-collections",
    "photography-workspace",
    "license",
    "onboarding",
    "frameleaf-cloud-tour",
    "partner-locked-notice"
  ],
  "type": "string"
}
```

## UserPreferenceHistoryChangeDto


```json
{
  "properties": {
    "after": {
      "description": "The value after, JSON encoded; null when protected",
      "nullable": true,
      "type": "string"
    },
    "before": {
      "description": "The value before, JSON encoded; null when protected",
      "nullable": true,
      "type": "string"
    },
    "path": {
      "description": "The changed preference, as a dotted path such as memories.enabled",
      "type": "string"
    },
    "protected": {
      "description": "Changed, but its values are not recorded (Locked content)",
      "type": "boolean"
    }
  },
  "required": [
    "after",
    "before",
    "path"
  ],
  "type": "object"
}
```

## UserPreferenceHistoryEntryDto

Related models: [UserPreferenceHistoryChangeDto](models-39.md#userpreferencehistorychangedto).

```json
{
  "properties": {
    "changes": {
      "description": "Every changed preference",
      "items": {
        "$ref": "#/components/schemas/UserPreferenceHistoryChangeDto"
      },
      "type": "array"
    },
    "createdAt": {
      "description": "When the change was saved",
      "format": "date-time",
      "type": "string"
    },
    "deviceLabel": {
      "description": "The device that saved it, such as \"macOS · Web\"",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Entry ID",
      "type": "string"
    },
    "omittedChanges": {
      "description": "Changed preferences left out because the entry reached its limit",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "changes",
    "createdAt",
    "deviceLabel",
    "id",
    "omittedChanges"
  ],
  "type": "object"
}
```

## UserPreferenceHistoryResponseDto

Related models: [UserPreferenceHistoryEntryDto](models-39.md#userpreferencehistoryentrydto).

```json
{
  "properties": {
    "entries": {
      "description": "The newest preference changes first",
      "items": {
        "$ref": "#/components/schemas/UserPreferenceHistoryEntryDto"
      },
      "type": "array"
    }
  },
  "required": [
    "entries"
  ],
  "type": "object"
}
```

## UserPreferencesResponseDto

Related models: [AlbumsResponse](models-02.md#albumsresponse), [CastResponse](models-08.md#castresponse), [DownloadResponse](models-11.md#downloadresponse), [EmailNotificationsResponse](models-11.md#emailnotificationsresponse), [FoldersResponse](models-12.md#foldersresponse), [MemoriesResponse](models-17.md#memoriesresponse), [PeopleResponse](models-19.md#peopleresponse), [PrivacyResponse](models-28.md#privacyresponse), [PurchaseResponse](models-28.md#purchaseresponse), [RatingsResponse](models-29.md#ratingsresponse), [RecentlyAddedResponse](models-29.md#recentlyaddedresponse), [SavedSearch](models-30.md#savedsearch), [SharedLinksResponse](models-32.md#sharedlinksresponse), [TagsResponse](models-38.md#tagsresponse).

```json
{
  "properties": {
    "albums": {
      "$ref": "#/components/schemas/AlbumsResponse"
    },
    "cast": {
      "$ref": "#/components/schemas/CastResponse"
    },
    "download": {
      "$ref": "#/components/schemas/DownloadResponse"
    },
    "emailNotifications": {
      "$ref": "#/components/schemas/EmailNotificationsResponse"
    },
    "folders": {
      "$ref": "#/components/schemas/FoldersResponse"
    },
    "lockedRulesRevealed": {
      "description": "Whether privacy.suppression names the account's Locked people, pets and tags. False when they were blanked (a session that is not unlocked, or an administrator); such rules must never be edited and saved back (FL-67)",
      "type": "boolean"
    },
    "memories": {
      "$ref": "#/components/schemas/MemoriesResponse"
    },
    "notifications": {
      "properties": {
        "devices": {
          "items": {
            "properties": {
              "locale": {
                "maxLength": 64,
                "type": "string"
              },
              "sessionId": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
                "type": "string"
              }
            },
            "required": [
              "sessionId",
              "locale"
            ],
            "type": "object"
          },
          "maxItems": 100,
          "type": "array"
        },
        "locale": {
          "maxLength": 64,
          "type": "string"
        }
      },
      "type": "object"
    },
    "people": {
      "$ref": "#/components/schemas/PeopleResponse"
    },
    "privacy": {
      "$ref": "#/components/schemas/PrivacyResponse"
    },
    "purchase": {
      "$ref": "#/components/schemas/PurchaseResponse"
    },
    "ratings": {
      "$ref": "#/components/schemas/RatingsResponse"
    },
    "recentlyAdded": {
      "$ref": "#/components/schemas/RecentlyAddedResponse"
    },
    "revision": {
      "description": "Changes whenever the stored preferences change; send it back as expectedRevision to reject stale saves",
      "type": "string"
    },
    "savedSearches": {
      "description": "Saved searches (always present). Empty for an administrator, and without any that names a Locked person, pet or tag while the session is locked",
      "items": {
        "$ref": "#/components/schemas/SavedSearch"
      },
      "type": "array",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "sharedLinks": {
      "$ref": "#/components/schemas/SharedLinksResponse"
    },
    "tags": {
      "$ref": "#/components/schemas/TagsResponse"
    }
  },
  "required": [
    "albums",
    "cast",
    "download",
    "emailNotifications",
    "folders",
    "lockedRulesRevealed",
    "memories",
    "people",
    "privacy",
    "purchase",
    "ratings",
    "recentlyAdded",
    "revision",
    "sharedLinks",
    "tags"
  ],
  "type": "object"
}
```
