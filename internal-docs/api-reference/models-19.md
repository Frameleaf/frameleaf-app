# Server API models 19

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## NotificationDto

Related models: [NotificationLevel](models-19.md#notificationlevel), [NotificationType](models-19.md#notificationtype).

```json
{
  "properties": {
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "data": {
      "additionalProperties": {},
      "description": "Additional notification data",
      "type": "object"
    },
    "description": {
      "description": "Notification description",
      "type": "string"
    },
    "id": {
      "description": "Notification ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "level": {
      "$ref": "#/components/schemas/NotificationLevel"
    },
    "readAt": {
      "description": "Date when notification was read",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "title": {
      "description": "Notification title",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/NotificationType"
    }
  },
  "required": [
    "createdAt",
    "id",
    "level",
    "title",
    "type"
  ],
  "type": "object"
}
```

## NotificationLevel


```json
{
  "description": "Notification level",
  "enum": [
    "success",
    "error",
    "warning",
    "info"
  ],
  "type": "string"
}
```

## NotificationType


```json
{
  "description": "Notification type",
  "enum": [
    "JobFailed",
    "BackupFailed",
    "SystemMessage",
    "AlbumInvite",
    "AlbumUpdate",
    "ItemShare",
    "ClusterGroupRequest",
    "SharedSpaceMention",
    "SharedSpaceReply",
    "Custom"
  ],
  "type": "string"
}
```

## NotificationUpdateAllDto


```json
{
  "properties": {
    "ids": {
      "description": "Notification IDs to update",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "readAt": {
      "description": "Date when notifications were read",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "ids"
  ],
  "type": "object"
}
```

## NotificationUpdateDto


```json
{
  "properties": {
    "readAt": {
      "description": "Date when notification was read",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## NsfwDetectionEnrichmentResponseDto

Related models: [ImageEnrichmentReview](models-14.md#imageenrichmentreview).

```json
{
  "properties": {
    "appliedTags": {
      "type": "boolean"
    },
    "effectiveIsNsfw": {
      "type": "boolean"
    },
    "error": {
      "type": "string"
    },
    "isNsfw": {
      "type": "boolean"
    },
    "labels": {
      "additionalProperties": {
        "format": "double",
        "type": "number"
      },
      "type": "object"
    },
    "modelName": {
      "type": "string"
    },
    "review": {
      "$ref": "#/components/schemas/ImageEnrichmentReview"
    },
    "score": {
      "format": "double",
      "type": "number"
    },
    "status": {
      "enum": [
        "missing",
        "success",
        "failed"
      ],
      "type": "string"
    },
    "updatedAt": {
      "type": "string"
    }
  },
  "required": [
    "appliedTags",
    "effectiveIsNsfw",
    "status"
  ],
  "type": "object"
}
```

## NumberFilter


```json
{
  "properties": {
    "eq": {
      "format": "double",
      "type": "number"
    },
    "gt": {
      "format": "double",
      "type": "number"
    },
    "gte": {
      "format": "double",
      "type": "number"
    },
    "in": {
      "items": {
        "format": "double",
        "type": "number"
      },
      "minItems": 1,
      "type": "array"
    },
    "lt": {
      "format": "double",
      "type": "number"
    },
    "lte": {
      "format": "double",
      "type": "number"
    },
    "ne": {
      "format": "double",
      "type": "number"
    },
    "notIn": {
      "items": {
        "format": "double",
        "type": "number"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## NumberFilterNullable


```json
{
  "properties": {
    "eq": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "gt": {
      "format": "double",
      "type": "number"
    },
    "gte": {
      "format": "double",
      "type": "number"
    },
    "in": {
      "items": {
        "format": "double",
        "type": "number"
      },
      "minItems": 1,
      "type": "array"
    },
    "lt": {
      "format": "double",
      "type": "number"
    },
    "lte": {
      "format": "double",
      "type": "number"
    },
    "ne": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "notIn": {
      "items": {
        "format": "double",
        "type": "number"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## OAuthAuthorizeResponseDto


```json
{
  "properties": {
    "url": {
      "description": "OAuth authorization URL",
      "type": "string"
    }
  },
  "required": [
    "url"
  ],
  "type": "object"
}
```

## OAuthBackchannelLogoutDto


```json
{
  "properties": {
    "logout_token": {
      "description": "OAuth logout token",
      "type": "string"
    }
  },
  "required": [
    "logout_token"
  ],
  "type": "object"
}
```

## OAuthCallbackDto


```json
{
  "properties": {
    "codeVerifier": {
      "description": "OAuth code verifier (PKCE)",
      "type": "string"
    },
    "rememberMe": {
      "description": "Persist authentication cookies across browser sessions (default true)",
      "type": "boolean"
    },
    "state": {
      "description": "OAuth state parameter",
      "type": "string"
    },
    "url": {
      "description": "OAuth callback URL",
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "url"
  ],
  "type": "object"
}
```

## OAuthConfigDto


```json
{
  "properties": {
    "codeChallenge": {
      "description": "OAuth code challenge (PKCE)",
      "type": "string"
    },
    "redirectUri": {
      "description": "OAuth redirect URI",
      "type": "string"
    },
    "state": {
      "description": "OAuth state parameter",
      "type": "string"
    }
  },
  "required": [
    "redirectUri"
  ],
  "type": "object"
}
```

## OAuthTokenEndpointAuthMethod


```json
{
  "description": "OAuth token endpoint auth method",
  "enum": [
    "client_secret_post",
    "client_secret_basic"
  ],
  "type": "string"
}
```

## OnThisDayDto


```json
{
  "properties": {
    "year": {
      "description": "Year for on this day memory",
      "maximum": 9999,
      "minimum": 1000,
      "type": "integer"
    }
  },
  "required": [
    "year"
  ],
  "type": "object"
}
```

## OnboardingDto


```json
{
  "properties": {
    "isOnboarded": {
      "description": "Is user onboarded",
      "type": "boolean"
    }
  },
  "required": [
    "isOnboarded"
  ],
  "type": "object"
}
```

## OnboardingResponseDto


```json
{
  "properties": {
    "isOnboarded": {
      "description": "Is user onboarded",
      "type": "boolean"
    }
  },
  "required": [
    "isOnboarded"
  ],
  "type": "object"
}
```

## OwnerBackupDeletionDateState


```json
{
  "enum": [
    "available",
    "unavailable"
  ],
  "type": "string"
}
```

## OwnerBackupHistoryResponseDto

Related models: [OwnerBackupDeletionDateState](models-19.md#ownerbackupdeletiondatestate), [OwnerBackupItemState](models-19.md#ownerbackupitemstate).

```json
{
  "properties": {
    "items": {
      "items": {
        "properties": {
          "assetId": {
            "type": "string"
          },
          "backupDate": {
            "type": "string"
          },
          "deletionDate": {
            "properties": {
              "at": {
                "nullable": true,
                "type": "string"
              },
              "state": {
                "$ref": "#/components/schemas/OwnerBackupDeletionDateState"
              }
            },
            "required": [
              "state",
              "at"
            ],
            "type": "object"
          },
          "name": {
            "type": "string"
          },
          "state": {
            "$ref": "#/components/schemas/OwnerBackupItemState"
          },
          "thumbnailAvailable": {
            "description": "An eligible recorded thumbnail; remote availability/integrity is checked when read",
            "type": "boolean"
          },
          "trashDate": {
            "description": "Known current trash timestamp; distinct from physical deletion",
            "nullable": true,
            "type": "string"
          }
        },
        "required": [
          "assetId",
          "name",
          "backupDate",
          "state",
          "trashDate",
          "deletionDate",
          "thumbnailAvailable"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "nextOffset": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "items",
    "nextOffset",
    "total"
  ],
  "type": "object"
}
```

## OwnerBackupItemState


```json
{
  "enum": [
    "trashed",
    "deleted"
  ],
  "type": "string"
}
```

## OwnerBackupKeptStatus


```json
{
  "enum": [
    "complete",
    "degraded"
  ],
  "type": "string"
}
```

## OwnerBackupRestoreDto


```json
{
  "properties": {
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
    "manifestKey": {
      "maxLength": 300,
      "pattern": "^m\\/\\d{8}T\\d{6}Z\\.json\\.gz$",
      "type": "string"
    }
  },
  "required": [
    "assetIds",
    "manifestKey"
  ],
  "type": "object"
}
```

## OwnerBackupRestoreResponseDto


```json
{
  "properties": {
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "status": {
      "type": "string"
    }
  },
  "required": [
    "operationId",
    "status"
  ],
  "type": "object"
}
```

## OwnerBackupsResponseDto

Related models: [OwnerBackupKeptStatus](models-19.md#ownerbackupkeptstatus).

```json
{
  "properties": {
    "backups": {
      "items": {
        "properties": {
          "backupDate": {
            "type": "string"
          },
          "manifestKey": {
            "type": "string"
          },
          "status": {
            "$ref": "#/components/schemas/OwnerBackupKeptStatus"
          }
        },
        "required": [
          "manifestKey",
          "backupDate",
          "status"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "nextOffset": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "backups",
    "nextOffset"
  ],
  "type": "object"
}
```

## PartnerBackfillDto


```json
{
  "properties": {
    "done": {
      "description": "Items copied so far",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "state": {
      "description": "Where the first copy stands",
      "enum": [
        "pending",
        "running",
        "done",
        "stopped"
      ],
      "type": "string"
    },
    "total": {
      "description": "Items to copy",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "done",
    "state",
    "total"
  ],
  "type": "object"
}
```

## PartnerCreateDto


```json
{
  "properties": {
    "sharedWithId": {
      "description": "User ID to share with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "sharedWithId"
  ],
  "type": "object"
}
```

## PartnerDirection


```json
{
  "description": "Partner direction",
  "enum": [
    "shared-by",
    "shared-with"
  ],
  "type": "string"
}
```

## PartnerLockedNoticeResponseDto


```json
{
  "properties": {
    "flaggedAt": {
      "description": "When the first Locked item arrived for an account without a PIN",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "show": {
      "description": "Whether to show the notice: Locked items arrived from a partner, no PIN is set, and it was not dismissed",
      "type": "boolean"
    }
  },
  "required": [
    "flaggedAt",
    "show"
  ],
  "type": "object"
}
```

## PartnerOriginDto


```json
{
  "properties": {
    "rootOwnerId": {
      "description": "The account that originally uploaded or created it",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "rootOwnerName": {
      "description": "That account's name",
      "type": "string"
    }
  },
  "required": [
    "rootOwnerId",
    "rootOwnerName"
  ],
  "type": "object"
}
```

## PartnerResponseDto

Related models: [PartnerBackfillDto](models-19.md#partnerbackfilldto), [UserAvatarColor](models-39.md#useravatarcolor).

```json
{
  "description": "Partner response",
  "properties": {
    "avatarColor": {
      "$ref": "#/components/schemas/UserAvatarColor"
    },
    "backfill": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PartnerBackfillDto"
        }
      ],
      "description": "FL-326: copy progress of the library shared this way; null when it was never copied",
      "nullable": true
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
    "name": {
      "description": "User name",
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
    }
  },
  "required": [
    "avatarColor",
    "email",
    "id",
    "name",
    "profileChangedAt",
    "profileImagePath"
  ],
  "type": "object"
}
```

## PartnerUpdateDto


```json
{
  "properties": {},
  "type": "object"
}
```

## PeopleListItemDto


```json
{
  "properties": {
    "assetCount": {
      "description": "Number of timeline assets showing this person",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "birthDate": {
      "description": "Person date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "color": {
      "description": "Person color (hex)",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1.126.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "featuredAssetId": {
      "description": "The photo the person's featured face is in (FL-37). Returned only to the person's owner, by GET and PUT /people/:id; null when there is none, when it is another account's photo, or when it may not be shown (trashed, hidden, Locked, a removed or invisible face, or hidden as NSFW)",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        },
        {
          "version": "v3.2.1",
          "state": "Alpha"
        }
      ],
      "x-immich-state": "Alpha"
    },
    "id": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v1.126.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "isHidden": {
      "description": "Is hidden",
      "type": "boolean"
    },
    "lastSeenAt": {
      "description": "Capture date of the most recent timeline asset showing this person",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    },
    "thumbnailPath": {
      "description": "Thumbnail path",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "format": "date-time",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1.107.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    }
  },
  "required": [
    "assetCount",
    "birthDate",
    "id",
    "isHidden",
    "lastSeenAt",
    "name",
    "thumbnailPath"
  ],
  "type": "object"
}
```

## PeopleResponse


```json
{
  "properties": {
    "enabled": {
      "description": "Whether people are enabled",
      "type": "boolean"
    },
    "minimumFaces": {
      "description": "People face threshold",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "sidebarWeb": {
      "description": "Whether people appear in web sidebar",
      "type": "boolean"
    }
  },
  "required": [
    "enabled",
    "sidebarWeb"
  ],
  "type": "object"
}
```

## PeopleResponseDto

Related models: [PeopleListItemDto](models-19.md#peoplelistitemdto).

```json
{
  "description": "People response",
  "properties": {
    "hasNextPage": {
      "description": "Whether there are more pages",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v1.110.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "hidden": {
      "description": "Number of hidden people",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "people": {
      "items": {
        "$ref": "#/components/schemas/PeopleListItemDto"
      },
      "type": "array"
    },
    "total": {
      "description": "Total number of people",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "hidden",
    "people",
    "total"
  ],
  "type": "object"
}
```

## PeopleUpdate


```json
{
  "properties": {
    "enabled": {
      "description": "Whether people are enabled",
      "type": "boolean"
    },
    "minimumFaces": {
      "description": "People face threshold",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "sidebarWeb": {
      "description": "Whether people appear in web sidebar",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## PeopleUpdateDto

Related models: [PeopleUpdateItem](models-19.md#peopleupdateitem).

```json
{
  "properties": {
    "people": {
      "description": "People to update",
      "items": {
        "$ref": "#/components/schemas/PeopleUpdateItem"
      },
      "type": "array"
    }
  },
  "required": [
    "people"
  ],
  "type": "object"
}
```

## PeopleUpdateItem


```json
{
  "properties": {
    "birthDate": {
      "description": "Person date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "color": {
      "description": "Person color (hex)",
      "nullable": true,
      "pattern": "^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$",
      "type": "string"
    },
    "featureFaceAssetId": {
      "description": "Asset ID used for feature face thumbnail",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Person visibility (hidden)",
      "type": "boolean"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
}
```

## Permission


```json
{
  "description": "List of permissions",
  "enum": [
    "all",
    "activity.create",
    "activity.read",
    "activity.update",
    "activity.delete",
    "activity.statistics",
    "apiKey.create",
    "apiKey.read",
    "apiKey.update",
    "apiKey.delete",
    "apiKey.rotate",
    "asset.read",
    "asset.update",
    "asset.delete",
    "asset.statistics",
    "asset.share",
    "asset.view",
    "asset.download",
    "asset.upload",
    "asset.copy",
    "asset.derive",
    "assetFile.read",
    "assetFile.delete",
    "assetFile.download",
    "asset.edit.get",
    "asset.edit.create",
    "asset.edit.delete",
    "album.create",
    "album.read",
    "album.update",
    "album.delete",
    "album.statistics",
    "album.share",
    "album.download",
    "albumAsset.create",
    "albumAsset.delete",
    "albumUser.create",
    "albumUser.update",
    "albumUser.delete",
    "auth.changePassword",
    "authDevice.delete",
    "archive.read",
    "backup.list",
    "backup.download",
    "backup.upload",
    "backup.delete",
    "clusterGroup.read",
    "clusterGroup.leave",
    "clusterGroupRequest.create",
    "clusterGroupRequest.read",
    "clusterGroupRequest.delete",
    "adminConfig.read",
    "adminConfig.update",
    "userConfig.read",
    "duplicate.read",
    "duplicate.delete",
    "face.create",
    "face.read",
    "face.update",
    "face.delete",
    "folder.read",
    "job.create",
    "job.read",
    "library.create",
    "library.read",
    "library.update",
    "library.delete",
    "library.statistics",
    "timeline.read",
    "timeline.download",
    "maintenance",
    "map.read",
    "map.search",
    "memory.create",
    "memory.read",
    "memory.update",
    "memory.delete",
    "memory.statistics",
    "memoryAsset.create",
    "memoryAsset.delete",
    "notification.create",
    "notification.read",
    "notification.update",
    "notification.delete",
    "partner.create",
    "partner.read",
    "partner.update",
    "partner.delete",
    "person.create",
    "person.read",
    "person.update",
    "person.delete",
    "person.statistics",
    "person.merge",
    "person.reassign",
    "pinCode.create",
    "pinCode.update",
    "pinCode.delete",
    "plugin.create",
    "plugin.read",
    "plugin.update",
    "plugin.delete",
    "server.about",
    "server.apkLinks",
    "server.storage",
    "server.statistics",
    "server.versionCheck",
    "adminCloud.read",
    "adminCloud.update",
    "adminCloud.link",
    "adminRemoteAccess.update",
    "frameleafAccount.read",
    "frameleafAccount.update",
    "adminCloudMl.read",
    "adminCloudMl.update",
    "cloudMlJob.create",
    "cloudMlJob.read",
    "adminCloudBackup.read",
    "adminCloudBackup.update",
    "adminCloudBackup.run",
    "serverLicense.read",
    "serverLicense.update",
    "serverLicense.delete",
    "session.create",
    "session.read",
    "session.update",
    "session.delete",
    "session.lock",
    "sharedLink.create",
    "sharedLink.read",
    "sharedLink.update",
    "sharedLink.delete",
    "stack.create",
    "stack.read",
    "stack.update",
    "stack.delete",
    "sync.stream",
    "syncCheckpoint.read",
    "syncCheckpoint.update",
    "syncCheckpoint.delete",
    "systemConfig.read",
    "systemConfig.update",
    "systemMetadata.read",
    "systemMetadata.update",
    "tag.create",
    "tag.read",
    "tag.update",
    "tag.delete",
    "tag.asset",
    "user.read",
    "user.update",
    "userLicense.create",
    "userLicense.read",
    "userLicense.update",
    "userLicense.delete",
    "userOnboarding.read",
    "userOnboarding.update",
    "userOnboarding.delete",
    "userPreference.read",
    "userPreference.update",
    "userProfileImage.create",
    "userProfileImage.read",
    "userProfileImage.update",
    "userProfileImage.delete",
    "queue.read",
    "queue.update",
    "queueJob.create",
    "queueJob.read",
    "queueJob.update",
    "queueJob.delete",
    "workflow.create",
    "workflow.read",
    "workflow.update",
    "workflow.delete",
    "workflow.logs",
    "adminUser.create",
    "adminUser.read",
    "adminUser.update",
    "adminUser.delete",
    "adminSession.read",
    "adminSession.delete",
    "adminAuth.unlinkAll"
  ],
  "type": "string"
}
```

## PersonCorrectionAction


```json
{
  "description": "What the decision did",
  "enum": [
    "reassign",
    "new-person",
    "unassign",
    "remove",
    "merge",
    "box-move",
    "partner-merge"
  ],
  "type": "string"
}
```

## PersonCorrectionDto

Related models: [FaceEvidenceDto](models-11.md#faceevidencedto), [PersonCorrectionAction](models-19.md#personcorrectionaction), [PersonCorrectionPersonDto](models-19.md#personcorrectionpersondto).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/PersonCorrectionAction"
    },
    "createdAt": {
      "description": "When the decision was made",
      "format": "date-time",
      "type": "string"
    },
    "evidence": {
      "allOf": [
        {
          "$ref": "#/components/schemas/FaceEvidenceDto"
        }
      ],
      "description": "The photo and face, when it may still be shown",
      "nullable": true
    },
    "evidenceRevoked": {
      "description": "True when the decision was about a photo that can no longer be shown (trashed, Locked, hidden)",
      "type": "boolean"
    },
    "fromPerson": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PersonCorrectionPersonDto"
        }
      ],
      "description": "Who the face belonged to before",
      "nullable": true
    },
    "id": {
      "description": "Correction ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "toPerson": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PersonCorrectionPersonDto"
        }
      ],
      "description": "Who the face belongs to after",
      "nullable": true
    },
    "undoable": {
      "description": "Whether this kind of decision can be undone and has not been",
      "type": "boolean"
    },
    "undoneAt": {
      "description": "When the decision was undone",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "action",
    "createdAt",
    "evidence",
    "evidenceRevoked",
    "fromPerson",
    "id",
    "toPerson",
    "undoable",
    "undoneAt"
  ],
  "type": "object"
}
```

## PersonCorrectionPersonDto


```json
{
  "properties": {
    "exists": {
      "description": "Whether the person still exists",
      "type": "boolean"
    },
    "id": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "The current name, or the name at the time when the person no longer exists",
      "type": "string"
    }
  },
  "required": [
    "exists",
    "id",
    "name"
  ],
  "type": "object"
}
```

## PersonCorrectionsResponseDto

Related models: [PersonCorrectionDto](models-19.md#personcorrectiondto).

```json
{
  "properties": {
    "corrections": {
      "description": "Manual face decisions for this person, most recent first",
      "items": {
        "$ref": "#/components/schemas/PersonCorrectionDto"
      },
      "type": "array"
    },
    "hasNextPage": {
      "description": "Whether there are more pages",
      "type": "boolean"
    }
  },
  "required": [
    "corrections",
    "hasNextPage"
  ],
  "type": "object"
}
```

## PersonCreateDto


```json
{
  "properties": {
    "birthDate": {
      "description": "Person date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "color": {
      "description": "Person color (hex)",
      "nullable": true,
      "pattern": "^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Person visibility (hidden)",
      "type": "boolean"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    }
  },
  "type": "object"
}
```

## PersonMergeSuggestionDto

Related models: [FaceEvidenceDto](models-11.md#faceevidencedto), [PersonResponseDto](models-19.md#personresponsedto).

```json
{
  "properties": {
    "distance": {
      "description": "Face embedding distance between the two people (lower is more similar)",
      "format": "double",
      "minimum": 0,
      "type": "number"
    },
    "person": {
      "$ref": "#/components/schemas/PersonResponseDto",
      "description": "The person being reviewed"
    },
    "personEvidence": {
      "allOf": [
        {
          "$ref": "#/components/schemas/FaceEvidenceDto"
        }
      ],
      "description": "The reviewed person's reference face and its complete photo, or null when none may be shown",
      "nullable": true
    },
    "suggestion": {
      "$ref": "#/components/schemas/PersonResponseDto",
      "description": "The suggested match for that person"
    },
    "suggestionEvidence": {
      "allOf": [
        {
          "$ref": "#/components/schemas/FaceEvidenceDto"
        }
      ],
      "description": "The suggested person's reference face and its complete photo, or null when none may be shown",
      "nullable": true
    }
  },
  "required": [
    "distance",
    "person",
    "personEvidence",
    "suggestion",
    "suggestionEvidence"
  ],
  "type": "object"
}
```

## PersonMergeVerdict


```json
{
  "description": "\"same\": merge the two people now (the named one survives, or `personId` when both or neither are named); \"different\": never suggest this pair again; \"later\": skip it for 30 days; \"ignore\": stop suggesting `personId` with anyone",
  "enum": [
    "same",
    "different",
    "later",
    "ignore"
  ],
  "type": "string"
}
```

## PersonMergeVerdictCreateDto

Related models: [PersonMergeVerdict](models-19.md#personmergeverdict).

```json
{
  "properties": {
    "personId": {
      "description": "One person of the suggested pair (the reviewed person, for \"ignore\")",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "suggestionId": {
      "description": "The other person of the suggested pair",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "verdict": {
      "$ref": "#/components/schemas/PersonMergeVerdict"
    }
  },
  "required": [
    "personId",
    "suggestionId",
    "verdict"
  ],
  "type": "object"
}
```

## PersonMergeVerdictDeleteDto


```json
{
  "properties": {
    "personId": {
      "description": "One person of the suggested pair (the reviewed person, for \"ignore\")",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "suggestionId": {
      "description": "The other person of the suggested pair",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "personId",
    "suggestionId"
  ],
  "type": "object"
}
```

## PersonMergeVerdictResponseDto

Related models: [PersonMergeVerdict](models-19.md#personmergeverdict).

```json
{
  "properties": {
    "createdAt": {
      "description": "When the verdict was recorded",
      "format": "date-time",
      "type": "string"
    },
    "personId": {
      "description": "The person of the pair whose id sorts first; the ignored person for \"ignore\"; the surviving person for \"same\"",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "suggestionId": {
      "description": "The other person of the pair; the ignored person again for \"ignore\"; the merged person for \"same\"",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "verdict": {
      "$ref": "#/components/schemas/PersonMergeVerdict"
    }
  },
  "required": [
    "createdAt",
    "personId",
    "suggestionId",
    "verdict"
  ],
  "type": "object"
}
```

## PersonRecapDto


```json
{
  "properties": {
    "assetCount": {
      "description": "Number of their photos and videos that year",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "kind": {
      "description": "Discriminator for a person or pet recap",
      "enum": [
        "person_recap"
      ],
      "type": "string"
    },
    "name": {
      "description": "Their name when the memory was made",
      "type": "string"
    },
    "subject": {
      "description": "Whether the recap is about a person or a pet",
      "enum": [
        "person",
        "pet"
      ],
      "type": "string"
    },
    "subjectId": {
      "description": "The owner's person or pet",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "year": {
      "description": "Calendar year being recapped",
      "maximum": 9999,
      "minimum": 1000,
      "type": "integer"
    }
  },
  "required": [
    "assetCount",
    "kind",
    "name",
    "subject",
    "subjectId",
    "year"
  ],
  "type": "object"
}
```

## PersonResponseDto


```json
{
  "properties": {
    "birthDate": {
      "description": "Person date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "color": {
      "description": "Person color (hex)",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1.126.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "featuredAssetId": {
      "description": "The photo the person's featured face is in (FL-37). Returned only to the person's owner, by GET and PUT /people/:id; null when there is none, when it is another account's photo, or when it may not be shown (trashed, hidden, Locked, a removed or invisible face, or hidden as NSFW)",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        },
        {
          "version": "v3.2.1",
          "state": "Alpha"
        }
      ],
      "x-immich-state": "Alpha"
    },
    "id": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v1.126.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "isHidden": {
      "description": "Is hidden",
      "type": "boolean"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    },
    "thumbnailPath": {
      "description": "Thumbnail path",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "format": "date-time",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1.107.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    }
  },
  "required": [
    "birthDate",
    "id",
    "isHidden",
    "name",
    "thumbnailPath"
  ],
  "type": "object"
}
```

## PersonStatisticsResponseDto


```json
{
  "properties": {
    "assets": {
      "description": "Number of assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "photos": {
      "description": "Number of photos among the assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "videos": {
      "description": "Number of videos among the assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "assets",
    "photos",
    "videos"
  ],
  "type": "object"
}
```

## PersonUpdateDto


```json
{
  "properties": {
    "birthDate": {
      "description": "Person date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "color": {
      "description": "Person color (hex)",
      "nullable": true,
      "pattern": "^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$",
      "type": "string"
    },
    "featureFaceAssetId": {
      "description": "Asset ID used for feature face thumbnail",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Person visibility (hidden)",
      "type": "boolean"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    }
  },
  "type": "object"
}
```

## PetCandidateListResponseDto

Related models: [PetCandidateResponseDto](models-19.md#petcandidateresponsedto), [PetRecognitionStatusResponseDto](models-20.md#petrecognitionstatusresponsedto).

```json
{
  "properties": {
    "candidates": {
      "description": "Proposals awaiting review",
      "items": {
        "$ref": "#/components/schemas/PetCandidateResponseDto"
      },
      "type": "array"
    },
    "recognition": {
      "$ref": "#/components/schemas/PetRecognitionStatusResponseDto"
    },
    "recognitionAvailable": {
      "description": "Whether a pet recognition model is configured and available",
      "type": "boolean"
    },
    "recognitionUnavailableReason": {
      "description": "Why recognition is unavailable, for display; null when it is available",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "candidates",
    "recognition",
    "recognitionAvailable",
    "recognitionUnavailableReason"
  ],
  "type": "object"
}
```

## PetCandidateRejectDto


```json
{
  "properties": {
    "expectedChecksum": {
      "description": "Checksum of the original the decision was made on (base64); refused with 409 when it changed",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

## PetCandidateResponseDto


```json
{
  "properties": {
    "assetChecksum": {
      "description": "Checksum (base64) of the asset now; send it back as expectedChecksum",
      "type": "string"
    },
    "assetId": {
      "description": "Asset the proposal is about",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boundingBoxX1": {
      "description": "Region X1, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxX2": {
      "description": "Region X2, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY1": {
      "description": "Region Y1, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY2": {
      "description": "Region Y2, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "detectedSpecies": {
      "description": "The detector's species guess, which is never the pet's species",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Candidate ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "imageHeight": {
      "description": "Height of the image the region was found on",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Width of the image the region was found on",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "modelName": {
      "description": "Model that produced the detection",
      "type": "string"
    },
    "modelRevision": {
      "description": "Revision of the model that produced the detection",
      "type": "string"
    },
    "petId": {
      "description": "Proposed pet ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "score": {
      "description": "Model confidence, 0 to 1",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "assetChecksum",
    "assetId",
    "boundingBoxX1",
    "boundingBoxX2",
    "boundingBoxY1",
    "boundingBoxY2",
    "detectedSpecies",
    "id",
    "imageHeight",
    "imageWidth",
    "modelName",
    "modelRevision",
    "petId",
    "score"
  ],
  "type": "object"
}
```

## PetCandidateReviewDto


```json
{
  "properties": {
    "expectedChecksum": {
      "description": "Checksum of the original the decision was made on (base64); refused with 409 when it changed",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "petId": {
      "description": "Pet to assign instead of the proposed one",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## PetCreateDto

Related models: [PetSpecies](models-20.md#petspecies).

```json
{
  "properties": {
    "birthDate": {
      "description": "Pet date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "featuredAssetId": {
      "description": "Asset used as the pet thumbnail",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Pet visibility (hidden)",
      "type": "boolean"
    },
    "name": {
      "description": "Pet name",
      "maxLength": 100,
      "type": "string"
    },
    "species": {
      "$ref": "#/components/schemas/PetSpecies",
      "default": "other"
    }
  },
  "type": "object"
}
```

## PetMergeDto


```json
{
  "properties": {
    "ids": {
      "description": "Pet IDs to merge into this pet",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "ids"
  ],
  "type": "object"
}
```

## PetObservationCreateDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset the pet appears in",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boundingBoxX1": {
      "description": "Region X1, in source pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "boundingBoxX2": {
      "description": "Region X2, in source pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "boundingBoxY1": {
      "description": "Region Y1, in source pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "boundingBoxY2": {
      "description": "Region Y2, in source pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "expectedChecksum": {
      "description": "Checksum of the original the decision was made on (base64); refused with 409 when it changed",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "imageHeight": {
      "description": "Height of the image the region was drawn on",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Width of the image the region was drawn on",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "assetId"
  ],
  "type": "object"
}
```
