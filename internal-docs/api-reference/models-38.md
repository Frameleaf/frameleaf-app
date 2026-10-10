# Server API models 38

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## UserConfigMachineLearningDto

Related models: [UserConfigClipDto](models-37.md#userconfigclipdto), [UserConfigDuplicateDetectionDto](models-37.md#userconfigduplicatedetectiondto), [UserConfigFacialRecognitionDto](models-37.md#userconfigfacialrecognitiondto), [UserConfigImageDescriptionDto](models-37.md#userconfigimagedescriptiondto), [UserConfigNsfwDetectionDto](models-38.md#userconfignsfwdetectiondto), [UserConfigOcrDto](models-38.md#userconfigocrdto).

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

Related models: [ServerRole](models-31.md#serverrole), [UserAvatarColor](models-37.md#useravatarcolor), [UserLicense](models-38.md#userlicense), [UserStatus](models-38.md#userstatus).

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

Related models: [UserPreferenceHistoryChangeDto](models-38.md#userpreferencehistorychangedto).

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

Related models: [UserPreferenceHistoryEntryDto](models-38.md#userpreferencehistoryentrydto).

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

Related models: [AlbumsResponse](models-02.md#albumsresponse), [CastResponse](models-07.md#castresponse), [DownloadResponse](models-11.md#downloadresponse), [EmailNotificationsResponse](models-11.md#emailnotificationsresponse), [FoldersResponse](models-11.md#foldersresponse), [MemoriesResponse](models-16.md#memoriesresponse), [PeopleResponse](models-18.md#peopleresponse), [PrivacyResponse](models-27.md#privacyresponse), [PurchaseResponse](models-27.md#purchaseresponse), [RatingsResponse](models-28.md#ratingsresponse), [RecentlyAddedResponse](models-28.md#recentlyaddedresponse), [SavedSearch](models-29.md#savedsearch), [SharedLinksResponse](models-31.md#sharedlinksresponse), [TagsResponse](models-36.md#tagsresponse).

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

## UserPreferencesUpdateDto

Related models: [AlbumsUpdate](models-02.md#albumsupdate), [AvatarUpdate](models-06.md#avatarupdate), [CastUpdate](models-07.md#castupdate), [DownloadUpdate](models-11.md#downloadupdate), [EmailNotificationsUpdate](models-11.md#emailnotificationsupdate), [FoldersUpdate](models-11.md#foldersupdate), [MemoriesUpdate](models-16.md#memoriesupdate), [PeopleUpdate](models-18.md#peopleupdate), [PrivacyUpdate](models-27.md#privacyupdate), [PurchaseUpdate](models-27.md#purchaseupdate), [RatingsUpdate](models-28.md#ratingsupdate), [RecentlyAddedUpdate](models-28.md#recentlyaddedupdate), [SavedSearch](models-29.md#savedsearch), [SharedLinksUpdate](models-31.md#sharedlinksupdate), [TagsUpdate](models-36.md#tagsupdate).

```json
{
  "properties": {
    "albums": {
      "$ref": "#/components/schemas/AlbumsUpdate"
    },
    "avatar": {
      "$ref": "#/components/schemas/AvatarUpdate"
    },
    "cast": {
      "$ref": "#/components/schemas/CastUpdate"
    },
    "download": {
      "$ref": "#/components/schemas/DownloadUpdate"
    },
    "emailNotifications": {
      "$ref": "#/components/schemas/EmailNotificationsUpdate"
    },
    "expectedRevision": {
      "description": "The revision these changes were made against. When it no longer matches the stored preferences the update is rejected with 409 and nothing is changed",
      "type": "string"
    },
    "folders": {
      "$ref": "#/components/schemas/FoldersUpdate"
    },
    "memories": {
      "$ref": "#/components/schemas/MemoriesUpdate"
    },
    "notifications": {
      "description": "Origin-server system notification language: account locale and optional session-specific device overrides. Save devices as a whole list with expectedRevision.",
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
      "$ref": "#/components/schemas/PeopleUpdate"
    },
    "privacy": {
      "$ref": "#/components/schemas/PrivacyUpdate"
    },
    "purchase": {
      "$ref": "#/components/schemas/PurchaseUpdate"
    },
    "ratings": {
      "$ref": "#/components/schemas/RatingsUpdate"
    },
    "recentlyAdded": {
      "$ref": "#/components/schemas/RecentlyAddedUpdate"
    },
    "savedSearches": {
      "description": "Saved searches, replacing the whole list (at most 50). Only the account itself can change them",
      "items": {
        "$ref": "#/components/schemas/SavedSearch"
      },
      "maxItems": 50,
      "type": "array",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "sharedLinks": {
      "$ref": "#/components/schemas/SharedLinksUpdate"
    },
    "tags": {
      "$ref": "#/components/schemas/TagsUpdate"
    }
  },
  "type": "object"
}
```

## UserResponseDto

Related models: [UserAvatarColor](models-37.md#useravatarcolor).

```json
{
  "properties": {
    "avatarColor": {
      "$ref": "#/components/schemas/UserAvatarColor"
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

## UserStatus


```json
{
  "description": "User status",
  "enum": [
    "active",
    "removing",
    "deleted"
  ],
  "type": "string"
}
```

## UserUpdateMeDto

Related models: [UserAvatarColor](models-37.md#useravatarcolor).

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
    "name": {
      "description": "User name",
      "type": "string"
    },
    "password": {
      "deprecated": true,
      "description": "User password (deprecated, use change password endpoint)",
      "type": "string"
    }
  },
  "type": "object"
}
```

## UtilityActivityAction


```json
{
  "description": "A move to the trash, or its undo",
  "enum": [
    "trash",
    "restore"
  ],
  "type": "string"
}
```

## UtilityActivityEntryDto

Related models: [UtilityActivityAction](models-38.md#utilityactivityaction), [UtilityActivityItemDto](models-38.md#utilityactivityitemdto).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/UtilityActivityAction"
    },
    "bytes": {
      "description": "Combined size of the items listed below, in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "createdAt": {
      "description": "When the change was made",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Entry ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "itemCount": {
      "description": "Items listed below",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/UtilityActivityItemDto"
      },
      "type": "array"
    },
    "unavailableCount": {
      "description": "Items of this change no longer shown: permanently deleted, or not visible to this session",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "action",
    "bytes",
    "createdAt",
    "id",
    "itemCount",
    "items",
    "unavailableCount"
  ],
  "type": "object"
}
```

## UtilityActivityItemDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "bytes": {
      "description": "Size of the original when it was moved, in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "fileName": {
      "description": "Original file name",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "bytes",
    "fileName"
  ],
  "type": "object"
}
```

## UtilityActivityResponseDto

Related models: [UtilityActivityEntryDto](models-38.md#utilityactivityentrydto).

```json
{
  "properties": {
    "entries": {
      "description": "Newest first",
      "items": {
        "$ref": "#/components/schemas/UtilityActivityEntryDto"
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

## UtilityActivityTool


```json
{
  "description": "The utility whose activity history this is",
  "enum": [
    "large-files"
  ],
  "type": "string"
}
```

## ValidateAccessTokenResponseDto


```json
{
  "properties": {
    "authStatus": {
      "description": "Authentication status",
      "type": "boolean"
    }
  },
  "required": [
    "authStatus"
  ],
  "type": "object"
}
```

## ValidateLibraryDto


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
      "description": "Import paths to validate (max 128)",
      "items": {
        "maxLength": 1024,
        "type": "string"
      },
      "maxItems": 128,
      "type": "array"
    }
  },
  "type": "object"
}
```

## ValidateLibraryImportPathResponseDto

Related models: [LibraryImportPathReason](models-15.md#libraryimportpathreason).

```json
{
  "properties": {
    "importPath": {
      "description": "Import path",
      "type": "string"
    },
    "isValid": {
      "description": "Is valid",
      "type": "boolean"
    },
    "message": {
      "description": "Validation message",
      "type": "string"
    },
    "reason": {
      "$ref": "#/components/schemas/LibraryImportPathReason"
    }
  },
  "required": [
    "importPath",
    "isValid",
    "reason"
  ],
  "type": "object"
}
```

## ValidateLibraryResponseDto

Related models: [ValidateLibraryImportPathResponseDto](models-38.md#validatelibraryimportpathresponsedto).

```json
{
  "properties": {
    "importPaths": {
      "description": "Validation results for import paths",
      "items": {
        "$ref": "#/components/schemas/ValidateLibraryImportPathResponseDto"
      },
      "type": "array"
    }
  },
  "type": "object"
}
```

## VersionCheckFrequency


```json
{
  "description": "Check frequency",
  "enum": [
    "daily",
    "weekly"
  ],
  "type": "string"
}
```

## VersionCheckStateResponseDto


```json
{
  "properties": {
    "checkedAt": {
      "description": "Last check timestamp",
      "nullable": true,
      "type": "string"
    },
    "releaseVersion": {
      "description": "Release version",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "checkedAt",
    "releaseVersion"
  ],
  "type": "object"
}
```

## VideoAdjustModel


```json
{
  "description": "develop: the values follow the photo develop model (exposure, whites, blacks, temperature…), as the Frameleaf quick editor writes them. Absent: the earlier video adjustment model.",
  "enum": [
    "develop"
  ],
  "type": "string"
}
```

## VideoCodec


```json
{
  "description": "Target video codec",
  "enum": [
    "h264",
    "hevc",
    "vp9",
    "av1"
  ],
  "type": "string"
}
```

## VideoContainer


```json
{
  "description": "Accepted video containers",
  "enum": [
    "mov",
    "mp4",
    "ogg",
    "webm"
  ],
  "type": "string"
}
```

## VideoDevelopPreset


```json
{
  "enum": [
    "Original",
    "Vivid",
    "Natural",
    "Warm",
    "Cool",
    "Mono",
    "Silvertone",
    "Noir",
    "Fade",
    "B&W"
  ],
  "type": "string"
}
```

## VideoEditExportDto

Related models: [VideoEditExportProfile](models-38.md#videoeditexportprofile).

```json
{
  "properties": {
    "profile": {
      "$ref": "#/components/schemas/VideoEditExportProfile"
    }
  },
  "required": [
    "profile"
  ],
  "type": "object"
}
```

## VideoEditExportProfile


```json
{
  "description": "Export profile. Only the edited master is exported; the playback proxy is never offered for download.",
  "enum": [
    "master"
  ],
  "type": "string"
}
```

## VideoEditVersionPurpose


```json
{
  "description": "Why the version was created",
  "enum": [
    "save",
    "export",
    "revert"
  ],
  "type": "string"
}
```

## VideoEditVersionResponseDto

Related models: [AssetEditActionItemDto](models-05.md#asseteditactionitemdto), [VideoEditVersionPurpose](models-38.md#videoeditversionpurpose), [VideoEditVersionStatus](models-38.md#videoeditversionstatus).

```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "createdAt": {
      "description": "When the version was saved",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "edits": {
      "description": "The recipe rendered from the original",
      "items": {
        "$ref": "#/components/schemas/AssetEditActionItemDto"
      },
      "type": "array"
    },
    "id": {
      "description": "Video edit version ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "isCurrent": {
      "description": "Whether this version is the one currently published for playback",
      "type": "boolean"
    },
    "isRequested": {
      "description": "Whether this version is the latest requested save or revert",
      "type": "boolean"
    },
    "purpose": {
      "$ref": "#/components/schemas/VideoEditVersionPurpose"
    },
    "status": {
      "$ref": "#/components/schemas/VideoEditVersionStatus"
    }
  },
  "required": [
    "assetId",
    "createdAt",
    "edits",
    "id",
    "isCurrent",
    "isRequested",
    "purpose",
    "status"
  ],
  "type": "object"
}
```

## VideoEditVersionStatus


```json
{
  "description": "Render status of the version",
  "enum": [
    "pending",
    "ready",
    "failed"
  ],
  "type": "string"
}
```

## VideoMomentCoverDto


```json
{
  "properties": {
    "timestampMs": {
      "description": "Time of the chosen frame; null returns to the best frame",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "timestampMs"
  ],
  "type": "object"
}
```

## VideoMomentCreateDto


```json
{
  "properties": {
    "caption": {
      "maxLength": 500,
      "nullable": true,
      "type": "string"
    },
    "endMs": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "timestampMs": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "transcript": {
      "maxLength": 20000,
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "timestampMs"
  ],
  "type": "object"
}
```

## VideoMomentDto

Related models: [EnrichmentStaleReason](models-11.md#enrichmentstalereason), [VideoMomentSource](models-38.md#videomomentsource).

```json
{
  "properties": {
    "caption": {
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "endMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "frameId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "source": {
      "$ref": "#/components/schemas/VideoMomentSource"
    },
    "staleReason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/EnrichmentStaleReason"
        }
      ],
      "nullable": true
    },
    "timestampMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "transcript": {
      "description": "Typed by the owner; never generated",
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "caption",
    "createdAt",
    "endMs",
    "frameId",
    "id",
    "source",
    "staleReason",
    "timestampMs",
    "transcript",
    "updatedAt"
  ],
  "type": "object"
}
```

## VideoMomentFrameDto


```json
{
  "properties": {
    "frameIndex": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "height": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "indexed": {
      "description": "Has a search embedding from the saved search model",
      "type": "boolean"
    },
    "isCover": {
      "type": "boolean"
    },
    "rank": {
      "description": "1 is the best frame",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "score": {
      "format": "double",
      "type": "number"
    },
    "timestampMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "width": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "frameIndex",
    "height",
    "id",
    "indexed",
    "isCover",
    "rank",
    "score",
    "timestampMs",
    "width"
  ],
  "type": "object"
}
```

## VideoMomentIndexState


```json
{
  "description": "Whether the video has current reusable frames",
  "enum": [
    "none",
    "ready",
    "stale"
  ],
  "type": "string"
}
```

## VideoMomentMatch


```json
{
  "description": "What a moment search hit matched on",
  "enum": [
    "visual",
    "caption",
    "transcript"
  ],
  "type": "string"
}
```

## VideoMomentSearchDto


```json
{
  "properties": {
    "limit": {
      "default": 24,
      "maximum": 100,
      "minimum": 1,
      "type": "integer"
    },
    "query": {
      "maxLength": 500,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "query"
  ],
  "type": "object"
}
```

## VideoMomentSearchHitDto

Related models: [VideoMomentMatch](models-38.md#videomomentmatch).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "caption": {
      "nullable": true,
      "type": "string"
    },
    "frameId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "match": {
      "$ref": "#/components/schemas/VideoMomentMatch"
    },
    "momentId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "score": {
      "description": "Higher is closer",
      "format": "double",
      "type": "number"
    },
    "timestampMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "assetId",
    "caption",
    "frameId",
    "match",
    "momentId",
    "score",
    "timestampMs"
  ],
  "type": "object"
}
```

## VideoMomentSearchResponseDto

Related models: [VideoMomentSearchHitDto](models-38.md#videomomentsearchhitdto).

```json
{
  "properties": {
    "hits": {
      "items": {
        "$ref": "#/components/schemas/VideoMomentSearchHitDto"
      },
      "type": "array"
    }
  },
  "required": [
    "hits"
  ],
  "type": "object"
}
```

## VideoMomentSource


```json
{
  "description": "Video moment source",
  "enum": [
    "generated",
    "manual"
  ],
  "type": "string"
}
```

## VideoMomentUpdateDto


```json
{
  "properties": {
    "caption": {
      "maxLength": 500,
      "nullable": true,
      "type": "string"
    },
    "endMs": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "timestampMs": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "transcript": {
      "maxLength": 20000,
      "nullable": true,
      "type": "string"
    }
  },
  "type": "object"
}
```

## VideoMomentsResponseDto

Related models: [EnrichmentStaleReason](models-11.md#enrichmentstalereason), [VideoMomentDto](models-38.md#videomomentdto), [VideoMomentFrameDto](models-38.md#videomomentframedto), [VideoMomentIndexState](models-38.md#videomomentindexstate).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "captionModel": {
      "nullable": true,
      "type": "string"
    },
    "captionedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "coverFrameId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "coverTimestampMs": {
      "description": "The owner's chosen cover time; null means the best frame",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "embeddingModel": {
      "nullable": true,
      "type": "string"
    },
    "extractorVersion": {
      "nullable": true,
      "type": "string"
    },
    "frames": {
      "items": {
        "$ref": "#/components/schemas/VideoMomentFrameDto"
      },
      "type": "array"
    },
    "framesExtractedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "indexedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "moments": {
      "items": {
        "$ref": "#/components/schemas/VideoMomentDto"
      },
      "type": "array"
    },
    "staleReason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/EnrichmentStaleReason"
        }
      ],
      "nullable": true
    },
    "state": {
      "$ref": "#/components/schemas/VideoMomentIndexState"
    }
  },
  "required": [
    "assetId",
    "captionModel",
    "captionedAt",
    "coverFrameId",
    "coverTimestampMs",
    "embeddingModel",
    "extractorVersion",
    "frames",
    "framesExtractedAt",
    "indexedAt",
    "moments",
    "staleReason",
    "state"
  ],
  "type": "object"
}
```

## VideoTrimMode


```json
{
  "description": "Precise cuts are frame accurate and re-encode; fast cuts snap to keyframes and copy the streams when nothing else in the recipe needs a re-encode",
  "enum": [
    "precise",
    "fast"
  ],
  "type": "string"
}
```

## WarmLibrarySetupDto


```json
{
  "additionalProperties": false,
  "properties": {
    "reset": {
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## WorkerCredentialState


```json
{
  "description": "How a worker credential is held",
  "enum": [
    "none",
    "stored",
    "managed",
    "enrolled"
  ],
  "type": "string"
}
```

## WorkerGpuDto


```json
{
  "properties": {
    "memoryTotalBytes": {
      "format": "double",
      "type": "number"
    },
    "name": {
      "type": "string"
    }
  },
  "required": [
    "memoryTotalBytes",
    "name"
  ],
  "type": "object"
}
```

## WorkerInventoryEntryDto

Related models: [MediaOperationKind](models-16.md#mediaoperationkind), [MlWorkerAcceleration](models-18.md#mlworkeracceleration), [MlWorkerReadiness](models-18.md#mlworkerreadiness), [MlWorkerRole](models-18.md#mlworkerrole), [MlWorkload](models-18.md#mlworkload), [WorkerCredentialState](models-38.md#workercredentialstate), [WorkerGpuDto](models-38.md#workergpudto), [WorkerInventorySource](models-38.md#workerinventorysource), [WorkerWorkloadAdmissionDto](models-38.md#workerworkloadadmissiondto).

```json
{
  "properties": {
    "acceleration": {
      "$ref": "#/components/schemas/MlWorkerAcceleration"
    },
    "activeOperations": {
      "description": "Jobs running here now",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "admission": {
      "description": "Per allowed workload, from the last check",
      "items": {
        "$ref": "#/components/schemas/WorkerWorkloadAdmissionDto"
      },
      "type": "array"
    },
    "allowedWorkloads": {
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "type": "array"
    },
    "checkedAt": {
      "description": "Last check or check-in",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "configured": {
      "description": "For a local destination: its URL is still in the machine-learning URL list. Always true otherwise",
      "type": "boolean"
    },
    "consentGranted": {
      "description": "True when no consent is needed or it is recorded",
      "type": "boolean"
    },
    "credential": {
      "$ref": "#/components/schemas/WorkerCredentialState"
    },
    "enabled": {
      "type": "boolean"
    },
    "gpuMemoryBytes": {
      "description": "Largest GPU memory reported or qualified, or null when unknown",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "gpus": {
      "description": "GPUs the worker reported, with memory; empty when not reported",
      "items": {
        "$ref": "#/components/schemas/WorkerGpuDto"
      },
      "type": "array"
    },
    "id": {
      "description": "ML destination ID or render worker ID",
      "type": "string"
    },
    "kind": {
      "description": "ML destination kind, or the render worker destination",
      "type": "string"
    },
    "latencyMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "leavesNetwork": {
      "description": "Work sent here leaves the network",
      "type": "boolean"
    },
    "maxConcurrentOperations": {
      "description": "Render workers: the most they may hold at once",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "name": {
      "type": "string"
    },
    "queuedOperations": {
      "description": "Jobs waiting for this worker",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "readiness": {
      "$ref": "#/components/schemas/MlWorkerReadiness"
    },
    "renderKinds": {
      "description": "Operation kinds a render worker may claim",
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "type": "array"
    },
    "role": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MlWorkerRole"
        }
      ],
      "description": "What an ML destination is for; null for a render worker",
      "nullable": true
    },
    "routedWorkloads": {
      "description": "Workloads whose route names this destination",
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "type": "array"
    },
    "servedWorkloads": {
      "description": "Workloads the worker reported on its last check, or null when it never answered",
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "nullable": true,
      "type": "array"
    },
    "sharesLibraryHardware": {
      "type": "boolean"
    },
    "source": {
      "$ref": "#/components/schemas/WorkerInventorySource"
    },
    "summary": {
      "nullable": true,
      "type": "string"
    },
    "url": {
      "description": "Endpoint URL, or null when there is none to show",
      "nullable": true,
      "type": "string"
    },
    "waitingForLibraryAnalysis": {
      "description": "Full restorations bound here are waiting because library analysis has work",
      "type": "boolean"
    }
  },
  "required": [
    "acceleration",
    "activeOperations",
    "admission",
    "allowedWorkloads",
    "checkedAt",
    "configured",
    "consentGranted",
    "credential",
    "enabled",
    "gpuMemoryBytes",
    "gpus",
    "id",
    "kind",
    "latencyMs",
    "leavesNetwork",
    "maxConcurrentOperations",
    "name",
    "queuedOperations",
    "readiness",
    "renderKinds",
    "role",
    "routedWorkloads",
    "servedWorkloads",
    "sharesLibraryHardware",
    "source",
    "summary",
    "url",
    "waitingForLibraryAnalysis"
  ],
  "type": "object"
}
```

## WorkerInventoryResponseDto

Related models: [WorkerInventoryEntryDto](models-38.md#workerinventoryentrydto), [WorkerLibraryRouteDto](models-38.md#workerlibraryroutedto), [WorkerQueueBacklogDto](models-38.md#workerqueuebacklogdto), [WorkerRunnerDto](models-38.md#workerrunnerdto).

```json
{
  "properties": {
    "checkedAt": {
      "format": "date-time",
      "type": "string"
    },
    "configuredUrls": {
      "description": "The machine-learning URL list, in order",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "entries": {
      "items": {
        "$ref": "#/components/schemas/WorkerInventoryEntryDto"
      },
      "type": "array"
    },
    "libraryBacklog": {
      "description": "Library-analysis jobs active or waiting, not counting paused queues",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "libraryQueues": {
      "items": {
        "$ref": "#/components/schemas/WorkerQueueBacklogDto"
      },
      "type": "array"
    },
    "libraryRoutes": {
      "items": {
        "$ref": "#/components/schemas/WorkerLibraryRouteDto"
      },
      "type": "array"
    },
    "machineLearningEnabled": {
      "type": "boolean"
    },
    "runners": {
      "description": "Server processes running restorations now",
      "items": {
        "$ref": "#/components/schemas/WorkerRunnerDto"
      },
      "type": "array"
    }
  },
  "required": [
    "checkedAt",
    "configuredUrls",
    "entries",
    "libraryBacklog",
    "libraryQueues",
    "libraryRoutes",
    "machineLearningEnabled",
    "runners"
  ],
  "type": "object"
}
```

## WorkerInventorySource


```json
{
  "description": "Where an inventory entry comes from",
  "enum": [
    "ml-destination",
    "render-worker"
  ],
  "type": "string"
}
```

## WorkerLibraryRouteDto

Related models: [MlWorkload](models-18.md#mlworkload), [QueueName](models-27.md#queuename).

```json
{
  "properties": {
    "destinationId": {
      "nullable": true,
      "type": "string"
    },
    "queues": {
      "description": "Queues whose jobs run this workload",
      "items": {
        "$ref": "#/components/schemas/QueueName"
      },
      "type": "array"
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "destinationId",
    "queues",
    "workload"
  ],
  "type": "object"
}
```

## WorkerQueueBacklogDto

Related models: [QueueName](models-27.md#queuename).

```json
{
  "properties": {
    "active": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "paused": {
      "type": "boolean"
    },
    "queue": {
      "$ref": "#/components/schemas/QueueName"
    },
    "waiting": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "active",
    "paused",
    "queue",
    "waiting"
  ],
  "type": "object"
}
```

## WorkerRunnerDto

Related models: [MediaOperationKind](models-16.md#mediaoperationkind).

```json
{
  "properties": {
    "activeOperations": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "kinds": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "type": "array"
    },
    "lastHeartbeatAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "workerId": {
      "description": "The server process holding the claims",
      "type": "string"
    }
  },
  "required": [
    "activeOperations",
    "kinds",
    "lastHeartbeatAt",
    "workerId"
  ],
  "type": "object"
}
```

## WorkerWorkloadAdmissionDto

Related models: [MlAdmissionRefusal](models-17.md#mladmissionrefusal), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "admitted": {
      "description": "Whether the last check would admit this workload here",
      "type": "boolean"
    },
    "detail": {
      "description": "Why it would be refused, or null",
      "nullable": true,
      "type": "string"
    },
    "refusal": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MlAdmissionRefusal"
        }
      ],
      "nullable": true
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "admitted",
    "detail",
    "refusal",
    "workload"
  ],
  "type": "object"
}
```

## WorkflowCreateDto

Related models: [WorkflowStepDto](models-39.md#workflowstepdto).

```json
{
  "properties": {
    "description": {
      "description": "Workflow description",
      "maxLength": 2000,
      "nullable": true,
      "type": "string"
    },
    "enabled": {
      "description": "Workflow enabled",
      "type": "boolean"
    },
    "extra": {
      "additionalProperties": {},
      "description": "Additional fields of an imported definition, kept and exported unchanged",
      "type": "object"
    },
    "logging": {
      "description": "Workflow logs run results",
      "type": "boolean"
    },
    "name": {
      "description": "Workflow name",
      "maxLength": 300,
      "nullable": true,
      "type": "string"
    },
    "steps": {
      "items": {
        "$ref": "#/components/schemas/WorkflowStepDto"
      },
      "maxItems": 100,
      "type": "array"
    },
    "trigger": {
      "description": "Workflow trigger type. An unavailable trigger is kept, but the workflow cannot be enabled",
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "trigger"
  ],
  "type": "object"
}
```

## WorkflowIssueCode


```json
{
  "description": "Why a workflow definition cannot run",
  "enum": [
    "trigger_unavailable",
    "method_unavailable",
    "method_incompatible",
    "config_invalid"
  ],
  "type": "string"
}
```

## WorkflowIssueDto

Related models: [WorkflowIssueCode](models-38.md#workflowissuecode).

```json
{
  "properties": {
    "code": {
      "$ref": "#/components/schemas/WorkflowIssueCode"
    },
    "message": {
      "description": "What prevents the workflow from running",
      "type": "string"
    },
    "step": {
      "description": "Index of the step the issue belongs to",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "code",
    "message"
  ],
  "type": "object"
}
```
