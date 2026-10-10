# Server API models 12

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## FrameleafLinkResponseDto

Related models: [FrameleafLinkRoleChange](models-12.md#frameleaflinkrolechange), [UserAvatarColor](models-37.md#useravatarcolor), [UserLicense](models-38.md#userlicense), [UserStatus](models-38.md#userstatus).

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
    "confirmExpiresAt": {
      "description": "For a preview: when the confirm token expires",
      "nullable": true,
      "type": "string"
    },
    "confirmToken": {
      "description": "For a preview: confirms the link through link/confirm",
      "nullable": true,
      "type": "string"
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
    "linked": {
      "description": "Whether the Frameleaf account is now linked (false for a preview)",
      "type": "boolean"
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
    "roleChange": {
      "$ref": "#/components/schemas/FrameleafLinkRoleChange"
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
    "confirmExpiresAt",
    "confirmToken",
    "createdAt",
    "deletedAt",
    "email",
    "id",
    "isAdmin",
    "license",
    "linked",
    "name",
    "oauthId",
    "profileChangedAt",
    "profileImagePath",
    "quotaSizeInBytes",
    "quotaUsageInBytes",
    "roleChange",
    "shouldChangePassword",
    "status",
    "storageLabel",
    "updatedAt"
  ],
  "type": "object"
}
```

## FrameleafLinkRoleChange


```json
{
  "description": "granted-admin: the Frameleaf account holds an admin share of this server on Frameleaf Cloud, so linking makes (or made) you an administrator here",
  "enum": [
    "none",
    "granted-admin"
  ],
  "type": "string"
}
```

## FrameleafPublicConfigDto

Related models: [FrameleafVia](models-12.md#frameleafvia).

```json
{
  "properties": {
    "localUrl": {
      "description": "This server on the home network; given only to a remote-access visitor who is on it",
      "nullable": true,
      "type": "string"
    },
    "relayHost": {
      "description": "The remote-access host shown on the login page, when known",
      "nullable": true,
      "type": "string"
    },
    "sameNetwork": {
      "description": "Whether a remote-access visitor is on the same network as this server",
      "type": "boolean"
    },
    "signInAvailable": {
      "description": "Whether Sign in with Frameleaf is available (the server is linked)",
      "type": "boolean"
    },
    "signInOrigin": {
      "description": "Where a visitor on a home address signs in with Frameleaf before returning (the relay address or the verified custom domain)",
      "nullable": true,
      "type": "string"
    },
    "signInRequired": {
      "description": "Whether this visitor arrived through remote access, where only Sign in with Frameleaf is offered",
      "type": "boolean"
    },
    "via": {
      "allOf": [
        {
          "$ref": "#/components/schemas/FrameleafVia"
        }
      ],
      "description": "How the request arrived; null when the edge worker did not vouch for it",
      "nullable": true
    }
  },
  "required": [
    "localUrl",
    "relayHost",
    "sameNetwork",
    "signInAvailable",
    "signInOrigin",
    "signInRequired",
    "via"
  ],
  "type": "object"
}
```

## FrameleafSetupAdminDto


```json
{
  "properties": {
    "email": {
      "description": "The administrator’s email",
      "format": "email",
      "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
      "type": "string"
    },
    "name": {
      "description": "The administrator’s name",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "password": {
      "description": "The administrator’s password (min 8 characters)",
      "minLength": 8,
      "type": "string"
    },
    "ticket": {
      "description": "The setup ticket POST server/setup/code returned, used once, from the same device",
      "maxLength": 256,
      "type": "string"
    }
  },
  "required": [
    "email",
    "name",
    "password",
    "ticket"
  ],
  "type": "object"
}
```

## FrameleafSetupChoicesDto

Related models: [FrameleafSetupModelTier](models-12.md#frameleafsetupmodeltier), [FrameleafSetupProcessing](models-12.md#frameleafsetupprocessing), [FrameleafSetupRestore](models-12.md#frameleafsetuprestore), [FrameleafSetupSignIn](models-12.md#frameleafsetupsignin), [FrameleafSetupTheme](models-12.md#frameleafsetuptheme).

```json
{
  "additionalProperties": false,
  "properties": {
    "accountCreated": {
      "description": "Whether the local administrator exists",
      "type": "boolean"
    },
    "adminEmail": {
      "description": "Administrator email",
      "maxLength": 120,
      "type": "string"
    },
    "adminName": {
      "description": "Administrator name",
      "maxLength": 120,
      "type": "string"
    },
    "language": {
      "description": "Language chosen on the welcome step",
      "maxLength": 12,
      "type": "string"
    },
    "layout": {
      "description": "Folder layout preset, or \"keep\"",
      "maxLength": 40,
      "type": "string"
    },
    "linked": {
      "description": "Whether the server is linked to a Frameleaf account",
      "type": "boolean"
    },
    "map": {
      "description": "Map tiles",
      "type": "boolean"
    },
    "model": {
      "$ref": "#/components/schemas/FrameleafSetupModelTier",
      "description": "Model tier"
    },
    "nightlyBackup": {
      "description": "Nightly database backups",
      "type": "boolean"
    },
    "processing": {
      "$ref": "#/components/schemas/FrameleafSetupProcessing",
      "description": "Where processing runs"
    },
    "restore": {
      "$ref": "#/components/schemas/FrameleafSetupRestore",
      "description": "Choice for a found cloud backup"
    },
    "signIn": {
      "$ref": "#/components/schemas/FrameleafSetupSignIn",
      "description": "How the administrator signs in"
    },
    "signedIn": {
      "description": "Whether the administrator signed in (existing library)",
      "type": "boolean"
    },
    "theme": {
      "$ref": "#/components/schemas/FrameleafSetupTheme",
      "description": "Theme after setup"
    },
    "updates": {
      "description": "Check for Frameleaf updates",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## FrameleafSetupCodeDto


```json
{
  "properties": {
    "code": {
      "description": "The setup code shown on the server's console and in its log (XXXX-XXXX, the dash optional)",
      "maxLength": 32,
      "type": "string"
    }
  },
  "required": [
    "code"
  ],
  "type": "object"
}
```

## FrameleafSetupErrorCode


```json
{
  "description": "Why setting up this server was refused",
  "enum": [
    "setup_lan_only",
    "setup_complete",
    "setup_code_required",
    "setup_code_invalid",
    "setup_code_replaced",
    "setup_code_locked",
    "setup_ticket_invalid",
    "setup_cloud_unavailable",
    "setup_already_linked",
    "setup_link_token_invalid",
    "setup_link_token_used",
    "setup_link_failed"
  ],
  "type": "string"
}
```

## FrameleafSetupErrorDto

Related models: [FrameleafSetupErrorCode](models-12.md#frameleafsetuperrorcode).

```json
{
  "properties": {
    "attemptsLeft": {
      "description": "For setup_code_invalid: wrong tries left before the code is replaced",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "code": {
      "$ref": "#/components/schemas/FrameleafSetupErrorCode"
    },
    "error": {
      "type": "string"
    },
    "message": {
      "description": "What went wrong, in words a person can act on",
      "type": "string"
    },
    "statusCode": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "code",
    "error",
    "message",
    "statusCode"
  ],
  "type": "object"
}
```

## FrameleafSetupFlow


```json
{
  "description": "Setup flow",
  "enum": [
    "new",
    "existing"
  ],
  "type": "string"
}
```

## FrameleafSetupLibraryResponseDto


```json
{
  "properties": {
    "albums": {
      "description": "Albums",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "bytes": {
      "description": "Size of the originals in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "items": {
      "description": "Photos and videos on the server",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "people": {
      "description": "Named and unnamed people",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "users": {
      "description": "Accounts on the server",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "albums",
    "bytes",
    "items",
    "people",
    "users"
  ],
  "type": "object"
}
```

## FrameleafSetupLinkDto


```json
{
  "properties": {
    "linkToken": {
      "description": "A single-use Frameleaf link token (fll_…) the app got from Frameleaf Cloud for this server",
      "maxLength": 520,
      "type": "string"
    },
    "serverName": {
      "description": "The name the person chose for this server; it is linked under this name",
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    },
    "ticket": {
      "description": "The setup ticket POST server/setup/code returned, used once, from the same device",
      "maxLength": 256,
      "type": "string"
    }
  },
  "required": [
    "linkToken",
    "ticket"
  ],
  "type": "object"
}
```

## FrameleafSetupLinkResponseDto


```json
{
  "properties": {
    "account": {
      "description": "The Frameleaf account that now owns this server; its first Sign in with Frameleaf creates the administrator",
      "nullable": true,
      "type": "string"
    },
    "instanceId": {
      "description": "This server's Frameleaf Cloud instance id",
      "type": "string"
    }
  },
  "required": [
    "account",
    "instanceId"
  ],
  "type": "object"
}
```

## FrameleafSetupModelTier


```json
{
  "enum": [
    "light",
    "balanced",
    "best"
  ],
  "type": "string"
}
```

## FrameleafSetupProcessing


```json
{
  "enum": [
    "local",
    "cloud",
    "later"
  ],
  "type": "string"
}
```

## FrameleafSetupProgressDto

Related models: [FrameleafSetupChoicesDto](models-12.md#frameleafsetupchoicesdto).

```json
{
  "additionalProperties": false,
  "properties": {
    "choices": {
      "$ref": "#/components/schemas/FrameleafSetupChoicesDto"
    },
    "reached": {
      "description": "Furthest step index reached",
      "maximum": 40,
      "minimum": 0,
      "type": "integer"
    },
    "step": {
      "description": "Current step id",
      "maxLength": 40,
      "minLength": 1,
      "type": "string"
    },
    "version": {
      "description": "Payload version (1)",
      "maximum": 1,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "choices",
    "reached",
    "step",
    "version"
  ],
  "type": "object"
}
```

## FrameleafSetupResponseDto

Related models: [FrameleafSetupFlow](models-12.md#frameleafsetupflow), [FrameleafSetupProgressDto](models-12.md#frameleafsetupprogressdto).

```json
{
  "properties": {
    "completed": {
      "description": "Whether Frameleaf setup is complete",
      "type": "boolean"
    },
    "completedAt": {
      "description": "When setup was completed",
      "nullable": true,
      "type": "string"
    },
    "flow": {
      "$ref": "#/components/schemas/FrameleafSetupFlow"
    },
    "progress": {
      "allOf": [
        {
          "$ref": "#/components/schemas/FrameleafSetupProgressDto"
        }
      ],
      "nullable": true
    }
  },
  "required": [
    "completed",
    "completedAt",
    "flow",
    "progress"
  ],
  "type": "object"
}
```

## FrameleafSetupRestore


```json
{
  "enum": [
    "restore",
    "fresh"
  ],
  "type": "string"
}
```

## FrameleafSetupSignIn


```json
{
  "enum": [
    "frameleaf",
    "local"
  ],
  "type": "string"
}
```

## FrameleafSetupStorageResponseDto


```json
{
  "properties": {
    "freeBytes": {
      "description": "Free space in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "path": {
      "description": "Where the library is stored",
      "type": "string"
    },
    "totalBytes": {
      "description": "Total space in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "writable": {
      "description": "Whether Frameleaf can write there",
      "type": "boolean"
    }
  },
  "required": [
    "freeBytes",
    "path",
    "totalBytes",
    "writable"
  ],
  "type": "object"
}
```

## FrameleafSetupTheme


```json
{
  "enum": [
    "dark",
    "light"
  ],
  "type": "string"
}
```

## FrameleafSetupTicketResponseDto


```json
{
  "properties": {
    "expiresAt": {
      "description": "When the ticket stops working",
      "format": "date-time",
      "type": "string"
    },
    "ticket": {
      "description": "Proof the setup code was entered: use it once, from this device, before it expires",
      "type": "string"
    }
  },
  "required": [
    "expiresAt",
    "ticket"
  ],
  "type": "object"
}
```

## FrameleafSetupUpdateDto

Related models: [FrameleafSetupFlow](models-12.md#frameleafsetupflow), [FrameleafSetupProgressDto](models-12.md#frameleafsetupprogressdto).

```json
{
  "additionalProperties": false,
  "properties": {
    "flow": {
      "$ref": "#/components/schemas/FrameleafSetupFlow"
    },
    "progress": {
      "$ref": "#/components/schemas/FrameleafSetupProgressDto"
    }
  },
  "required": [
    "progress"
  ],
  "type": "object"
}
```

## FrameleafTokenExchangeDto


```json
{
  "properties": {
    "rememberMe": {
      "type": "boolean"
    },
    "token": {
      "description": "A server-audience token from the Frameleaf identity provider (OAuth token exchange), signed by the issuer this server is linked to, with header typ \"frameleaf-exchange+jwt\", aud this server's client id, iat, exp, a single-use jti and the Sign in with Frameleaf claims",
      "maxLength": 16384,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "token"
  ],
  "type": "object"
}
```

## FrameleafTokenExchangeErrorCode


```json
{
  "description": "Why the token was refused",
  "enum": [
    "frameleaf_exchange_not_linked",
    "frameleaf_exchange_sign_in_off",
    "frameleaf_exchange_no_access",
    "frameleaf_exchange_wrong_audience",
    "frameleaf_exchange_expired",
    "frameleaf_exchange_replayed",
    "frameleaf_exchange_invalid",
    "frameleaf_exchange_email_unverified",
    "frameleaf_exchange_account_removed",
    "frameleaf_exchange_account_conflict"
  ],
  "type": "string"
}
```

## FrameleafTokenExchangeErrorDto

Related models: [FrameleafTokenExchangeErrorCode](models-12.md#frameleaftokenexchangeerrorcode).

```json
{
  "properties": {
    "code": {
      "$ref": "#/components/schemas/FrameleafTokenExchangeErrorCode"
    },
    "error": {
      "type": "string"
    },
    "message": {
      "type": "string"
    },
    "statusCode": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "code",
    "error",
    "message",
    "statusCode"
  ],
  "type": "object"
}
```

## FrameleafVia


```json
{
  "description": "How the request arrived, as vouched for by the edge worker",
  "enum": [
    "lan",
    "wan",
    "relay"
  ],
  "type": "string"
}
```

## HardwareBackend


```json
{
  "enum": [
    "CUDA",
    "ROCm",
    "OpenVINO",
    "NVENC",
    "VA-API",
    "QSV",
    "CPU"
  ],
  "type": "string"
}
```

## HardwareBenchmarkDto

Related models: [HardwareWorkloadBenchmarkDto](models-12.md#hardwareworkloadbenchmarkdto).

```json
{
  "properties": {
    "embeddingMs": {
      "description": "Median time of a search embedding",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "mlFactor": {
      "description": "Measured ÷ estimated time for AI work here (applied to the local estimates)",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "ranAt": {
      "type": "string"
    },
    "serverFactor": {
      "description": "Measured ÷ estimated time for video encoding here",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "transcodeSpeed": {
      "description": "1080p test transcode, × real time",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "workloads": {
      "description": "Throughput per kind of work, or why there is none",
      "items": {
        "$ref": "#/components/schemas/HardwareWorkloadBenchmarkDto"
      },
      "type": "array"
    }
  },
  "required": [
    "embeddingMs",
    "mlFactor",
    "ranAt",
    "serverFactor",
    "transcodeSpeed",
    "workloads"
  ],
  "type": "object"
}
```

## HardwareBenchmarkSource


```json
{
  "enum": [
    "benchmark",
    "qualification"
  ],
  "type": "string"
}
```

## HardwareBenchmarkUnit


```json
{
  "enum": [
    "photo",
    "frame"
  ],
  "type": "string"
}
```

## HardwareBenchmarkWorkload


```json
{
  "enum": [
    "descriptions",
    "upscale",
    "restoration",
    "studio",
    "interpolation"
  ],
  "type": "string"
}
```

## HardwareCheckResponseDto

Related models: [HardwareBenchmarkDto](models-12.md#hardwarebenchmarkdto), [HardwareContainerCheckDto](models-12.md#hardwarecontainercheckdto), [HardwareFindingDto](models-12.md#hardwarefindingdto), [HardwareWorkerCheckDto](models-12.md#hardwareworkercheckdto).

```json
{
  "properties": {
    "benchmark": {
      "allOf": [
        {
          "$ref": "#/components/schemas/HardwareBenchmarkDto"
        }
      ],
      "description": "The last benchmark on this hardware, if any",
      "nullable": true
    },
    "checkedAt": {
      "type": "string"
    },
    "findings": {
      "description": "The same problems per container, with what their fix names",
      "items": {
        "$ref": "#/components/schemas/HardwareFindingDto"
      },
      "type": "array"
    },
    "issues": {
      "description": "Set-up problems the check found, by problem id",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "ml": {
      "$ref": "#/components/schemas/HardwareContainerCheckDto",
      "description": "The ML container: search, faces, descriptions and restoration"
    },
    "mlImage": {
      "description": "The ML image flavour (cpu, cuda, rocm, openvino), when reported",
      "nullable": true,
      "type": "string"
    },
    "server": {
      "$ref": "#/components/schemas/HardwareContainerCheckDto",
      "description": "The server container: video playback and Studio export"
    },
    "workers": {
      "description": "Render and restoration workers, from their reported evidence",
      "items": {
        "$ref": "#/components/schemas/HardwareWorkerCheckDto"
      },
      "type": "array"
    }
  },
  "required": [
    "benchmark",
    "checkedAt",
    "findings",
    "issues",
    "ml",
    "mlImage",
    "server",
    "workers"
  ],
  "type": "object"
}
```

## HardwareContainerCheckDto

Related models: [HardwareBackend](models-12.md#hardwarebackend), [HardwareContainerTestDto](models-12.md#hardwarecontainertestdto), [HardwareGpuFactsDto](models-12.md#hardwaregpufactsdto).

```json
{
  "properties": {
    "backend": {
      "$ref": "#/components/schemas/HardwareBackend"
    },
    "driver": {
      "description": "Driver and runtime, or what the driver reported instead",
      "nullable": true,
      "type": "string"
    },
    "gpu": {
      "$ref": "#/components/schemas/HardwareGpuFactsDto"
    },
    "model": {
      "nullable": true,
      "type": "string"
    },
    "reachable": {
      "description": "The container answered the check",
      "type": "boolean"
    },
    "test": {
      "allOf": [
        {
          "$ref": "#/components/schemas/HardwareContainerTestDto"
        }
      ],
      "nullable": true
    },
    "vendor": {
      "nullable": true,
      "type": "string"
    },
    "vramGb": {
      "format": "double",
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "backend",
    "driver",
    "gpu",
    "model",
    "reachable",
    "test",
    "vendor",
    "vramGb"
  ],
  "type": "object"
}
```

## HardwareContainerTestDto


```json
{
  "properties": {
    "error": {
      "description": "What failed, as the container reported it",
      "nullable": true,
      "type": "string"
    },
    "gpu": {
      "description": "The test ran on the GPU",
      "type": "boolean"
    },
    "kind": {
      "description": "transcode: the server container; embedding: the ML container",
      "enum": [
        "transcode",
        "embedding"
      ],
      "type": "string"
    },
    "ok": {
      "description": "The test finished without falling back",
      "type": "boolean"
    },
    "value": {
      "description": "transcode: 1080p real-time multiple; embedding: milliseconds; null when it did not run",
      "format": "double",
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "error",
    "gpu",
    "kind",
    "ok",
    "value"
  ],
  "type": "object"
}
```

## HardwareFindingContainer


```json
{
  "enum": [
    "server",
    "ml"
  ],
  "type": "string"
}
```

## HardwareFindingDto

Related models: [HardwareFindingContainer](models-12.md#hardwarefindingcontainer).

```json
{
  "properties": {
    "computeCapability": {
      "description": "nvidia-bf16: the card's CUDA compute capability",
      "nullable": true,
      "type": "string"
    },
    "container": {
      "$ref": "#/components/schemas/HardwareFindingContainer",
      "description": "The container the problem was found in"
    },
    "gfxVersion": {
      "description": "rocm-gfx: the HSA_OVERRIDE_GFX_VERSION the card needs",
      "nullable": true,
      "type": "string"
    },
    "gid": {
      "description": "render-group: the group number that owns the render node",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "id": {
      "description": "Problem id (web catalogue `gpuProblems`)",
      "type": "string"
    },
    "pciAddress": {
      "description": "wrong-gpu: the PCI address of the graphics card to pass in",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "computeCapability",
    "container",
    "gfxVersion",
    "gid",
    "id",
    "pciAddress"
  ],
  "type": "object"
}
```

## HardwareGpuFactsDto


```json
{
  "properties": {
    "present": {
      "description": "A GPU is on the host; null when the container cannot tell",
      "nullable": true,
      "type": "boolean"
    },
    "usable": {
      "description": "The runtime actually used the GPU; null when not reported",
      "nullable": true,
      "type": "boolean"
    },
    "visible": {
      "description": "The container can see the GPU; null when not reported",
      "nullable": true,
      "type": "boolean"
    }
  },
  "required": [
    "present",
    "usable",
    "visible"
  ],
  "type": "object"
}
```

## HardwareRunsOn


```json
{
  "enum": [
    "gpu",
    "cpu"
  ],
  "type": "string"
}
```

## HardwareWorkerCheckDto

Related models: [HardwareGpuFactsDto](models-12.md#hardwaregpufactsdto), [HardwareWorkerKind](models-12.md#hardwareworkerkind).

```json
{
  "properties": {
    "gpu": {
      "$ref": "#/components/schemas/HardwareGpuFactsDto"
    },
    "id": {
      "description": "Render worker ID or ML destination ID",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/HardwareWorkerKind",
      "description": "An enrolled Studio render worker or a restoration worker"
    },
    "model": {
      "nullable": true,
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "reachable": {
      "description": "It has a live session (render) or answered its report (restoration)",
      "type": "boolean"
    },
    "vramGb": {
      "format": "double",
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "gpu",
    "id",
    "kind",
    "model",
    "name",
    "reachable",
    "vramGb"
  ],
  "type": "object"
}
```

## HardwareWorkerKind


```json
{
  "enum": [
    "render",
    "restoration"
  ],
  "type": "string"
}
```

## HardwareWorkloadBenchmarkDto

Related models: [HardwareBenchmarkSource](models-12.md#hardwarebenchmarksource), [HardwareBenchmarkUnit](models-12.md#hardwarebenchmarkunit), [HardwareBenchmarkWorkload](models-12.md#hardwarebenchmarkworkload), [HardwareRunsOn](models-12.md#hardwarerunson), [HardwareWorkloadUnavailable](models-12.md#hardwareworkloadunavailable).

```json
{
  "properties": {
    "error": {
      "nullable": true,
      "type": "string"
    },
    "perHour": {
      "description": "Units per hour",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "runsOn": {
      "allOf": [
        {
          "$ref": "#/components/schemas/HardwareRunsOn"
        }
      ],
      "nullable": true
    },
    "secondsPerUnit": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "source": {
      "allOf": [
        {
          "$ref": "#/components/schemas/HardwareBenchmarkSource"
        }
      ],
      "description": "benchmark: timed now; qualification: measured on this GPU when the worker was qualified",
      "nullable": true
    },
    "unavailable": {
      "allOf": [
        {
          "$ref": "#/components/schemas/HardwareWorkloadUnavailable"
        }
      ],
      "description": "Why there is no throughput, or null",
      "nullable": true
    },
    "unit": {
      "allOf": [
        {
          "$ref": "#/components/schemas/HardwareBenchmarkUnit"
        }
      ],
      "nullable": true
    },
    "worker": {
      "description": "The worker that ran it",
      "nullable": true,
      "type": "string"
    },
    "workload": {
      "$ref": "#/components/schemas/HardwareBenchmarkWorkload",
      "description": "The kind of work (routing key; studio is transcription)"
    }
  },
  "required": [
    "error",
    "perHour",
    "runsOn",
    "secondsPerUnit",
    "source",
    "unavailable",
    "unit",
    "worker",
    "workload"
  ],
  "type": "object"
}
```

## HardwareWorkloadUnavailable


```json
{
  "enum": [
    "no-local-runner",
    "no-local-worker",
    "machine-learning-off",
    "not-measured",
    "failed"
  ],
  "type": "string"
}
```

## HdrAssetDevelopRecipe

Related models: [AssetDevelopCleanup](models-04.md#assetdevelopcleanup), [AssetDevelopMask](models-04.md#assetdevelopmask), [AssetDevelopPerspective](models-04.md#assetdevelopperspective), [AssetDevelopPreset](models-04.md#assetdeveloppreset), [KnownAssetDevelopCrop](models-14.md#knownassetdevelopcrop).

```json
{
  "additionalProperties": false,
  "properties": {
    "blacks": {
      "default": 0,
      "description": "Black point",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "brilliance": {
      "default": 0,
      "description": "FL-233: opens the shadows and holds back the highlights (positive), or the reverse (negative), with a slight colour lift; see the develop recipe protocol",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "clarity": {
      "default": 0,
      "description": "Local contrast in the midtones",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "cleanup": {
      "default": [],
      "description": "FL-233: Clean Up operations, applied in order to the original before every other step",
      "items": {
        "$ref": "#/components/schemas/AssetDevelopCleanup"
      },
      "maxItems": 32,
      "type": "array"
    },
    "contrast": {
      "default": 0,
      "description": "Contrast around middle grey",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "crop": {
      "$ref": "#/components/schemas/KnownAssetDevelopCrop",
      "default": {
        "h": 1,
        "w": 1,
        "x": 0,
        "y": 0
      }
    },
    "dehaze": {
      "default": 0,
      "description": "Haze removal (positive) or addition (negative)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "exposure": {
      "default": 0,
      "description": "Exposure in EV; each whole stop doubles the light",
      "format": "double",
      "maximum": 2,
      "minimum": -2,
      "type": "number"
    },
    "flipHorizontal": {
      "default": false,
      "description": "Mirror left to right",
      "type": "boolean"
    },
    "flipVertical": {
      "default": false,
      "description": "Mirror top to bottom",
      "type": "boolean"
    },
    "grain": {
      "default": 0,
      "description": "Film grain amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "hdr": {
      "additionalProperties": false,
      "default": {},
      "properties": {
        "intent": {
          "default": "preserve",
          "enum": [
            "preserve"
          ],
          "type": "string"
        },
        "referenceWhite": {
          "default": 203,
          "enum": [
            203
          ],
          "format": "int32",
          "type": "integer"
        },
        "sdrToneMapper": {
          "default": "libultrahdr/2.0.2",
          "enum": [
            "libultrahdr/2.0.2"
          ],
          "type": "string"
        },
        "version": {
          "default": 1,
          "enum": [
            1
          ],
          "format": "int32",
          "type": "integer"
        }
      },
      "type": "object"
    },
    "highlights": {
      "default": 0,
      "description": "Highlight recovery (negative) or lift (positive)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "masks": {
      "default": [],
      "description": "Selective adjustments, applied in order after the global develop",
      "items": {
        "$ref": "#/components/schemas/AssetDevelopMask"
      },
      "maxItems": 8,
      "type": "array"
    },
    "noiseReduction": {
      "default": 0,
      "description": "Luminance noise reduction amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "perspective": {
      "$ref": "#/components/schemas/AssetDevelopPerspective",
      "description": "Keystone correction, applied after the quarter turns and flips and before straightening"
    },
    "preset": {
      "$ref": "#/components/schemas/AssetDevelopPreset",
      "default": "Original"
    },
    "presetStrength": {
      "default": 100,
      "description": "How much of the preset is applied, as a percentage",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "renderer": {
      "default": "frameleaf-develop-hdr/1",
      "enum": [
        "frameleaf-develop-hdr/1"
      ],
      "type": "string"
    },
    "rotation": {
      "default": 0,
      "description": "Quarter-turn rotation in degrees, clockwise",
      "maximum": 270,
      "minimum": 0,
      "type": "integer"
    },
    "saturation": {
      "default": 0,
      "description": "Global saturation",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "shadows": {
      "default": 0,
      "description": "Shadow lift (positive) or deepening (negative)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "sharpen": {
      "default": 0,
      "description": "Detail sharpening amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "straighten": {
      "default": 0,
      "description": "Straighten angle in degrees, applied before the crop",
      "format": "double",
      "maximum": 45,
      "minimum": -45,
      "type": "number"
    },
    "temperature": {
      "default": 0,
      "description": "Warm (positive) or cool (negative) white balance shift",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "tint": {
      "default": 0,
      "description": "Magenta (positive) or green (negative) tint",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "version": {
      "enum": [
        3
      ],
      "format": "int32",
      "type": "integer"
    },
    "vibrance": {
      "default": 0,
      "description": "Saturation weighted towards muted colours",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "vignette": {
      "default": 0,
      "description": "Darkened (positive) or lightened (negative) edges",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "whites": {
      "default": 0,
      "description": "White point",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    }
  },
  "required": [
    "version"
  ],
  "type": "object"
}
```

## HdrAssetDevelopRecipeV4

Related models: [AssetDevelopCleanup](models-04.md#assetdevelopcleanup), [AssetDevelopMask](models-04.md#assetdevelopmask), [AssetDevelopPerspective](models-04.md#assetdevelopperspective), [AssetDevelopPreset](models-04.md#assetdeveloppreset), [KnownAssetDevelopCrop](models-14.md#knownassetdevelopcrop).

```json
{
  "additionalProperties": false,
  "properties": {
    "blacks": {
      "default": 0,
      "description": "Black point",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "brilliance": {
      "default": 0,
      "description": "FL-233: opens the shadows and holds back the highlights (positive), or the reverse (negative), with a slight colour lift; see the develop recipe protocol",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "clarity": {
      "default": 0,
      "description": "Local contrast in the midtones",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "cleanup": {
      "default": [],
      "description": "FL-233: Clean Up operations, applied in order to the original before every other step",
      "items": {
        "$ref": "#/components/schemas/AssetDevelopCleanup"
      },
      "maxItems": 32,
      "type": "array"
    },
    "contrast": {
      "default": 0,
      "description": "Contrast around middle grey",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "crop": {
      "$ref": "#/components/schemas/KnownAssetDevelopCrop",
      "default": {
        "h": 1,
        "w": 1,
        "x": 0,
        "y": 0
      }
    },
    "dehaze": {
      "default": 0,
      "description": "Haze removal (positive) or addition (negative)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "exposure": {
      "default": 0,
      "description": "Exposure in EV; each whole stop doubles the light",
      "format": "double",
      "maximum": 2,
      "minimum": -2,
      "type": "number"
    },
    "flipHorizontal": {
      "default": false,
      "description": "Mirror left to right",
      "type": "boolean"
    },
    "flipVertical": {
      "default": false,
      "description": "Mirror top to bottom",
      "type": "boolean"
    },
    "grain": {
      "default": 0,
      "description": "Film grain amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "hdr": {
      "additionalProperties": false,
      "default": {},
      "properties": {
        "intent": {
          "default": "preserve",
          "enum": [
            "preserve"
          ],
          "type": "string"
        },
        "referenceWhite": {
          "default": 203,
          "enum": [
            203
          ],
          "format": "int32",
          "type": "integer"
        },
        "sdrToneMapper": {
          "default": "libultrahdr/2.0.2-frameleaf.2",
          "enum": [
            "libultrahdr/2.0.2-frameleaf.2"
          ],
          "type": "string"
        },
        "version": {
          "default": 2,
          "enum": [
            2
          ],
          "format": "int32",
          "type": "integer"
        }
      },
      "type": "object"
    },
    "highlights": {
      "default": 0,
      "description": "Highlight recovery (negative) or lift (positive)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "masks": {
      "default": [],
      "description": "Selective adjustments, applied in order after the global develop",
      "items": {
        "$ref": "#/components/schemas/AssetDevelopMask"
      },
      "maxItems": 8,
      "type": "array"
    },
    "noiseReduction": {
      "default": 0,
      "description": "Luminance noise reduction amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "perspective": {
      "$ref": "#/components/schemas/AssetDevelopPerspective",
      "description": "Keystone correction, applied after the quarter turns and flips and before straightening"
    },
    "preset": {
      "$ref": "#/components/schemas/AssetDevelopPreset",
      "default": "Original"
    },
    "presetStrength": {
      "default": 100,
      "description": "How much of the preset is applied, as a percentage",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "renderer": {
      "default": "frameleaf-develop-hdr/2",
      "enum": [
        "frameleaf-develop-hdr/2"
      ],
      "type": "string"
    },
    "rotation": {
      "default": 0,
      "description": "Quarter-turn rotation in degrees, clockwise",
      "maximum": 270,
      "minimum": 0,
      "type": "integer"
    },
    "saturation": {
      "default": 0,
      "description": "Global saturation",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "shadows": {
      "default": 0,
      "description": "Shadow lift (positive) or deepening (negative)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "sharpen": {
      "default": 0,
      "description": "Detail sharpening amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "straighten": {
      "default": 0,
      "description": "Straighten angle in degrees, applied before the crop",
      "format": "double",
      "maximum": 45,
      "minimum": -45,
      "type": "number"
    },
    "temperature": {
      "default": 0,
      "description": "Warm (positive) or cool (negative) white balance shift",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "tint": {
      "default": 0,
      "description": "Magenta (positive) or green (negative) tint",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "version": {
      "enum": [
        4
      ],
      "format": "int32",
      "type": "integer"
    },
    "vibrance": {
      "default": 0,
      "description": "Saturation weighted towards muted colours",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "vignette": {
      "default": 0,
      "description": "Darkened (positive) or lightened (negative) edges",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "whites": {
      "default": 0,
      "description": "White point",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    }
  },
  "required": [
    "version"
  ],
  "type": "object"
}
```

## HdrAssetDevelopRecipeV5

Related models: [AssetDevelopCleanup](models-04.md#assetdevelopcleanup), [AssetDevelopMask](models-04.md#assetdevelopmask), [AssetDevelopPerspective](models-04.md#assetdevelopperspective), [AssetDevelopPreset](models-04.md#assetdeveloppreset), [KnownAssetDevelopCrop](models-14.md#knownassetdevelopcrop).

```json
{
  "additionalProperties": false,
  "properties": {
    "blacks": {
      "default": 0,
      "description": "Black point",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "brilliance": {
      "default": 0,
      "description": "FL-233: opens the shadows and holds back the highlights (positive), or the reverse (negative), with a slight colour lift; see the develop recipe protocol",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "clarity": {
      "default": 0,
      "description": "Local contrast in the midtones",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "cleanup": {
      "default": [],
      "description": "FL-233: Clean Up operations, applied in order to the original before every other step",
      "items": {
        "$ref": "#/components/schemas/AssetDevelopCleanup"
      },
      "maxItems": 32,
      "type": "array"
    },
    "contrast": {
      "default": 0,
      "description": "Contrast around middle grey",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "crop": {
      "$ref": "#/components/schemas/KnownAssetDevelopCrop",
      "default": {
        "h": 1,
        "w": 1,
        "x": 0,
        "y": 0
      }
    },
    "dehaze": {
      "default": 0,
      "description": "Haze removal (positive) or addition (negative)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "exposure": {
      "default": 0,
      "description": "Exposure in EV; each whole stop doubles the light",
      "format": "double",
      "maximum": 2,
      "minimum": -2,
      "type": "number"
    },
    "flipHorizontal": {
      "default": false,
      "description": "Mirror left to right",
      "type": "boolean"
    },
    "flipVertical": {
      "default": false,
      "description": "Mirror top to bottom",
      "type": "boolean"
    },
    "grain": {
      "default": 0,
      "description": "Film grain amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "hdr": {
      "additionalProperties": false,
      "default": {},
      "properties": {
        "intent": {
          "default": "preserve",
          "enum": [
            "preserve"
          ],
          "type": "string"
        },
        "referenceWhite": {
          "default": 203,
          "enum": [
            203
          ],
          "format": "int32",
          "type": "integer"
        },
        "sdrToneMapper": {
          "default": "libultrahdr/2.0.2-frameleaf.3",
          "enum": [
            "libultrahdr/2.0.2-frameleaf.3"
          ],
          "type": "string"
        },
        "version": {
          "default": 3,
          "enum": [
            3
          ],
          "format": "int32",
          "type": "integer"
        }
      },
      "type": "object"
    },
    "highlights": {
      "default": 0,
      "description": "Highlight recovery (negative) or lift (positive)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "masks": {
      "default": [],
      "description": "Selective adjustments, applied in order after the global develop",
      "items": {
        "$ref": "#/components/schemas/AssetDevelopMask"
      },
      "maxItems": 8,
      "type": "array"
    },
    "noiseReduction": {
      "default": 0,
      "description": "Luminance noise reduction amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "perspective": {
      "$ref": "#/components/schemas/AssetDevelopPerspective",
      "description": "Keystone correction, applied after the quarter turns and flips and before straightening"
    },
    "preset": {
      "$ref": "#/components/schemas/AssetDevelopPreset",
      "default": "Original"
    },
    "presetStrength": {
      "default": 100,
      "description": "How much of the preset is applied, as a percentage",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "renderer": {
      "default": "frameleaf-develop-hdr/3",
      "enum": [
        "frameleaf-develop-hdr/3"
      ],
      "type": "string"
    },
    "rotation": {
      "default": 0,
      "description": "Quarter-turn rotation in degrees, clockwise",
      "maximum": 270,
      "minimum": 0,
      "type": "integer"
    },
    "saturation": {
      "default": 0,
      "description": "Global saturation",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "shadows": {
      "default": 0,
      "description": "Shadow lift (positive) or deepening (negative)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "sharpen": {
      "default": 0,
      "description": "Detail sharpening amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "straighten": {
      "default": 0,
      "description": "Straighten angle in degrees, applied before the crop",
      "format": "double",
      "maximum": 45,
      "minimum": -45,
      "type": "number"
    },
    "temperature": {
      "default": 0,
      "description": "Warm (positive) or cool (negative) white balance shift",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "tint": {
      "default": 0,
      "description": "Magenta (positive) or green (negative) tint",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "version": {
      "enum": [
        5
      ],
      "format": "int32",
      "type": "integer"
    },
    "vibrance": {
      "default": 0,
      "description": "Saturation weighted towards muted colours",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "vignette": {
      "default": 0,
      "description": "Darkened (positive) or lightened (negative) edges",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "whites": {
      "default": 0,
      "description": "White point",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    }
  },
  "required": [
    "version"
  ],
  "type": "object"
}
```
