# Server API models 32

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## StudioBundleOperationDto

Related models: [MediaOperationKind](models-15.md#mediaoperationkind), [MediaOperationStatus](models-15.md#mediaoperationstatus), [StudioBundleExportResultDto](models-31.md#studiobundleexportresultdto), [StudioBundleImportResultDto](models-31.md#studiobundleimportresultdto).

```json
{
  "properties": {
    "attempt": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "autoRetries": {
      "description": "Automatic retries this job has used; every job gets one before a failure is reported",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "errorCode": {
      "nullable": true,
      "type": "string"
    },
    "export": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioBundleExportResultDto"
        }
      ],
      "nullable": true
    },
    "import": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioBundleImportResultDto"
        }
      ],
      "nullable": true
    },
    "kind": {
      "$ref": "#/components/schemas/MediaOperationKind"
    },
    "maxAttempts": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "progress": {
      "format": "double",
      "type": "number"
    },
    "projectId": {
      "description": "The exported project, or the project an import created",
      "nullable": true,
      "type": "string"
    },
    "retryAt": {
      "description": "When a job waiting for its automatic retry may run again",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    }
  },
  "required": [
    "attempt",
    "autoRetries",
    "error",
    "errorCode",
    "export",
    "import",
    "kind",
    "maxAttempts",
    "operationId",
    "progress",
    "projectId",
    "retryAt",
    "status"
  ],
  "type": "object"
}
```

## StudioBundleSourceDto

Related models: [StudioBundleSourceMode](models-32.md#studiobundlesourcemode), [StudioBundleSourceResolution](models-32.md#studiobundlesourceresolution).

```json
{
  "properties": {
    "contentType": {
      "nullable": true,
      "type": "string"
    },
    "fileName": {
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Identifier on the exporting server",
      "type": "string"
    },
    "key": {
      "description": "Mapping key for the import request",
      "type": "string"
    },
    "kind": {
      "description": "`library-asset`, `edited-master` or `project-import` (a file kept with the project)",
      "type": "string"
    },
    "mode": {
      "$ref": "#/components/schemas/StudioBundleSourceMode"
    },
    "resolution": {
      "$ref": "#/components/schemas/StudioBundleSourceResolution"
    },
    "sizeBytes": {
      "description": "Size of the source file, when the exporting server knew it",
      "nullable": true,
      "type": "string"
    },
    "suggestedAssetId": {
      "description": "An asset of yours with the same content",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "contentType",
    "fileName",
    "id",
    "key",
    "kind",
    "mode",
    "resolution",
    "sizeBytes",
    "suggestedAssetId"
  ],
  "type": "object"
}
```

## StudioBundleSourceMode


```json
{
  "description": "`embedded` carries a verified copy; `reference` names media on the exporting server",
  "enum": [
    "embedded",
    "reference"
  ],
  "type": "string"
}
```

## StudioBundleSourceResolution


```json
{
  "description": "`kept`: the original is already available to you; `suggested`: an item of yours has the same content; `missing`: choose one or import without it",
  "enum": [
    "kept",
    "suggested",
    "missing"
  ],
  "type": "string"
}
```

## StudioBundleUploadCreateDto


```json
{
  "properties": {
    "file": {
      "description": "A `.frameleaf-studio.zip` bundle",
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

## StudioBundleUploadDto

Related models: [StudioBundleSourceDto](models-32.md#studiobundlesourcedto).

```json
{
  "properties": {
    "consumedAt": {
      "description": "When an import first read it",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "digest": {
      "description": "SHA-256 of the whole file",
      "type": "string"
    },
    "engineRevision": {
      "type": "string"
    },
    "expiresAt": {
      "description": "When the upload is discarded",
      "format": "date-time",
      "type": "string"
    },
    "exportedAt": {
      "format": "date-time",
      "type": "string"
    },
    "fileName": {
      "description": "The file name as uploaded",
      "type": "string"
    },
    "id": {
      "description": "Upload ID, used to start an import",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "producerVersion": {
      "type": "string"
    },
    "projectName": {
      "type": "string"
    },
    "revision": {
      "description": "The revision the bundle was made from",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "sizeBytes": {
      "type": "string"
    },
    "sources": {
      "items": {
        "$ref": "#/components/schemas/StudioBundleSourceDto"
      },
      "type": "array"
    }
  },
  "required": [
    "consumedAt",
    "digest",
    "engineRevision",
    "expiresAt",
    "exportedAt",
    "fileName",
    "id",
    "producerVersion",
    "projectName",
    "revision",
    "sizeBytes",
    "sources"
  ],
  "type": "object"
}
```

## StudioCapabilitiesDto

Related models: [StudioRenderEvidenceDto](models-33.md#studiorenderevidencedto).

```json
{
  "properties": {
    "gpuWorker": {
      "description": "False until the Studio render worker admission (FL-95, FL-104) reports one",
      "type": "boolean"
    },
    "render": {
      "description": "FL-42: per destination, what qualified render sessions verified (memory, codecs, colour precision)",
      "items": {
        "$ref": "#/components/schemas/StudioRenderEvidenceDto"
      },
      "type": "array"
    },
    "renderWorker": {
      "description": "False until the Studio render worker admission (FL-95, FL-104) reports one",
      "type": "boolean"
    },
    "restorationWorker": {
      "description": "A destination can serve a restoration workload right now",
      "type": "boolean"
    },
    "transcriptionWorker": {
      "description": "A destination can serve the Studio AI workload right now",
      "type": "boolean"
    }
  },
  "required": [
    "gpuWorker",
    "render",
    "renderWorker",
    "restorationWorker",
    "transcriptionWorker"
  ],
  "type": "object"
}
```

## StudioCommandEnvelopeDto


```json
{
  "properties": {
    "id": {
      "description": "Published command id (studio/frameleaf-studio-commands.json)",
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    },
    "idempotencyKey": {
      "maxLength": 128,
      "minLength": 1,
      "type": "string"
    },
    "issuedAt": {
      "description": "Epoch milliseconds",
      "format": "double",
      "type": "number"
    },
    "payload": {
      "additionalProperties": {},
      "description": "Command payload; graph-shaped values pass through unread",
      "type": "object"
    },
    "revision": {
      "description": "The head revision the command was issued against",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "id",
    "idempotencyKey",
    "issuedAt",
    "payload",
    "revision"
  ],
  "type": "object"
}
```

## StudioCommandSummaryDto


```json
{
  "properties": {
    "counts": {
      "additionalProperties": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "description": "Command id to how many times it appeared",
      "type": "object"
    },
    "total": {
      "description": "Commands in the batch",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "counts",
    "total"
  ],
  "type": "object"
}
```

## StudioCommentCreateDto

Related models: [StudioTimeDto](models-33.md#studiotimedto).

```json
{
  "properties": {
    "requestKey": {
      "description": "Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "revision": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "text": {
      "maxLength": 2000,
      "minLength": 1,
      "type": "string"
    },
    "time": {
      "$ref": "#/components/schemas/StudioTimeDto"
    }
  },
  "required": [
    "revision",
    "text",
    "time"
  ],
  "type": "object"
}
```

## StudioCommentDto

Related models: [StudioTimeDto](models-33.md#studiotimedto).

```json
{
  "properties": {
    "authorId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
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
    "projectId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "resolvedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "resolvedById": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "revision": {
      "description": "The revision the reviewer was looking at",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "text": {
      "type": "string"
    },
    "time": {
      "$ref": "#/components/schemas/StudioTimeDto"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "authorId",
    "createdAt",
    "id",
    "projectId",
    "resolvedAt",
    "resolvedById",
    "revision",
    "text",
    "time",
    "updatedAt"
  ],
  "type": "object"
}
```

## StudioCommentListResponseDto

Related models: [StudioCommentDto](models-32.md#studiocommentdto).

```json
{
  "properties": {
    "items": {
      "description": "Oldest first",
      "items": {
        "$ref": "#/components/schemas/StudioCommentDto"
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

## StudioCommentUpdateDto


```json
{
  "properties": {
    "resolved": {
      "type": "boolean"
    },
    "text": {
      "maxLength": 2000,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

## StudioExportAudio


```json
{
  "description": "Audio of the result: `preserve` keeps the widest source channel layout at its sample rate; `stereo` is an explicit downmix",
  "enum": [
    "preserve",
    "stereo"
  ],
  "type": "string"
}
```

## StudioExportColor


```json
{
  "description": "Colour handling; Dolby Vision needs a qualified worker",
  "enum": [
    "preserve",
    "hdr10",
    "dolby-vision"
  ],
  "type": "string"
}
```

## StudioExportCreateDto

Related models: [MediaOperationDestination](models-15.md#mediaoperationdestination), [StudioExportAudio](models-32.md#studioexportaudio), [StudioExportColor](models-32.md#studioexportcolor), [StudioExportFormat](models-32.md#studioexportformat), [StudioExportMastering](models-32.md#studioexportmastering), [StudioExportQuality](models-32.md#studioexportquality), [StudioExportRangeDto](models-32.md#studioexportrangedto), [StudioExportResolution](models-32.md#studioexportresolution), [StudioExportSmoothMotionDto](models-32.md#studioexportsmoothmotiondto), [StudioExportSubtitleMode](models-32.md#studioexportsubtitlemode).

```json
{
  "properties": {
    "audio": {
      "$ref": "#/components/schemas/StudioExportAudio",
      "description": "Defaults to `preserve`; a stereo downmix happens only when asked for"
    },
    "cloudConsent": {
      "description": "You agree to the media leaving your network for this export",
      "type": "boolean"
    },
    "color": {
      "$ref": "#/components/schemas/StudioExportColor"
    },
    "destination": {
      "$ref": "#/components/schemas/MediaOperationDestination",
      "description": "Where it renders. A cloud destination needs `cloudConsent`"
    },
    "expectedRevision": {
      "description": "The revision you are looking at; a newer head refuses the export with `409` instead of rendering it",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "format": {
      "$ref": "#/components/schemas/StudioExportFormat"
    },
    "mastering": {
      "$ref": "#/components/schemas/StudioExportMastering",
      "description": "Explicit mastering display used for PQ output; required for HDR10 or preserved PQ. Never inferred from source metadata or preview defaults"
    },
    "quality": {
      "$ref": "#/components/schemas/StudioExportQuality",
      "description": "Defaults to `high`"
    },
    "range": {
      "$ref": "#/components/schemas/StudioExportRangeDto",
      "description": "Absent renders the whole main timeline"
    },
    "requestKey": {
      "description": "Idempotency key; a repeated submit answers with the first export",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "resolution": {
      "$ref": "#/components/schemas/StudioExportResolution"
    },
    "smoothMotion": {
      "$ref": "#/components/schemas/StudioExportSmoothMotionDto"
    },
    "subtitleMode": {
      "$ref": "#/components/schemas/StudioExportSubtitleMode",
      "description": "Defaults to `burn`"
    }
  },
  "required": [
    "color",
    "destination",
    "format",
    "resolution"
  ],
  "type": "object"
}
```

## StudioExportCreateResponseDto

Related models: [MediaOperationDto](models-15.md#mediaoperationdto), [StudioExportVersionDto](models-32.md#studioexportversiondto).

```json
{
  "properties": {
    "operation": {
      "$ref": "#/components/schemas/MediaOperationDto",
      "description": "The render job; follow it in Activity"
    },
    "version": {
      "$ref": "#/components/schemas/StudioExportVersionDto"
    }
  },
  "required": [
    "operation",
    "version"
  ],
  "type": "object"
}
```

## StudioExportFormat


```json
{
  "description": "Container and codec",
  "enum": [
    "mp4-hevc-main10",
    "mp4-h264",
    "webm-av1",
    "prores-422-hq"
  ],
  "type": "string"
}
```

## StudioExportListResponseDto

Related models: [StudioExportVersionDto](models-32.md#studioexportversiondto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/StudioExportVersionDto"
      },
      "type": "array"
    },
    "total": {
      "description": "Matching versions, before paging",
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

## StudioExportMastering


```json
{
  "additionalProperties": false,
  "properties": {
    "maxNits": {
      "exclusiveMinimum": true,
      "format": "double",
      "maximum": 10000,
      "minimum": 0,
      "multipleOf": 0.0001,
      "type": "number"
    },
    "minNits": {
      "format": "double",
      "maximum": 10000,
      "minimum": 0,
      "multipleOf": 0.0001,
      "type": "number"
    },
    "primaries": {
      "description": "Declared BT.2020 mastering display primaries and D65 white point",
      "enum": [
        "bt2020"
      ],
      "type": "string"
    }
  },
  "required": [
    "maxNits",
    "minNits",
    "primaries"
  ],
  "type": "object"
}
```

## StudioExportQuality


```json
{
  "description": "Encoder quality preset",
  "enum": [
    "low",
    "medium",
    "high",
    "ultra"
  ],
  "type": "string"
}
```

## StudioExportRangeDto


```json
{
  "additionalProperties": false,
  "properties": {
    "inPoint": {
      "description": "First included frame on the main timeline",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "outPoint": {
      "description": "First excluded frame on the main timeline",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "inPoint",
    "outPoint"
  ],
  "type": "object"
}
```

## StudioExportRemoteReason


```json
{
  "description": "Why a remote destination is asked to drop Studio export data",
  "enum": [
    "cancel",
    "delete"
  ],
  "type": "string"
}
```

## StudioExportResolution


```json
{
  "description": "Output resolution",
  "enum": [
    "720p",
    "1080p",
    "1440p",
    "2160p"
  ],
  "type": "string"
}
```

## StudioExportScope


```json
{
  "description": "Where a published Studio export lives",
  "enum": [
    "library",
    "project"
  ],
  "type": "string"
}
```

## StudioExportSettingsDto

Related models: [StudioExportAudio](models-32.md#studioexportaudio), [StudioExportColor](models-32.md#studioexportcolor), [StudioExportFormat](models-32.md#studioexportformat), [StudioExportMastering](models-32.md#studioexportmastering), [StudioExportQuality](models-32.md#studioexportquality), [StudioExportRangeDto](models-32.md#studioexportrangedto), [StudioExportResolution](models-32.md#studioexportresolution), [StudioExportSubtitleMode](models-32.md#studioexportsubtitlemode).

```json
{
  "properties": {
    "audio": {
      "$ref": "#/components/schemas/StudioExportAudio",
      "description": "Absent on exports made before audio was a choice"
    },
    "color": {
      "$ref": "#/components/schemas/StudioExportColor"
    },
    "format": {
      "$ref": "#/components/schemas/StudioExportFormat"
    },
    "mastering": {
      "$ref": "#/components/schemas/StudioExportMastering",
      "description": "Declared PQ mastering display, fixed when this export was submitted"
    },
    "quality": {
      "$ref": "#/components/schemas/StudioExportQuality",
      "description": "Absent on exports made before quality was a choice"
    },
    "range": {
      "$ref": "#/components/schemas/StudioExportRangeDto",
      "description": "Absent renders the whole main timeline"
    },
    "resolution": {
      "$ref": "#/components/schemas/StudioExportResolution"
    },
    "subtitleMode": {
      "$ref": "#/components/schemas/StudioExportSubtitleMode",
      "description": "Absent uses the native `burn` default"
    }
  },
  "required": [
    "color",
    "format",
    "resolution"
  ],
  "type": "object"
}
```

## StudioExportSmoothMotionDto


```json
{
  "description": "FL-162: Smooth motion of the exported video as its own job after it is published. The export itself always renders at home; a Frameleaf Cloud job is confirmed and billed on its own.",
  "properties": {
    "destinationId": {
      "description": "Where the Smooth motion job runs; Frameleaf Cloud is confirmed separately",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "factor": {
      "anyOf": [
        {
          "type": "number",
          "format": "double",
          "enum": [
            2
          ]
        },
        {
          "type": "number",
          "format": "double",
          "enum": [
            4
          ]
        },
        {
          "type": "number",
          "format": "double",
          "enum": [
            8
          ]
        }
      ],
      "description": "How many frames each frame becomes"
    }
  },
  "required": [
    "destinationId",
    "factor"
  ],
  "type": "object"
}
```

## StudioExportSubtitleMode


```json
{
  "description": "Burn subtitle captions into the picture or omit them; ordinary titles are preserved",
  "enum": [
    "burn",
    "off"
  ],
  "type": "string"
}
```

## StudioExportVersionDto

Related models: [MediaOperationDestination](models-15.md#mediaoperationdestination), [StudioExportScope](models-32.md#studioexportscope), [StudioExportSettingsDto](models-32.md#studioexportsettingsdto), [StudioExportVersionState](models-32.md#studioexportversionstate).

```json
{
  "properties": {
    "cancelledAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "contentType": {
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "destination": {
      "$ref": "#/components/schemas/MediaOperationDestination"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "errorCode": {
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Export version ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "includesSharedSources": {
      "description": "At least one source is shared with you rather than yours",
      "type": "boolean"
    },
    "locked": {
      "description": "The result inherited a lock from a Locked or sensitive source",
      "type": "boolean"
    },
    "projectId": {
      "description": "Null once the project was deleted for good",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "publishOperationId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "publishedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "renderOperationId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "resultAssetId": {
      "description": "The asset a `library` result became",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "revision": {
      "description": "The project revision that was rendered",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "scope": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioExportScope"
        }
      ],
      "description": "Where the published result lives",
      "nullable": true
    },
    "sensitive": {
      "description": "The result inherited sensitive evidence from a source",
      "type": "boolean"
    },
    "settings": {
      "$ref": "#/components/schemas/StudioExportSettingsDto"
    },
    "sizeInBytes": {
      "nullable": true,
      "type": "string"
    },
    "sourceCount": {
      "description": "Library sources the result was made from",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "state": {
      "$ref": "#/components/schemas/StudioExportVersionState"
    },
    "version": {
      "description": "The version number, once published",
      "maximum": 9007199254740991,
      "minimum": 1,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "cancelledAt",
    "contentType",
    "createdAt",
    "destination",
    "error",
    "errorCode",
    "id",
    "includesSharedSources",
    "locked",
    "projectId",
    "publishOperationId",
    "publishedAt",
    "renderOperationId",
    "resultAssetId",
    "revision",
    "scope",
    "sensitive",
    "settings",
    "sizeInBytes",
    "sourceCount",
    "state",
    "version"
  ],
  "type": "object"
}
```

## StudioExportVersionState


```json
{
  "description": "Studio export version state",
  "enum": [
    "rendering",
    "staged",
    "published",
    "failed",
    "cancelled"
  ],
  "type": "string"
}
```

## StudioPreviewDto

Related models: [StudioPreviewQuality](models-32.md#studiopreviewquality), [StudioPreviewStatus](models-32.md#studiopreviewstatus), [StudioPreviewTimeDto](models-32.md#studiopreviewtimedto).

```json
{
  "properties": {
    "admissionReleased": {
      "description": "Delivery was durably fenced; does not establish renderer termination",
      "type": "boolean"
    },
    "cancellationState": {
      "enum": [
        "not-needed",
        "requested",
        "acknowledged",
        "unavailable"
      ],
      "type": "string"
    },
    "consumerRequestId": {
      "description": "Captured opt-in consumer admission identity",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "contentType": {
      "nullable": true,
      "type": "string"
    },
    "errorCode": {
      "description": "Stable code the client turns into a message",
      "nullable": true,
      "type": "string"
    },
    "etag": {
      "description": "Revision-bound entity tag for the frame endpoint",
      "type": "string"
    },
    "expiresAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "framePts": {
      "nullable": true,
      "type": "string"
    },
    "framePtsTimebase": {
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Preview frame ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "operationId": {
      "description": "The durable job rendering this frame, when one has been created",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "quality": {
      "$ref": "#/components/schemas/StudioPreviewQuality"
    },
    "readyAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "rendererReleased": {
      "description": "True only after the captured operation acknowledged cancellation with resources released",
      "nullable": true,
      "type": "boolean"
    },
    "requestedAt": {
      "format": "date-time",
      "type": "string"
    },
    "revision": {
      "description": "The stored project revision this frame was rendered for",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "revisionDigest": {
      "description": "Digest of the authorized resolution the frame is bound to; changes with the revision and whenever access is re-resolved",
      "type": "string"
    },
    "seekGeneration": {
      "description": "The seek this frame answers",
      "type": "string"
    },
    "sizeInBytes": {
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/StudioPreviewStatus"
    },
    "time": {
      "$ref": "#/components/schemas/StudioPreviewTimeDto"
    },
    "toneMapped": {
      "description": "The frame is an explicitly tone-mapped SDR rendering; never the colour authority",
      "type": "boolean"
    },
    "viewportHeight": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "viewportWidth": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "contentType",
    "errorCode",
    "etag",
    "expiresAt",
    "framePts",
    "framePtsTimebase",
    "id",
    "operationId",
    "projectId",
    "quality",
    "readyAt",
    "requestedAt",
    "revision",
    "revisionDigest",
    "seekGeneration",
    "sizeInBytes",
    "status",
    "time",
    "toneMapped",
    "viewportHeight",
    "viewportWidth"
  ],
  "type": "object"
}
```

## StudioPreviewQuality


```json
{
  "description": "Studio preview quality",
  "enum": [
    "draft",
    "standard",
    "full"
  ],
  "type": "string"
}
```

## StudioPreviewRequestDto

Related models: [StudioPreviewQuality](models-32.md#studiopreviewquality), [StudioPreviewTimeDto](models-32.md#studiopreviewtimedto).

```json
{
  "properties": {
    "consumerRequestId": {
      "description": "Opt in to a session-isolated admission; use a fresh UUID for each logical request",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "projectId": {
      "description": "Studio project the frame belongs to",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "quality": {
      "$ref": "#/components/schemas/StudioPreviewQuality"
    },
    "revision": {
      "description": "Stored project revision the frame is bound to; a superseded revision is refused",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "seekGeneration": {
      "default": 0,
      "description": "The client's monotonic seek counter, echoed back on the result",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "time": {
      "$ref": "#/components/schemas/StudioPreviewTimeDto"
    },
    "viewportHeight": {
      "maximum": 7680,
      "minimum": 16,
      "type": "integer"
    },
    "viewportWidth": {
      "maximum": 7680,
      "minimum": 16,
      "type": "integer"
    }
  },
  "required": [
    "projectId",
    "quality",
    "revision",
    "time",
    "viewportHeight",
    "viewportWidth"
  ],
  "type": "object"
}
```

## StudioPreviewResponseDto

Related models: [StudioPreviewDto](models-32.md#studiopreviewdto).

```json
{
  "properties": {
    "currentRevision": {
      "description": "The stored revision the project is on now",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "preview": {
      "$ref": "#/components/schemas/StudioPreviewDto"
    },
    "supersededPreviewIds": {
      "description": "Previews cancelled because the revision advanced",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "currentRevision",
    "preview",
    "supersededPreviewIds"
  ],
  "type": "object"
}
```

## StudioPreviewStatus


```json
{
  "description": "Studio preview status",
  "enum": [
    "pending",
    "rendering",
    "ready",
    "superseded",
    "failed",
    "evicted"
  ],
  "type": "string"
}
```

## StudioPreviewStreamAnswerDto


```json
{
  "properties": {
    "negotiation": {
      "description": "The round this answer answers",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "sdp": {
      "description": "A complete session description (SDP)",
      "maxLength": 65536,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "negotiation",
    "sdp"
  ],
  "type": "object"
}
```

## StudioPreviewStreamBoundsDto


```json
{
  "properties": {
    "maxBitrateKbps": {
      "description": "Bitrate the worker may not exceed; the server writes it into the relayed answer",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxDurationSeconds": {
      "description": "The session closes after this long; playing on opens a new one",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxFrameRate": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxHeight": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxWidth": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "maxBitrateKbps",
    "maxDurationSeconds",
    "maxFrameRate",
    "maxHeight",
    "maxWidth"
  ],
  "type": "object"
}
```

## StudioPreviewStreamCloseReason


```json
{
  "description": "Why a closed session closed",
  "enum": [
    "closed",
    "superseded",
    "revoked",
    "stale-revision",
    "expired",
    "worker-lost",
    "failed"
  ],
  "type": "string"
}
```

## StudioPreviewStreamDto

Related models: [StudioPreviewStreamBoundsDto](models-32.md#studiopreviewstreamboundsdto), [StudioPreviewStreamCloseReason](models-32.md#studiopreviewstreamclosereason), [StudioPreviewStreamState](models-32.md#studiopreviewstreamstate), [StudioPreviewTimeDto](models-32.md#studiopreviewtimedto).

```json
{
  "properties": {
    "bounds": {
      "$ref": "#/components/schemas/StudioPreviewStreamBoundsDto"
    },
    "closeReason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioPreviewStreamCloseReason"
        }
      ],
      "nullable": true
    },
    "currentRevision": {
      "description": "The stored head, when the session closed as stale",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "expiresAt": {
      "description": "The hard end of this session",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Stream session ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "keepaliveMs": {
      "description": "Poll at least this often, or the session is closed",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "negotiation": {
      "description": "The offer/answer round; an answer must name it",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "offer": {
      "description": "The worker's offer for this round, while it waits for an answer",
      "maxLength": 65536,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "projectId": {
      "type": "string"
    },
    "revision": {
      "description": "The stored project revision this session plays",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "start": {
      "$ref": "#/components/schemas/StudioPreviewTimeDto",
      "description": "Where playback starts"
    },
    "state": {
      "$ref": "#/components/schemas/StudioPreviewStreamState"
    }
  },
  "required": [
    "bounds",
    "closeReason",
    "currentRevision",
    "expiresAt",
    "id",
    "keepaliveMs",
    "negotiation",
    "offer",
    "projectId",
    "revision",
    "start",
    "state"
  ],
  "type": "object"
}
```

## StudioPreviewStreamOpenDto

Related models: [StudioPreviewQuality](models-32.md#studiopreviewquality), [StudioPreviewTimeDto](models-32.md#studiopreviewtimedto).

```json
{
  "properties": {
    "projectId": {
      "description": "Studio project to play",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "quality": {
      "$ref": "#/components/schemas/StudioPreviewQuality"
    },
    "revision": {
      "description": "Stored project revision to play; a superseded revision is refused",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "time": {
      "$ref": "#/components/schemas/StudioPreviewTimeDto"
    },
    "viewportHeight": {
      "maximum": 7680,
      "minimum": 16,
      "type": "integer"
    },
    "viewportWidth": {
      "maximum": 7680,
      "minimum": 16,
      "type": "integer"
    }
  },
  "required": [
    "projectId",
    "quality",
    "revision",
    "time",
    "viewportHeight",
    "viewportWidth"
  ],
  "type": "object"
}
```

## StudioPreviewStreamState


```json
{
  "description": "Where the session is",
  "enum": [
    "queued",
    "negotiating",
    "offered",
    "answered",
    "closed"
  ],
  "type": "string"
}
```

## StudioPreviewTimeDto


```json
{
  "properties": {
    "denominator": {
      "description": "Time denominator; must be positive",
      "pattern": "^-?\\d{1,16}$",
      "type": "string"
    },
    "numerator": {
      "description": "Time numerator, in seconds over the denominator",
      "pattern": "^-?\\d{1,16}$",
      "type": "string"
    }
  },
  "required": [
    "denominator",
    "numerator"
  ],
  "type": "object"
}
```

## StudioProjectAccess


```json
{
  "description": "`owner` may write; `reviewer` reaches the project through a shared space, read-only",
  "enum": [
    "owner",
    "reviewer"
  ],
  "type": "string"
}
```

## StudioProjectCreateDto

Related models: [StudioProjectEnvelopeDto](models-32.md#studioprojectenvelopedto).

```json
{
  "properties": {
    "clientId": {
      "description": "This editor instance; it receives the lease",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "envelope": {
      "$ref": "#/components/schemas/StudioProjectEnvelopeDto",
      "description": "An initial document, saved as revision 1"
    },
    "name": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "requestKey": {
      "description": "Owner-scoped idempotency key for project creation; reuse requires the same payload",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "spaceId": {
      "description": "Share the project with a shared space for review",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "clientId",
    "name"
  ],
  "type": "object"
}
```

## StudioProjectDetailDto

Related models: [StudioProjectAccess](models-32.md#studioprojectaccess), [StudioProjectEnvelopeDto](models-32.md#studioprojectenvelopedto), [StudioProjectLeaseDto](models-33.md#studioprojectleasedto), [StudioProjectResourcesDto](models-33.md#studioprojectresourcesdto), [StudioProjectShelf](models-33.md#studioprojectshelf).

```json
{
  "properties": {
    "access": {
      "$ref": "#/components/schemas/StudioProjectAccess"
    },
    "archivedAt": {
      "description": "When the owner archived it",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "deletedAt": {
      "description": "When it was moved to the trash",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "digest": {
      "description": "Key-sorted SHA-256 of the head envelope; null when withheld",
      "nullable": true,
      "type": "string"
    },
    "duplicatedFromId": {
      "description": "The project this one was duplicated from; null for a reviewer",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "envelope": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioProjectEnvelopeDto"
        }
      ],
      "nullable": true
    },
    "id": {
      "description": "Studio project ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "importedFromBundle": {
      "description": "The project was read in from a portable bundle; always false for a reviewer",
      "type": "boolean"
    },
    "lastOpenedAt": {
      "description": "When an editor last opened it; null for a reviewer",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "lease": {
      "$ref": "#/components/schemas/StudioProjectLeaseDto"
    },
    "name": {
      "type": "string"
    },
    "ownerId": {
      "description": "The only account that may write",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "purgeAfter": {
      "description": "When a trashed project is deleted for good; its library media is never touched",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "resources": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioProjectResourcesDto"
        }
      ],
      "nullable": true
    },
    "revision": {
      "description": "Head revision number; 0 until the first save",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "shelf": {
      "$ref": "#/components/schemas/StudioProjectShelf"
    },
    "spaceId": {
      "description": "Shared space whose members may review the project",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "thumbnailAssetId": {
      "description": "Library asset the owner chose as the poster; null for a reviewer",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    },
    "withheld": {
      "description": "The graph was withheld because a source is unavailable to you",
      "type": "boolean"
    }
  },
  "required": [
    "access",
    "archivedAt",
    "createdAt",
    "deletedAt",
    "digest",
    "duplicatedFromId",
    "envelope",
    "id",
    "importedFromBundle",
    "lastOpenedAt",
    "lease",
    "name",
    "ownerId",
    "purgeAfter",
    "resources",
    "revision",
    "shelf",
    "spaceId",
    "thumbnailAssetId",
    "updatedAt",
    "withheld"
  ],
  "type": "object"
}
```

## StudioProjectDiffDto

Related models: [StudioCommandSummaryDto](models-32.md#studiocommandsummarydto).

```json
{
  "properties": {
    "added": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "byteDelta": {
      "description": "Size change of the serialized graph",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "changed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "commands": {
      "$ref": "#/components/schemas/StudioCommandSummaryDto",
      "description": "Commands the saves between the two revisions reported"
    },
    "from": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "identical": {
      "description": "The two envelopes have the same digest",
      "type": "boolean"
    },
    "paths": {
      "description": "Changed graph paths, aggregated and capped",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "removed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "to": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "truncated": {
      "description": "More paths changed than are listed",
      "type": "boolean"
    }
  },
  "required": [
    "added",
    "byteDelta",
    "changed",
    "commands",
    "from",
    "identical",
    "paths",
    "removed",
    "to",
    "truncated"
  ],
  "type": "object"
}
```

## StudioProjectDto

Related models: [StudioProjectAccess](models-32.md#studioprojectaccess), [StudioProjectLeaseDto](models-33.md#studioprojectleasedto), [StudioProjectShelf](models-33.md#studioprojectshelf).

```json
{
  "properties": {
    "access": {
      "$ref": "#/components/schemas/StudioProjectAccess"
    },
    "archivedAt": {
      "description": "When the owner archived it",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "deletedAt": {
      "description": "When it was moved to the trash",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "duplicatedFromId": {
      "description": "The project this one was duplicated from; null for a reviewer",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "Studio project ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "importedFromBundle": {
      "description": "The project was read in from a portable bundle; always false for a reviewer",
      "type": "boolean"
    },
    "lastOpenedAt": {
      "description": "When an editor last opened it; null for a reviewer",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "lease": {
      "$ref": "#/components/schemas/StudioProjectLeaseDto"
    },
    "name": {
      "type": "string"
    },
    "ownerId": {
      "description": "The only account that may write",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "purgeAfter": {
      "description": "When a trashed project is deleted for good; its library media is never touched",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "revision": {
      "description": "Head revision number; 0 until the first save",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "shelf": {
      "$ref": "#/components/schemas/StudioProjectShelf"
    },
    "spaceId": {
      "description": "Shared space whose members may review the project",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "thumbnailAssetId": {
      "description": "Library asset the owner chose as the poster; null for a reviewer",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "access",
    "archivedAt",
    "createdAt",
    "deletedAt",
    "duplicatedFromId",
    "id",
    "importedFromBundle",
    "lastOpenedAt",
    "lease",
    "name",
    "ownerId",
    "purgeAfter",
    "revision",
    "shelf",
    "spaceId",
    "thumbnailAssetId",
    "updatedAt"
  ],
  "type": "object"
}
```

## StudioProjectDuplicateDto


```json
{
  "properties": {
    "name": {
      "description": "Name of the copy; the client supplies the translated default",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

## StudioProjectEnvelopeDto


```json
{
  "properties": {
    "engine": {
      "description": "The engine that produced the graph; `freecut`",
      "type": "string"
    },
    "engineRevision": {
      "description": "Pinned engine revision the editor was built from",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "graph": {
      "additionalProperties": {},
      "description": "Opaque engine document, stored and returned byte for byte",
      "type": "object"
    },
    "schemaVersion": {
      "description": "Envelope shape version; the server accepts exactly one",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "engine",
    "engineRevision",
    "graph",
    "schemaVersion"
  ],
  "type": "object"
}
```

## StudioProjectHistoryResponseDto

Related models: [StudioProjectRevisionDto](models-33.md#studioprojectrevisiondto).

```json
{
  "properties": {
    "items": {
      "description": "Newest first",
      "items": {
        "$ref": "#/components/schemas/StudioProjectRevisionDto"
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

## StudioProjectImportCreateDto


```json
{
  "properties": {
    "file": {
      "description": "The file to import",
      "format": "binary",
      "type": "string"
    },
    "id": {
      "description": "The media id the editor gave this file; retrying the same file with it is idempotent",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "file",
    "id"
  ],
  "type": "object"
}
```
