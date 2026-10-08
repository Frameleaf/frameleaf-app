# Server API models 7

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

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

## CastResponse


```json
{
  "properties": {
    "adminDisabled": {
      "description": "Whether an administrator has turned casting off for this user",
      "type": "boolean"
    },
    "gCastEnabled": {
      "description": "Whether Google Cast is enabled (always false while an administrator has turned casting off)",
      "type": "boolean"
    }
  },
  "required": [
    "adminDisabled",
    "gCastEnabled"
  ],
  "type": "object"
}
```

## CastUpdate


```json
{
  "properties": {
    "adminDisabled": {
      "description": "Administrator only: turn casting off for this user. Accepted only by the admin user preferences endpoint; ignored when a user updates their own preferences",
      "type": "boolean"
    },
    "gCastEnabled": {
      "description": "Whether Google Cast is enabled",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## ChangePasswordDto


```json
{
  "properties": {
    "invalidateSessions": {
      "default": false,
      "description": "Invalidate all other sessions",
      "type": "boolean"
    },
    "newPassword": {
      "description": "New password (min 8 characters)",
      "example": "password",
      "minLength": 8,
      "type": "string"
    },
    "password": {
      "description": "Current password",
      "example": "password",
      "type": "string"
    }
  },
  "required": [
    "newPassword",
    "password"
  ],
  "type": "object"
}
```

## ClassificationApplyDto


```json
{
  "properties": {
    "assetIds": {
      "description": "Items from the plan; empty records the check when nothing changed",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 500,
      "type": "array"
    }
  },
  "required": [
    "assetIds"
  ],
  "type": "object"
}
```

## ClassificationApplyResponseDto


```json
{
  "properties": {
    "added": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "lastAppliedAt": {
      "format": "date-time",
      "type": "string"
    },
    "removed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "suggested": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "unchanged": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "added",
    "lastAppliedAt",
    "removed",
    "suggested",
    "unchanged"
  ],
  "type": "object"
}
```

## ClassificationContributionDto

Related models: [ClassificationMatchDecision](models-07.md#classificationmatchdecision), [ClassificationTagDto](models-08.md#classificationtagdto).

```json
{
  "properties": {
    "albumId": {
      "type": "string"
    },
    "albumName": {
      "type": "string"
    },
    "archived": {
      "description": "True when this rule archived the item",
      "type": "boolean"
    },
    "decision": {
      "$ref": "#/components/schemas/ClassificationMatchDecision"
    },
    "ruleId": {
      "type": "string"
    },
    "score": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "tag": {
      "allOf": [
        {
          "$ref": "#/components/schemas/ClassificationTagDto"
        }
      ],
      "description": "The tag this rule added, when it added one",
      "nullable": true
    }
  },
  "required": [
    "albumId",
    "albumName",
    "archived",
    "decision",
    "ruleId",
    "score",
    "tag"
  ],
  "type": "object"
}
```

## ClassificationDecisionDto

Related models: [ClassificationReviewDecision](models-07.md#classificationreviewdecision).

```json
{
  "properties": {
    "assetIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 500,
      "minItems": 1,
      "type": "array"
    },
    "decision": {
      "$ref": "#/components/schemas/ClassificationReviewDecision"
    }
  },
  "required": [
    "assetIds",
    "decision"
  ],
  "type": "object"
}
```

## ClassificationDecisionResponseDto


```json
{
  "properties": {
    "skipped": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "updated": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "skipped",
    "updated"
  ],
  "type": "object"
}
```

## ClassificationMatchDecision


```json
{
  "description": "What became of an asset a classification rule matched",
  "enum": [
    "matched",
    "suggested",
    "accepted",
    "rejected"
  ],
  "type": "string"
}
```

## ClassificationMatchDto

Related models: [ClassificationMatchDecision](models-07.md#classificationmatchdecision).

```json
{
  "properties": {
    "archiveContributed": {
      "type": "boolean"
    },
    "assetId": {
      "type": "string"
    },
    "decision": {
      "$ref": "#/components/schemas/ClassificationMatchDecision"
    },
    "score": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "tagContributed": {
      "type": "boolean"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "archiveContributed",
    "assetId",
    "decision",
    "score",
    "tagContributed",
    "updatedAt"
  ],
  "type": "object"
}
```

## ClassificationMatchPageDto

Related models: [ClassificationMatchDto](models-07.md#classificationmatchdto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/ClassificationMatchDto"
      },
      "type": "array"
    },
    "nextPage": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "total": {
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

## ClassificationMediaType


```json
{
  "description": "Which media a classification rule considers",
  "enum": [
    "any",
    "photo",
    "video"
  ],
  "type": "string"
}
```

## ClassificationPlanResponseDto

Related models: [ClassificationScoredAssetDto](models-08.md#classificationscoredassetdto).

```json
{
  "properties": {
    "added": {
      "description": "Items that would be added or suggested",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "assetIds": {
      "description": "Every item applying would change, for the apply call or a bulk job",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "durable": {
      "description": "True when applying must run as a durable bulk job",
      "type": "boolean"
    },
    "items": {
      "description": "The first items that would be added",
      "items": {
        "$ref": "#/components/schemas/ClassificationScoredAssetDto"
      },
      "type": "array"
    },
    "matched": {
      "description": "Items the rule matches now",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "removed": {
      "description": "Items the rule applied that no longer match",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "truncated": {
      "description": "True when there were more changes than one apply can carry",
      "type": "boolean"
    },
    "visualSearchAvailable": {
      "type": "boolean"
    }
  },
  "required": [
    "added",
    "assetIds",
    "durable",
    "items",
    "matched",
    "removed",
    "truncated",
    "visualSearchAvailable"
  ],
  "type": "object"
}
```

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
