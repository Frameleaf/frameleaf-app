# Server API models 16

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## LivePhotoRelinkResponseDto

Related models: [LivePhotoRelinkResultDto](models-16.md#livephotorelinkresultdto).

```json
{
  "properties": {
    "results": {
      "items": {
        "$ref": "#/components/schemas/LivePhotoRelinkResultDto"
      },
      "type": "array"
    }
  },
  "required": [
    "results"
  ],
  "type": "object"
}
```

## LivePhotoRelinkResultDto


```json
{
  "properties": {
    "error": {
      "type": "string"
    },
    "photoId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "success": {
      "type": "boolean"
    },
    "videoId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "photoId",
    "success",
    "videoId"
  ],
  "type": "object"
}
```

## LivePhotoUploadCommitDto


```json
{
  "properties": {
    "stillResourceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "videoResourceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "stillResourceId",
    "videoResourceId"
  ],
  "type": "object"
}
```

## LivePhotoUploadResultDto

Related models: [AssetUploadResultDto](models-06.md#assetuploadresultdto).

```json
{
  "properties": {
    "still": {
      "$ref": "#/components/schemas/AssetUploadResultDto"
    },
    "video": {
      "$ref": "#/components/schemas/AssetUploadResultDto"
    }
  },
  "required": [
    "still",
    "video"
  ],
  "type": "object"
}
```

## LogLevel


```json
{
  "description": "Log level",
  "enum": [
    "verbose",
    "debug",
    "log",
    "warn",
    "error",
    "fatal"
  ],
  "type": "string"
}
```

## LoginCredentialDto


```json
{
  "properties": {
    "email": {
      "description": "User email",
      "example": "testuser@email.com",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "password": {
      "description": "User password",
      "example": "password",
      "type": "string"
    },
    "rememberMe": {
      "description": "Persist authentication cookies across browser sessions (default true)",
      "type": "boolean"
    }
  },
  "required": [
    "email",
    "password"
  ],
  "type": "object"
}
```

## LoginResponseDto


```json
{
  "properties": {
    "accessToken": {
      "description": "Access token",
      "type": "string"
    },
    "isAdmin": {
      "description": "Is admin user",
      "type": "boolean"
    },
    "isOnboarded": {
      "description": "Is onboarded",
      "type": "boolean"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "profileImagePath": {
      "description": "Profile image path",
      "type": "string"
    },
    "shouldChangePassword": {
      "description": "Should change password",
      "type": "boolean"
    },
    "userEmail": {
      "description": "User email",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "accessToken",
    "isAdmin",
    "isOnboarded",
    "name",
    "profileImagePath",
    "shouldChangePassword",
    "userEmail",
    "userId"
  ],
  "type": "object"
}
```

## LogoutResponseDto


```json
{
  "properties": {
    "redirectUri": {
      "description": "Redirect URI",
      "type": "string"
    },
    "successful": {
      "description": "Logout successful",
      "type": "boolean"
    }
  },
  "required": [
    "redirectUri",
    "successful"
  ],
  "type": "object"
}
```

## LookParameters


```json
{
  "properties": {
    "intensity": {
      "default": 100,
      "description": "Filter or effect intensity",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "name": {
      "description": "Filter or effect name",
      "maxLength": 64,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
}
```

## MachineLearningHardwareAcceleration


```json
{
  "description": "Machine learning hardware acceleration backend",
  "enum": [
    "auto",
    "openvino",
    "cuda"
  ],
  "type": "string"
}
```

## MachineLearningHardwareResponseDto

Related models: [MachineLearningHardwareAcceleration](models-16.md#machinelearninghardwareacceleration).

```json
{
  "properties": {
    "cudaDeviceCount": {
      "description": "Available PyTorch CUDA device count",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "openvinoDeviceIds": {
      "description": "Available OpenVINO device IDs",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "preferredAcceleration": {
      "$ref": "#/components/schemas/MachineLearningHardwareAcceleration",
      "description": "Detected preferred hardware acceleration"
    },
    "providers": {
      "description": "Available ONNX Runtime providers",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "torchCudaAvailable": {
      "description": "Whether PyTorch CUDA is available",
      "type": "boolean"
    }
  },
  "required": [
    "cudaDeviceCount",
    "openvinoDeviceIds",
    "preferredAcceleration",
    "providers",
    "torchCudaAvailable"
  ],
  "type": "object"
}
```

## MaintenanceAction


```json
{
  "description": "Maintenance action",
  "enum": [
    "start",
    "end",
    "select_database_restore",
    "restore_database"
  ],
  "type": "string"
}
```

## MaintenanceAuthDto


```json
{
  "properties": {
    "username": {
      "description": "Maintenance username",
      "type": "string"
    }
  },
  "required": [
    "username"
  ],
  "type": "object"
}
```

## MaintenanceDetectInstallResponseDto

Related models: [MaintenanceDetectInstallStorageFolderDto](models-16.md#maintenancedetectinstallstoragefolderdto).

```json
{
  "properties": {
    "storage": {
      "items": {
        "$ref": "#/components/schemas/MaintenanceDetectInstallStorageFolderDto"
      },
      "type": "array"
    }
  },
  "required": [
    "storage"
  ],
  "type": "object"
}
```

## MaintenanceDetectInstallStorageFolderDto

Related models: [StorageFolder](models-33.md#storagefolder).

```json
{
  "properties": {
    "files": {
      "description": "Number of files in the folder",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "folder": {
      "$ref": "#/components/schemas/StorageFolder"
    },
    "readable": {
      "description": "Whether the folder is readable",
      "type": "boolean"
    },
    "writable": {
      "description": "Whether the folder is writable",
      "type": "boolean"
    }
  },
  "required": [
    "files",
    "folder",
    "readable",
    "writable"
  ],
  "type": "object"
}
```

## MaintenanceLoginDto


```json
{
  "properties": {
    "token": {
      "description": "Maintenance token",
      "type": "string"
    }
  },
  "type": "object"
}
```

## MaintenanceStatusResponseDto

Related models: [MaintenanceAction](models-16.md#maintenanceaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MaintenanceAction"
    },
    "active": {
      "type": "boolean"
    },
    "error": {
      "type": "string"
    },
    "progress": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "reason": {
      "description": "Why the server is in maintenance, as set by the administrator (public)",
      "type": "string"
    },
    "task": {
      "type": "string"
    }
  },
  "required": [
    "action",
    "active"
  ],
  "type": "object"
}
```

## ManagedUploadsStatsResponseDto


```json
{
  "properties": {
    "ownerId": {
      "description": "Account whose uploads these are",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "photos": {
      "description": "Number of photos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "total": {
      "description": "Total number of assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usage": {
      "description": "Storage usage in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usagePhysical": {
      "description": "Storage usage in bytes, counting each distinct original file once",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "videos": {
      "description": "Number of videos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "ownerId",
    "photos",
    "total",
    "usage",
    "usagePhysical",
    "videos"
  ],
  "type": "object"
}
```

## ManualJobName


```json
{
  "description": "Manual job name",
  "enum": [
    "person-cleanup",
    "tag-cleanup",
    "user-cleanup",
    "memory-cleanup",
    "memory-create",
    "backup-database",
    "best-photos-backfill",
    "physical-deduplication-dry-run",
    "physical-deduplication-apply",
    "integrity-missing-files",
    "integrity-untracked-files",
    "integrity-checksum-mismatch",
    "integrity-missing-files-refresh",
    "integrity-untracked-files-refresh",
    "integrity-checksum-mismatch-refresh",
    "integrity-missing-files-delete-all",
    "integrity-untracked-files-delete-all",
    "integrity-checksum-mismatch-delete-all",
    "analytics-collect"
  ],
  "type": "string"
}
```

## MapMarkerResponseDto

Related models: [AssetTypeEnum](models-06.md#assettypeenum).

```json
{
  "properties": {
    "city": {
      "description": "City name",
      "nullable": true,
      "type": "string"
    },
    "country": {
      "description": "Country name",
      "nullable": true,
      "type": "string"
    },
    "fileCreatedAt": {
      "description": "UTC timestamp when the asset was captured",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "lat": {
      "description": "Latitude",
      "format": "double",
      "type": "number"
    },
    "localDateTime": {
      "description": "Capture date and time in the local time zone where it was taken, encoded as UTC",
      "format": "date-time",
      "type": "string"
    },
    "lon": {
      "description": "Longitude",
      "format": "double",
      "type": "number"
    },
    "originalFileName": {
      "description": "Original file name",
      "type": "string"
    },
    "state": {
      "description": "State/Province name",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    }
  },
  "required": [
    "city",
    "country",
    "id",
    "lat",
    "lon",
    "state"
  ],
  "type": "object"
}
```

## MapReverseGeocodeResponseDto


```json
{
  "properties": {
    "city": {
      "description": "City name",
      "nullable": true,
      "type": "string"
    },
    "country": {
      "description": "Country name",
      "nullable": true,
      "type": "string"
    },
    "state": {
      "description": "State/Province name",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "city",
    "country",
    "state"
  ],
  "type": "object"
}
```

## MapStatisticsResponseDto


```json
{
  "properties": {
    "archived": {
      "description": "The viewer's own located archived items",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "partner": {
      "description": "Always 0: partners' items arrive as the viewer's own copies (kept for older clients)",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "unlocated": {
      "description": "The viewer's own timeline items without a location",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "archived",
    "partner",
    "unlocated"
  ],
  "type": "object"
}
```

## MediaHealthActivityAction


```json
{
  "description": "What the job did",
  "enum": [
    "scan",
    "locate",
    "relink-missing-media",
    "recover-damaged-media",
    "trash-damaged-media"
  ],
  "type": "string"
}
```

## MediaHealthActivityDto

Related models: [MediaHealthActivityAction](models-16.md#mediahealthactivityaction), [MediaOperationStatus](models-17.md#mediaoperationstatus).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MediaHealthActivityAction"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "finishedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Media operation ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "items": {
      "description": "Items the job covered",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    }
  },
  "required": [
    "action",
    "createdAt",
    "finishedAt",
    "id",
    "items",
    "status"
  ],
  "type": "object"
}
```

## MediaHealthBucketDto

Related models: [MediaHealthItemDto](models-16.md#mediahealthitemdto).

```json
{
  "properties": {
    "count": {
      "description": "Number of findings in the bucket",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthItemDto"
      },
      "type": "array"
    },
    "timeBucket": {
      "description": "Timeline bucket date",
      "type": "string"
    }
  },
  "required": [
    "count",
    "items",
    "timeBucket"
  ],
  "type": "object"
}
```

## MediaHealthBulkActionDto


```json
{
  "properties": {
    "ids": {
      "description": "Media health finding IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
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

## MediaHealthBulkResponseDto

Related models: [MediaHealthBulkResultDto](models-16.md#mediahealthbulkresultdto).

```json
{
  "properties": {
    "operationId": {
      "description": "The durable job applying the accepted findings, in Activity; null when none was accepted",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "results": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthBulkResultDto"
      },
      "type": "array"
    }
  },
  "required": [
    "results"
  ],
  "type": "object"
}
```

## MediaHealthBulkResultDto

Related models: [MediaHealthStatus](models-16.md#mediahealthstatus).

```json
{
  "properties": {
    "error": {
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaHealthStatus"
    },
    "success": {
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

## MediaHealthCandidateChoiceDto


```json
{
  "properties": {
    "candidateId": {
      "description": "Candidate ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "findingId": {
      "description": "Media health finding ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "candidateId",
    "findingId"
  ],
  "type": "object"
}
```

## MediaHealthCandidateDto

Related models: [MediaHealthChecksumDto](models-16.md#mediahealthchecksumdto), [MediaHealthRootKind](models-16.md#mediahealthrootkind), [MediaHealthStatus](models-16.md#mediahealthstatus).

```json
{
  "properties": {
    "candidatePath": {
      "description": "Candidate file path",
      "type": "string"
    },
    "checkedAt": {
      "format": "date-time",
      "type": "string"
    },
    "checksumMatch": {
      "description": "The candidate has exactly the checksum recorded for the original",
      "type": "boolean"
    },
    "checksums": {
      "description": "The checksums the candidate matched, as measured",
      "items": {
        "$ref": "#/components/schemas/MediaHealthChecksumDto"
      },
      "type": "array"
    },
    "chosen": {
      "description": "The reviewer chose this candidate for the finding",
      "type": "boolean"
    },
    "decodeValid": {
      "description": "The candidate decoded successfully; null when not checked",
      "nullable": true,
      "type": "boolean"
    },
    "evidence": {
      "additionalProperties": {},
      "type": "object"
    },
    "healthId": {
      "description": "Media health finding ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "Candidate ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "resolution": {
      "additionalProperties": {},
      "type": "object"
    },
    "rootId": {
      "description": "Search location the candidate was found in",
      "nullable": true,
      "type": "string"
    },
    "rootKind": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthRootKind"
        }
      ],
      "nullable": true
    },
    "status": {
      "$ref": "#/components/schemas/MediaHealthStatus"
    },
    "visualMatchScore": {
      "description": "Visual match score from 0 to 1",
      "format": "double",
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "candidatePath",
    "checkedAt",
    "checksumMatch",
    "checksums",
    "chosen",
    "decodeValid",
    "evidence",
    "healthId",
    "id",
    "resolution",
    "rootId",
    "rootKind",
    "status",
    "visualMatchScore"
  ],
  "type": "object"
}
```

## MediaHealthCareSettingsDto


```json
{
  "properties": {
    "checksumScan": {
      "description": "Health scans verify original checksums",
      "type": "boolean"
    },
    "duplicateReview": {
      "description": "Near-duplicates are grouped for review",
      "type": "boolean"
    },
    "healthScan": {
      "description": "Incremental health scans run on a schedule",
      "type": "boolean"
    },
    "integrityAudit": {
      "description": "Database and file reference audits run on their schedules",
      "type": "boolean"
    },
    "rawRecovery": {
      "description": "Searches for originals include RAW originals",
      "type": "boolean"
    }
  },
  "required": [
    "checksumScan",
    "duplicateReview",
    "healthScan",
    "integrityAudit",
    "rawRecovery"
  ],
  "type": "object"
}
```

## MediaHealthCategory


```json
{
  "description": "Media health category",
  "enum": [
    "missing",
    "corrupt"
  ],
  "type": "string"
}
```

## MediaHealthChecksumAlgorithm


```json
{
  "description": "Checksum algorithm",
  "enum": [
    "sha1",
    "sha256"
  ],
  "type": "string"
}
```

## MediaHealthChecksumDto

Related models: [MediaHealthChecksumAlgorithm](models-16.md#mediahealthchecksumalgorithm).

```json
{
  "properties": {
    "algorithm": {
      "$ref": "#/components/schemas/MediaHealthChecksumAlgorithm"
    },
    "value": {
      "description": "Checksum as lowercase hex",
      "type": "string"
    }
  },
  "required": [
    "algorithm",
    "value"
  ],
  "type": "object"
}
```

## MediaHealthChooseCandidatesDto

Related models: [MediaHealthCandidateChoiceDto](models-16.md#mediahealthcandidatechoicedto).

```json
{
  "properties": {
    "choices": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthCandidateChoiceDto"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "choices"
  ],
  "type": "object"
}
```

## MediaHealthDeleteCorruptDto


```json
{
  "properties": {
    "confirmText": {
      "description": "Typed confirmation text",
      "type": "string"
    },
    "ids": {
      "description": "Media health finding IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "confirmText",
    "ids"
  ],
  "type": "object"
}
```

## MediaHealthItemDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto), [MediaHealthCandidateDto](models-16.md#mediahealthcandidatedto), [MediaHealthCategory](models-16.md#mediahealthcategory), [MediaHealthChecksumDto](models-16.md#mediahealthchecksumdto), [MediaHealthProvenanceDto](models-16.md#mediahealthprovenancedto), [MediaHealthSeverity](models-16.md#mediahealthseverity), [MediaHealthStatus](models-16.md#mediahealthstatus).

```json
{
  "properties": {
    "asset": {
      "$ref": "#/components/schemas/AssetResponseDto"
    },
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "candidates": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthCandidateDto"
      },
      "type": "array"
    },
    "category": {
      "$ref": "#/components/schemas/MediaHealthCategory"
    },
    "checkedAt": {
      "format": "date-time",
      "type": "string"
    },
    "dismissedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "evidence": {
      "additionalProperties": {},
      "type": "object"
    },
    "expectedChecksums": {
      "description": "The checksums recorded for the original, which a copy must match exactly",
      "items": {
        "$ref": "#/components/schemas/MediaHealthChecksumDto"
      },
      "type": "array"
    },
    "id": {
      "description": "Media health finding ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "originalFileName": {
      "description": "Original media filename",
      "type": "string"
    },
    "originalPath": {
      "description": "Original media path",
      "type": "string"
    },
    "provenance": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthProvenanceDto"
        }
      ],
      "nullable": true
    },
    "resolution": {
      "additionalProperties": {},
      "type": "object"
    },
    "resolvedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "severity": {
      "$ref": "#/components/schemas/MediaHealthSeverity"
    },
    "status": {
      "$ref": "#/components/schemas/MediaHealthStatus"
    }
  },
  "required": [
    "asset",
    "assetId",
    "candidates",
    "category",
    "checkedAt",
    "dismissedAt",
    "evidence",
    "expectedChecksums",
    "id",
    "originalFileName",
    "originalPath",
    "provenance",
    "resolution",
    "resolvedAt",
    "severity",
    "status"
  ],
  "type": "object"
}
```

## MediaHealthListResponseDto

Related models: [MediaHealthBucketDto](models-16.md#mediahealthbucketdto), [MediaHealthRunResponseDto](models-16.md#mediahealthrunresponsedto).

```json
{
  "properties": {
    "buckets": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthBucketDto"
      },
      "type": "array"
    },
    "run": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthRunResponseDto"
        }
      ],
      "nullable": true
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "buckets",
    "run",
    "total"
  ],
  "type": "object"
}
```

## MediaHealthLocateDto


```json
{
  "properties": {
    "ids": {
      "description": "Media health finding IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    },
    "rootIds": {
      "description": "Search locations; library storage and external libraries when omitted",
      "items": {
        "maxLength": 200,
        "minLength": 1,
        "type": "string"
      },
      "maxItems": 50,
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

## MediaHealthOperationDto

Related models: [MediaHealthOperationMode](models-16.md#mediahealthoperationmode), [MediaOperationStatus](models-17.md#mediaoperationstatus).

```json
{
  "properties": {
    "autoRetries": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "cancelRequestedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "finishedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Media operation ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "mode": {
      "$ref": "#/components/schemas/MediaHealthOperationMode"
    },
    "pauseRequestedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "processedUnits": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "progress": {
      "format": "double",
      "type": "number"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    },
    "totalUnits": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "autoRetries",
    "cancelRequestedAt",
    "createdAt",
    "error",
    "finishedAt",
    "id",
    "mode",
    "pauseRequestedAt",
    "processedUnits",
    "progress",
    "status",
    "totalUnits",
    "updatedAt"
  ],
  "type": "object"
}
```

## MediaHealthOperationMode


```json
{
  "description": "A library scan or a search for originals",
  "enum": [
    "scan",
    "locate"
  ],
  "type": "string"
}
```

## MediaHealthProvenanceAction


```json
{
  "description": "What was done",
  "enum": [
    "relinked",
    "recovered"
  ],
  "type": "string"
}
```

## MediaHealthProvenanceDto

Related models: [MediaHealthProvenanceAction](models-16.md#mediahealthprovenanceaction), [MediaHealthRootKind](models-16.md#mediahealthrootkind).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MediaHealthProvenanceAction"
    },
    "at": {
      "description": "When it was done",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "previousPath": {
      "description": "The path the original had before",
      "nullable": true,
      "type": "string"
    },
    "rootId": {
      "description": "Search location the copy came from",
      "nullable": true,
      "type": "string"
    },
    "rootKind": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthRootKind"
        }
      ],
      "nullable": true
    },
    "rootLabel": {
      "description": "Name of the search location",
      "nullable": true,
      "type": "string"
    },
    "sourcePath": {
      "description": "The verified copy that was used",
      "nullable": true,
      "type": "string"
    },
    "userId": {
      "description": "The account that did it",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "action",
    "at",
    "previousPath",
    "rootId",
    "rootKind",
    "rootLabel",
    "sourcePath",
    "userId"
  ],
  "type": "object"
}
```

## MediaHealthQueuesDto


```json
{
  "properties": {
    "damagedConfirmed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "damagedSuspected": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "duplicates": {
      "description": "Duplicate groups waiting for review",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "enrichmentPending": {
      "description": "Items whose metadata has not been read yet",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "importReview": {
      "description": "Imported items that need review; null when unavailable",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "missing": {
      "description": "Missing originals that still need a decision",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "missingVerified": {
      "description": "Missing originals with a verified exact copy",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "unsupportedRaw": {
      "description": "Kept apart from damage: the decoder cannot read the format",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "damagedConfirmed",
    "damagedSuspected",
    "duplicates",
    "enrichmentPending",
    "importReview",
    "missing",
    "missingVerified",
    "unsupportedRaw"
  ],
  "type": "object"
}
```

## MediaHealthRecoverDto

Related models: [MediaHealthCandidateChoiceDto](models-16.md#mediahealthcandidatechoicedto).

```json
{
  "properties": {
    "choices": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthCandidateChoiceDto"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    },
    "confirmed": {
      "description": "Must be true: the reviewer checked the checksum and decode evidence and keeps the damaged source",
      "type": "boolean"
    }
  },
  "required": [
    "choices",
    "confirmed"
  ],
  "type": "object"
}
```

## MediaHealthRootDto

Related models: [MediaHealthRootKind](models-16.md#mediahealthrootkind).

```json
{
  "properties": {
    "id": {
      "description": "Search location ID",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/MediaHealthRootKind"
    },
    "label": {
      "type": "string"
    },
    "paths": {
      "description": "Folders searched, for review",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "id",
    "kind",
    "label",
    "paths"
  ],
  "type": "object"
}
```

## MediaHealthRootKind


```json
{
  "description": "Kind of search location",
  "enum": [
    "managed",
    "library",
    "recovery"
  ],
  "type": "string"
}
```

## MediaHealthRootsResponseDto

Related models: [MediaHealthRootDto](models-16.md#mediahealthrootdto).

```json
{
  "properties": {
    "roots": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthRootDto"
      },
      "type": "array"
    }
  },
  "required": [
    "roots"
  ],
  "type": "object"
}
```

## MediaHealthRunResponseDto

Related models: [MediaHealthCategory](models-16.md#mediahealthcategory).

```json
{
  "properties": {
    "category": {
      "$ref": "#/components/schemas/MediaHealthCategory"
    },
    "checkedAssets": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "finishedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "foundAssets": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "id": {
      "description": "Media health run ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "startedAt": {
      "format": "date-time",
      "type": "string"
    },
    "status": {
      "description": "Run status",
      "type": "string"
    },
    "totalAssets": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "category",
    "checkedAssets",
    "error",
    "finishedAt",
    "foundAssets",
    "id",
    "startedAt",
    "status",
    "totalAssets"
  ],
  "type": "object"
}
```

## MediaHealthRunsDto

Related models: [MediaHealthRunResponseDto](models-16.md#mediahealthrunresponsedto).

```json
{
  "properties": {
    "corrupt": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthRunResponseDto"
        }
      ],
      "nullable": true
    },
    "missing": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthRunResponseDto"
        }
      ],
      "nullable": true
    }
  },
  "required": [
    "corrupt",
    "missing"
  ],
  "type": "object"
}
```

## MediaHealthScanResponseDto


```json
{
  "properties": {
    "operationId": {
      "description": "The durable job doing the work, in Activity",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "runId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "runId"
  ],
  "type": "object"
}
```

## MediaHealthSeverity


```json
{
  "description": "Media health severity",
  "enum": [
    "info",
    "warning",
    "critical"
  ],
  "type": "string"
}
```

## MediaHealthStatus


```json
{
  "description": "Media health status",
  "enum": [
    "found",
    "missing",
    "candidate",
    "relinked",
    "dismissed",
    "resolved",
    "unsupported_raw",
    "corrupt_suspect",
    "corrupt_confirmed",
    "trash_queued",
    "trashed",
    "delete_queued",
    "deleted"
  ],
  "type": "string"
}
```

## MediaHealthSummaryResponseDto

Related models: [MediaHealthActivityDto](models-16.md#mediahealthactivitydto), [MediaHealthCareSettingsDto](models-16.md#mediahealthcaresettingsdto), [MediaHealthOperationDto](models-16.md#mediahealthoperationdto), [MediaHealthQueuesDto](models-16.md#mediahealthqueuesdto), [MediaHealthRunsDto](models-16.md#mediahealthrunsdto).

```json
{
  "properties": {
    "care": {
      "$ref": "#/components/schemas/MediaHealthCareSettingsDto"
    },
    "operation": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthOperationDto"
        }
      ],
      "nullable": true
    },
    "queues": {
      "$ref": "#/components/schemas/MediaHealthQueuesDto"
    },
    "recent": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthActivityDto"
      },
      "type": "array"
    },
    "recoveryAvailable": {
      "description": "At least one recovery location is configured for this reader",
      "type": "boolean"
    },
    "runs": {
      "$ref": "#/components/schemas/MediaHealthRunsDto"
    }
  },
  "required": [
    "care",
    "operation",
    "queues",
    "recent",
    "recoveryAvailable",
    "runs"
  ],
  "type": "object"
}
```

## MediaOperationAggregateDto

Related models: [MediaOperationDestination](models-16.md#mediaoperationdestination), [MediaOperationKind](models-17.md#mediaoperationkind), [MediaOperationStatus](models-17.md#mediaoperationstatus).

```json
{
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "destination": {
      "$ref": "#/components/schemas/MediaOperationDestination"
    },
    "kind": {
      "$ref": "#/components/schemas/MediaOperationKind"
    },
    "oldestCreatedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    }
  },
  "required": [
    "count",
    "destination",
    "kind",
    "oldestCreatedAt",
    "status"
  ],
  "type": "object"
}
```

## MediaOperationBulkAction


```json
{
  "description": "Bulk action a durable media operation applies",
  "enum": [
    "favorite",
    "unfavorite",
    "archive",
    "unarchive",
    "add-to-album",
    "remove-from-album",
    "tag",
    "untag",
    "change-date",
    "change-description",
    "change-location",
    "mark-sensitive",
    "unmark-sensitive",
    "delete",
    "delete-permanently",
    "restore",
    "stack",
    "unstack",
    "refresh-thumbnails",
    "refresh-metadata",
    "refresh-encoded",
    "refresh-faces",
    "relink-live-photo",
    "resolve-duplicates",
    "undo-duplicates",
    "relink-missing-media",
    "recover-damaged-media",
    "trash-damaged-media",
    "apply-classification-rule"
  ],
  "type": "string"
}
```

## MediaOperationBulkCreateDto

Related models: [MediaOperationBulkAction](models-16.md#mediaoperationbulkaction), [MediaOperationBulkPayloadDto](models-16.md#mediaoperationbulkpayloaddto).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MediaOperationBulkAction"
    },
    "assetIds": {
      "description": "The frozen matching set, in order",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "minItems": 1,
      "type": "array"
    },
    "payload": {
      "$ref": "#/components/schemas/MediaOperationBulkPayloadDto"
    },
    "requestId": {
      "description": "Client idempotency key; submitting the same key again returns the existing operation",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "scope": {
      "additionalProperties": {},
      "description": "A record of the view the set came from; never re-resolved",
      "type": "object"
    },
    "submittedTotal": {
      "description": "The count shown to the person at submit",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "truncated": {
      "description": "The client could not resolve the whole matching set",
      "type": "boolean"
    }
  },
  "required": [
    "action",
    "assetIds"
  ],
  "type": "object"
}
```

## MediaOperationBulkItemDto

Related models: [MediaOperationItemStatus](models-17.md#mediaoperationitemstatus).

```json
{
  "properties": {
    "id": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "message": {
      "description": "Operator detail from the server",
      "nullable": true,
      "type": "string"
    },
    "reasonKey": {
      "description": "Stable key the client turns into a message",
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationItemStatus"
    }
  },
  "required": [
    "id",
    "message",
    "reasonKey",
    "status"
  ],
  "type": "object"
}
```

## MediaOperationBulkPayloadDto

Related models: [MediaOperationDuplicateGroupDto](models-17.md#mediaoperationduplicategroupdto), [MediaOperationLivePhotoPairDto](models-17.md#mediaoperationlivephotopairdto), [MediaOperationMediaHealthEntryDto](models-17.md#mediaoperationmediahealthentrydto).

```json
{
  "properties": {
    "albumId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "classificationRuleId": {
      "description": "For `apply-classification-rule`: the rule to apply to the items (FL-60)",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "dateMode": {
      "enum": [
        "set",
        "shift"
      ],
      "type": "string"
    },
    "dateTimeOriginal": {
      "type": "string"
    },
    "description": {
      "maxLength": 10000,
      "type": "string"
    },
    "duplicateGroups": {
      "description": "Duplicate review decisions, one complete group each (FL-61)",
      "items": {
        "$ref": "#/components/schemas/MediaOperationDuplicateGroupDto"
      },
      "maxItems": 5000,
      "type": "array"
    },
    "latitude": {
      "format": "double",
      "maximum": 90,
      "minimum": -90,
      "type": "number"
    },
    "longitude": {
      "format": "double",
      "maximum": 180,
      "minimum": -180,
      "type": "number"
    },
    "mediaHealth": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationMediaHealthEntryDto"
      },
      "maxItems": 1000,
      "type": "array"
    },
    "minutes": {
      "description": "Relative shift in minutes, for `dateMode: shift`",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "pairs": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationLivePhotoPairDto"
      },
      "maxItems": 50000,
      "type": "array"
    },
    "primaryId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "stackIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "type": "array"
    },
    "tagIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50,
      "type": "array"
    },
    "timeZone": {
      "type": "string"
    }
  },
  "type": "object"
}
```

## MediaOperationBulkSummaryDto

Related models: [MediaOperationBulkAction](models-16.md#mediaoperationbulkaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MediaOperationBulkAction"
    },
    "failed": {
      "description": "Items the server attempted and could not apply; a retry covers these",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "itemsTruncated": {
      "type": "boolean"
    },
    "requested": {
      "description": "Items in the frozen set",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "retried": {
      "description": "Items that failed and were given their one automatic retry",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "skipped": {
      "description": "Items refused before anything changed, e.g. no access",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "snapshotTruncated": {
      "type": "boolean"
    },
    "succeeded": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "action",
    "failed",
    "itemsTruncated",
    "requested",
    "retried",
    "skipped",
    "snapshotTruncated",
    "succeeded"
  ],
  "type": "object"
}
```

## MediaOperationCheckpointDto

Related models: [MediaOperationCheckpointState](models-16.md#mediaoperationcheckpointstate).

```json
{
  "properties": {
    "chunkKey": {
      "description": "Digest over every input to this chunk; the reuse key",
      "type": "string"
    },
    "completedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "endTicks": {
      "description": "Chunk end, in ticks of the timebase",
      "type": "string"
    },
    "id": {
      "description": "Checkpoint ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "requiresSequentialContext": {
      "description": "A render may not start inside this chunk",
      "type": "boolean"
    },
    "sequence": {
      "description": "Chunk order within the render",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "sizeInBytes": {
      "nullable": true,
      "type": "string"
    },
    "startTicks": {
      "description": "Chunk start, in ticks of the timebase",
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/MediaOperationCheckpointState"
    },
    "timebase": {
      "description": "Rational timebase for the tick range, e.g. 30000/1001",
      "type": "string"
    }
  },
  "required": [
    "chunkKey",
    "completedAt",
    "endTicks",
    "id",
    "requiresSequentialContext",
    "sequence",
    "sizeInBytes",
    "startTicks",
    "state",
    "timebase"
  ],
  "type": "object"
}
```

## MediaOperationCheckpointState


```json
{
  "description": "Media operation checkpoint state",
  "enum": [
    "pending",
    "complete",
    "invalid"
  ],
  "type": "string"
}
```

## MediaOperationDestination


```json
{
  "description": "Media operation destination",
  "enum": [
    "local",
    "lan",
    "frameleaf-cloud"
  ],
  "type": "string"
}
```
