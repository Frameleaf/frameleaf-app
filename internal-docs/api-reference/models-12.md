# Server API models 12

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

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

Related models: [AssetDevelopCleanup](models-04.md#assetdevelopcleanup), [AssetDevelopMask](models-04.md#assetdevelopmask), [AssetDevelopPreset](models-04.md#assetdeveloppreset), [KnownAssetDevelopCrop](models-14.md#knownassetdevelopcrop).

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

## HlsVideoResolution


```json
{
  "description": "HLS video resolution",
  "enum": [
    480,
    720,
    1080,
    1440,
    2160
  ],
  "type": "integer"
}
```

## ICloudAttachAnswerDto

Related models: [ICloudAttachState](models-12.md#icloudattachstate).

```json
{
  "properties": {
    "id": {
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/ICloudAttachState"
    }
  },
  "required": [
    "id",
    "state"
  ],
  "type": "object"
}
```

## ICloudAttachDto

Related models: [ICloudAttachItemDto](models-12.md#icloudattachitemdto).

```json
{
  "properties": {
    "deviceKey": {
      "description": "This device's backup identity (the backup device registry's deviceKey)",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/ICloudAttachItemDto"
      },
      "maxItems": 500,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "deviceKey",
    "items"
  ],
  "type": "object"
}
```

## ICloudAttachItemDto

Related models: [ICloudIdentityRole](models-13.md#icloudidentityrole).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "cloudIdentifier": {
      "description": "PHCloudIdentifier.stringValue, as the device reports it",
      "maxLength": 512,
      "minLength": 1,
      "type": "string"
    },
    "creationDate": {
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "editVersion": {
      "maxLength": 512,
      "minLength": 1,
      "type": "string"
    },
    "id": {
      "maxLength": 256,
      "minLength": 1,
      "type": "string"
    },
    "originalFilename": {
      "maxLength": 1024,
      "minLength": 1,
      "type": "string"
    },
    "pixelHeight": {
      "maximum": 1000000,
      "minimum": 1,
      "type": "integer"
    },
    "pixelWidth": {
      "maximum": 1000000,
      "minimum": 1,
      "type": "integer"
    },
    "role": {
      "$ref": "#/components/schemas/ICloudIdentityRole"
    },
    "sha256": {
      "pattern": "^[\\dA-Fa-f]{64}$",
      "type": "string"
    },
    "uti": {
      "maxLength": 256,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "cloudIdentifier",
    "id",
    "role",
    "sha256"
  ],
  "type": "object"
}
```

## ICloudAttachResponseDto

Related models: [ICloudAttachAnswerDto](models-12.md#icloudattachanswerdto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/ICloudAttachAnswerDto"
      },
      "type": "array"
    }
  },
  "required": [
    "items"
  ],
  "type": "object"
}
```

## ICloudAttachState


```json
{
  "enum": [
    "attached",
    "unavailable",
    "invalid"
  ],
  "type": "string"
}
```

## ICloudAuthAction


```json
{
  "enum": [
    "login",
    "two-factor",
    "device-approval",
    "validate"
  ],
  "type": "string"
}
```

## ICloudAuthDto

Related models: [ICloudAuthAction](models-12.md#icloudauthaction).

```json
{
  "additionalProperties": false,
  "properties": {
    "action": {
      "$ref": "#/components/schemas/ICloudAuthAction"
    },
    "appleId": {
      "format": "email",
      "maxLength": 320,
      "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
      "type": "string"
    },
    "code": {
      "pattern": "^\\d{6}$",
      "type": "string"
    },
    "password": {
      "maxLength": 1024,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "action"
  ],
  "type": "object"
}
```

## ICloudClaimAnswerDto

Related models: [ICloudClaimHolder](models-12.md#icloudclaimholder), [ICloudClaimState](models-12.md#icloudclaimstate).

```json
{
  "properties": {
    "claimId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "connectionId": {
      "description": "sync-covers: the connection that covers it",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "cplAssetRecordName": {
      "nullable": true,
      "type": "string"
    },
    "expiresAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "holder": {
      "allOf": [
        {
          "$ref": "#/components/schemas/ICloudClaimHolder"
        }
      ],
      "description": "held: who holds it",
      "nullable": true
    },
    "id": {
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/ICloudClaimState"
    },
    "takeOverAt": {
      "description": "sync-covers on an unhealthy connection: when this device may take over without asking (72 hours after it became unhealthy)",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "claimId",
    "connectionId",
    "cplAssetRecordName",
    "expiresAt",
    "holder",
    "id",
    "state",
    "takeOverAt"
  ],
  "type": "object"
}
```

## ICloudClaimDto

Related models: [ICloudClaimItemDto](models-12.md#icloudclaimitemdto).

```json
{
  "properties": {
    "deviceKey": {
      "description": "This device's backup identity (the backup device registry's deviceKey)",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/ICloudClaimItemDto"
      },
      "maxItems": 500,
      "minItems": 1,
      "type": "array"
    },
    "takeOver": {
      "description": "The person chose \"Back them up from this iPhone\": claim items an unhealthy sync connection covers without waiting 72 hours",
      "type": "boolean"
    },
    "ttlSec": {
      "description": "Seconds the claim lives before it must be renewed (default and most: 10 minutes)",
      "maximum": 600,
      "minimum": 60,
      "type": "integer"
    }
  },
  "required": [
    "deviceKey",
    "items"
  ],
  "type": "object"
}
```

## ICloudClaimHolder


```json
{
  "enum": [
    "device",
    "icloud-sync"
  ],
  "type": "string"
}
```

## ICloudClaimItemDto


```json
{
  "properties": {
    "cloudIdentifier": {
      "description": "PHCloudIdentifier.stringValue, as the device reports it",
      "maxLength": 512,
      "minLength": 1,
      "type": "string"
    },
    "creationDate": {
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "maxLength": 256,
      "minLength": 1,
      "type": "string"
    },
    "originalFilename": {
      "maxLength": 1024,
      "minLength": 1,
      "type": "string"
    },
    "pixelHeight": {
      "maximum": 1000000,
      "minimum": 1,
      "type": "integer"
    },
    "pixelWidth": {
      "maximum": 1000000,
      "minimum": 1,
      "type": "integer"
    },
    "uti": {
      "maxLength": 256,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "cloudIdentifier",
    "id"
  ],
  "type": "object"
}
```

## ICloudClaimReleaseDto


```json
{
  "properties": {
    "claimIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      },
      "maxItems": 500,
      "minItems": 1,
      "type": "array"
    },
    "deviceKey": {
      "description": "This device's backup identity (the backup device registry's deviceKey)",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "claimIds",
    "deviceKey"
  ],
  "type": "object"
}
```

## ICloudClaimReleaseResponseDto


```json
{
  "properties": {
    "released": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "released"
  ],
  "type": "object"
}
```

## ICloudClaimRenewDto


```json
{
  "properties": {
    "claimIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      },
      "maxItems": 500,
      "minItems": 1,
      "type": "array"
    },
    "deviceKey": {
      "description": "This device's backup identity (the backup device registry's deviceKey)",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "ttlSec": {
      "description": "Seconds the claim lives before it must be renewed (default and most: 10 minutes)",
      "maximum": 600,
      "minimum": 60,
      "type": "integer"
    }
  },
  "required": [
    "claimIds",
    "deviceKey"
  ],
  "type": "object"
}
```

## ICloudClaimRenewResponseDto

Related models: [ICloudClaimRenewedDto](models-12.md#icloudclaimreneweddto).

```json
{
  "description": "Only the claims still held; a missing one expired or was taken over",
  "properties": {
    "claims": {
      "items": {
        "$ref": "#/components/schemas/ICloudClaimRenewedDto"
      },
      "type": "array"
    }
  },
  "required": [
    "claims"
  ],
  "type": "object"
}
```

## ICloudClaimRenewedDto


```json
{
  "properties": {
    "claimId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "expiresAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "claimId",
    "expiresAt"
  ],
  "type": "object"
}
```

## ICloudClaimResponseDto

Related models: [ICloudClaimAnswerDto](models-12.md#icloudclaimanswerdto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/ICloudClaimAnswerDto"
      },
      "type": "array"
    }
  },
  "required": [
    "items"
  ],
  "type": "object"
}
```

## ICloudClaimState


```json
{
  "description": "granted: this device holds the claim; held: another device or a sync run does; sync-covers: a healthy sync connection covers the item, so the server fetches it; invalid: the identifier is not an iCloud item identifier",
  "enum": [
    "granted",
    "held",
    "sync-covers",
    "invalid"
  ],
  "type": "string"
}
```

## ICloudConnectionCreateDto


```json
{
  "additionalProperties": false,
  "properties": {
    "config": {
      "additionalProperties": false,
      "default": {
        "albums": [],
        "concurrency": 1,
        "includeEdits": true,
        "includeHidden": false,
        "intervalHours": 24,
        "libraries": [],
        "recoverExternalAsManaged": false,
        "stagingBytes": 21474836480
      },
      "properties": {
        "albums": {
          "default": [],
          "items": {
            "maxLength": 1024,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 10000,
          "type": "array"
        },
        "concurrency": {
          "default": 1,
          "maximum": 4,
          "minimum": 1,
          "type": "integer"
        },
        "includeEdits": {
          "default": true,
          "type": "boolean"
        },
        "includeHidden": {
          "default": false,
          "type": "boolean"
        },
        "intervalHours": {
          "default": 24,
          "maximum": 8760,
          "minimum": 1,
          "type": "integer"
        },
        "libraries": {
          "default": [],
          "items": {
            "maxLength": 1024,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 100,
          "type": "array"
        },
        "recoverExternalAsManaged": {
          "default": false,
          "type": "boolean"
        },
        "stagingBytes": {
          "default": 21474836480,
          "maximum": 9007199254740991,
          "minimum": 1048576,
          "type": "integer"
        }
      },
      "type": "object"
    },
    "label": {
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "label"
  ],
  "type": "object"
}
```

## ICloudConnectionHealth


```json
{
  "enum": [
    "healthy",
    "paused",
    "reauthentication-required",
    "device-approval-required",
    "failing",
    "disconnected"
  ],
  "type": "string"
}
```

## ICloudConnectionResponseDto

Related models: [ICloudSyncRunDto](models-13.md#icloudsyncrundto).

```json
{
  "properties": {
    "authenticated": {
      "description": "Whether an encrypted Apple session is stored; the session is never returned",
      "type": "boolean"
    },
    "config": {
      "additionalProperties": false,
      "properties": {
        "albums": {
          "items": {
            "maxLength": 1024,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 10000,
          "type": "array"
        },
        "concurrency": {
          "maximum": 4,
          "minimum": 1,
          "type": "integer"
        },
        "includeEdits": {
          "type": "boolean"
        },
        "includeHidden": {
          "type": "boolean"
        },
        "intervalHours": {
          "maximum": 8760,
          "minimum": 1,
          "type": "integer"
        },
        "libraries": {
          "items": {
            "maxLength": 1024,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 100,
          "type": "array"
        },
        "recoverExternalAsManaged": {
          "type": "boolean"
        },
        "stagingBytes": {
          "maximum": 9007199254740991,
          "minimum": 1048576,
          "type": "integer"
        }
      },
      "required": [
        "libraries",
        "albums",
        "includeEdits",
        "includeHidden",
        "recoverExternalAsManaged",
        "intervalHours",
        "concurrency",
        "stagingBytes"
      ],
      "type": "object"
    },
    "counts": {
      "additionalProperties": {
        "maximum": 9007199254740991,
        "minimum": -9007199254740991,
        "type": "integer"
      },
      "type": "object"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "identityReuseAuthority": {
      "properties": {
        "available": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "executionAvailable": {
          "description": "Foundation consent does not enable weekly execution or identity reuse",
          "enum": [
            false
          ],
          "type": "boolean"
        },
        "includeProtected": {
          "type": "boolean"
        },
        "regrantRequired": {
          "type": "boolean"
        }
      },
      "required": [
        "enabled",
        "includeProtected",
        "available",
        "regrantRequired",
        "executionAvailable"
      ],
      "type": "object"
    },
    "label": {
      "type": "string"
    },
    "lastError": {
      "nullable": true,
      "type": "string"
    },
    "nextRunAt": {
      "nullable": true,
      "type": "string"
    },
    "run": {
      "allOf": [
        {
          "$ref": "#/components/schemas/ICloudSyncRunDto"
        }
      ],
      "description": "The current or most recent sync run",
      "nullable": true
    },
    "state": {
      "type": "string"
    }
  },
  "required": [
    "authenticated",
    "config",
    "counts",
    "id",
    "label",
    "lastError",
    "nextRunAt",
    "run",
    "state"
  ],
  "type": "object"
}
```

## ICloudConnectionUpdateDto


```json
{
  "additionalProperties": false,
  "properties": {
    "config": {
      "additionalProperties": false,
      "properties": {
        "albums": {
          "items": {
            "maxLength": 1024,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 10000,
          "type": "array"
        },
        "concurrency": {
          "maximum": 4,
          "minimum": 1,
          "type": "integer"
        },
        "includeEdits": {
          "type": "boolean"
        },
        "includeHidden": {
          "type": "boolean"
        },
        "intervalHours": {
          "maximum": 8760,
          "minimum": 1,
          "type": "integer"
        },
        "libraries": {
          "items": {
            "maxLength": 1024,
            "minLength": 1,
            "type": "string"
          },
          "maxItems": 100,
          "type": "array"
        },
        "recoverExternalAsManaged": {
          "type": "boolean"
        },
        "stagingBytes": {
          "maximum": 9007199254740991,
          "minimum": 1048576,
          "type": "integer"
        }
      },
      "type": "object"
    },
    "label": {
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```
