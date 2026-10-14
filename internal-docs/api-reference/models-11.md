# Server API models 11

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## DevelopPresetSettingsUpdateDto

Related models: [AssetDevelopPreset](models-04.md#assetdeveloppreset), [DarktableDevelopRecipe](models-10.md#darktabledeveloprecipe), [DevelopPresetMask](models-10.md#developpresetmask).

```json
{
  "properties": {
    "blacks": {
      "description": "Black point",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "brilliance": {
      "description": "Opens the shadows and holds back the highlights (positive), or the reverse (negative), with a slight colour lift; see the develop recipe protocol",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "clarity": {
      "description": "Local contrast in the midtones",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "contrast": {
      "description": "Contrast around middle grey",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "dehaze": {
      "description": "Haze removal (positive) or addition (negative)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "exposure": {
      "description": "Exposure in EV; each whole stop doubles the light",
      "format": "double",
      "maximum": 2,
      "minimum": -2,
      "type": "number"
    },
    "grain": {
      "description": "Film grain amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "highlights": {
      "description": "Highlight recovery (negative) or lift (positive)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "masks": {
      "description": "Radial and linear selective adjustments, applied in order after the global develop",
      "items": {
        "$ref": "#/components/schemas/DevelopPresetMask"
      },
      "maxItems": 8,
      "type": "array"
    },
    "native": {
      "$ref": "#/components/schemas/DarktableDevelopRecipe"
    },
    "noiseReduction": {
      "description": "Luminance noise reduction amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "preset": {
      "$ref": "#/components/schemas/AssetDevelopPreset"
    },
    "presetStrength": {
      "description": "How much of the preset is applied, as a percentage",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "saturation": {
      "description": "Global saturation",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "shadows": {
      "description": "Shadow lift (positive) or deepening (negative)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "sharpen": {
      "description": "Detail sharpening amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "temperature": {
      "description": "Warm (positive) or cool (negative) white balance shift",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "tint": {
      "description": "Magenta (positive) or green (negative) tint",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "vibrance": {
      "description": "Saturation weighted towards muted colours",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "vignette": {
      "description": "Darkened (positive) or lightened (negative) edges",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "whites": {
      "description": "White point",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    }
  },
  "type": "object"
}
```

## DevelopPresetUpdateDto

Related models: [DevelopPresetSettingsUpdateDto](models-11.md#developpresetsettingsupdatedto).

```json
{
  "properties": {
    "name": {
      "description": "Name shown in the presets list; unique per account",
      "maxLength": 80,
      "minLength": 1,
      "type": "string"
    },
    "settings": {
      "$ref": "#/components/schemas/DevelopPresetSettingsUpdateDto",
      "description": "Settings to change; every setting left out, including ones this client does not know, keeps its stored value"
    }
  },
  "type": "object"
}
```

## DocumentEditAction


```json
{
  "description": "What the owner decided about recognized text",
  "enum": [
    "confirm",
    "correct",
    "dismiss"
  ],
  "type": "string"
}
```

## DocumentField


```json
{
  "description": "A value suggested from recognized text",
  "enum": [
    "date",
    "total",
    "reference",
    "email",
    "phone"
  ],
  "type": "string"
}
```

## DocumentFieldCandidateDto

Related models: [DocumentRegionDto](models-11.md#documentregiondto).

```json
{
  "properties": {
    "confidence": {
      "description": "Recognition confidence of that line; null for a corrected line",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "lineId": {
      "description": "Recognized line the value was read from",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "region": {
      "$ref": "#/components/schemas/DocumentRegionDto"
    },
    "value": {
      "description": "The value as the text reads it",
      "type": "string"
    }
  },
  "required": [
    "confidence",
    "lineId",
    "region",
    "value"
  ],
  "type": "object"
}
```

## DocumentFieldEditDto

Related models: [DocumentEditAction](models-11.md#documenteditaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/DocumentEditAction"
    },
    "lineId": {
      "description": "Recognized line supporting the value",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "recognizedText": {
      "description": "The recognized text of that line the caller read",
      "type": "string"
    },
    "revision": {
      "description": "Revision of the existing decision, if there is one",
      "maximum": 9007199254740991,
      "minimum": 1,
      "nullable": true,
      "type": "integer"
    },
    "value": {
      "description": "The value, for confirm and correct",
      "maxLength": 2000,
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

## DocumentFieldResponseDto

Related models: [DocumentField](models-11.md#documentfield), [DocumentFieldCandidateDto](models-11.md#documentfieldcandidatedto), [DocumentFieldStatus](models-11.md#documentfieldstatus), [DocumentRegionDto](models-11.md#documentregiondto).

```json
{
  "properties": {
    "candidates": {
      "description": "Values the text suggests, most likely first",
      "items": {
        "$ref": "#/components/schemas/DocumentFieldCandidateDto"
      },
      "type": "array"
    },
    "confidence": {
      "description": "Recognition confidence of the supporting line (0-1)",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "editId": {
      "description": "ID of the owner’s decision about this field",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "evidenceChanged": {
      "description": "The supporting text has since been read differently or is gone",
      "type": "boolean"
    },
    "field": {
      "$ref": "#/components/schemas/DocumentField"
    },
    "lineId": {
      "description": "Recognized line supporting the value",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "region": {
      "allOf": [
        {
          "$ref": "#/components/schemas/DocumentRegionDto"
        }
      ],
      "nullable": true
    },
    "revision": {
      "description": "Revision of the owner’s decision",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "status": {
      "$ref": "#/components/schemas/DocumentFieldStatus"
    },
    "updatedAt": {
      "description": "When the owner last decided",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "value": {
      "description": "The suggested, confirmed or corrected value; null when dismissed",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "candidates",
    "confidence",
    "editId",
    "evidenceChanged",
    "field",
    "lineId",
    "region",
    "revision",
    "status",
    "updatedAt",
    "value"
  ],
  "type": "object"
}
```

## DocumentFieldStatus


```json
{
  "description": "Whether a document field is a suggestion or the owner decided it",
  "enum": [
    "suggested",
    "confirmed",
    "corrected",
    "dismissed"
  ],
  "type": "string"
}
```

## DocumentLineDto

Related models: [DocumentLineStatus](models-11.md#documentlinestatus), [DocumentRegionDto](models-11.md#documentregiondto).

```json
{
  "properties": {
    "confidence": {
      "description": "Recognition confidence (0-1)",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "editId": {
      "description": "ID of the owner’s decision about this line",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "evidenceChanged": {
      "description": "The decision was made against text that has since been read differently",
      "type": "boolean"
    },
    "id": {
      "description": "Recognized line ID, or the decision ID of a kept correction",
      "type": "string"
    },
    "ocrId": {
      "description": "Recognized line ID; null once the line is gone",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "recognizedText": {
      "description": "The recognized text, while the recognized line exists",
      "nullable": true,
      "type": "string"
    },
    "region": {
      "allOf": [
        {
          "$ref": "#/components/schemas/DocumentRegionDto"
        }
      ],
      "nullable": true
    },
    "revision": {
      "description": "Revision of the owner’s decision",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "status": {
      "$ref": "#/components/schemas/DocumentLineStatus"
    },
    "text": {
      "description": "What the line reads: the owner’s correction or the recognized text",
      "type": "string"
    }
  },
  "required": [
    "confidence",
    "editId",
    "evidenceChanged",
    "id",
    "ocrId",
    "recognizedText",
    "region",
    "revision",
    "status",
    "text"
  ],
  "type": "object"
}
```

## DocumentLineEditDto

Related models: [DocumentEditAction](models-11.md#documenteditaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/DocumentEditAction"
    },
    "ocrId": {
      "description": "Recognized line the decision is about",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "recognizedText": {
      "description": "The recognized text the caller read; refused when it changed",
      "type": "string"
    },
    "revision": {
      "description": "Revision of the existing decision, if there is one",
      "maximum": 9007199254740991,
      "minimum": 1,
      "nullable": true,
      "type": "integer"
    },
    "value": {
      "description": "The corrected text, for correct",
      "maxLength": 2000,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "action",
    "ocrId",
    "recognizedText"
  ],
  "type": "object"
}
```

## DocumentLineStatus


```json
{
  "description": "Where the text of a document line comes from",
  "enum": [
    "recognized",
    "corrected",
    "dismissed",
    "kept"
  ],
  "type": "string"
}
```

## DocumentRecognitionDto


```json
{
  "properties": {
    "enabled": {
      "description": "Text recognition is switched on",
      "type": "boolean"
    },
    "routed": {
      "description": "A processing destination is chosen for text recognition",
      "type": "boolean"
    }
  },
  "required": [
    "enabled",
    "routed"
  ],
  "type": "object"
}
```

## DocumentRegionDto


```json
{
  "description": "Where the text is in the photo as it is shown, edits applied",
  "properties": {
    "x1": {
      "description": "Normalized x coordinate of corner 1 (0-1)",
      "format": "double",
      "type": "number"
    },
    "x2": {
      "description": "Normalized x coordinate of corner 2 (0-1)",
      "format": "double",
      "type": "number"
    },
    "x3": {
      "description": "Normalized x coordinate of corner 3 (0-1)",
      "format": "double",
      "type": "number"
    },
    "x4": {
      "description": "Normalized x coordinate of corner 4 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y1": {
      "description": "Normalized y coordinate of corner 1 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y2": {
      "description": "Normalized y coordinate of corner 2 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y3": {
      "description": "Normalized y coordinate of corner 3 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y4": {
      "description": "Normalized y coordinate of corner 4 (0-1)",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "x1",
    "x2",
    "x3",
    "x4",
    "y1",
    "y2",
    "y3",
    "y4"
  ],
  "type": "object"
}
```

## DocumentResponseDto

Related models: [DocumentFieldResponseDto](models-11.md#documentfieldresponsedto), [DocumentLineDto](models-11.md#documentlinedto), [DocumentRecognitionDto](models-11.md#documentrecognitiondto).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "canEdit": {
      "description": "The caller owns the photo and may correct its text",
      "type": "boolean"
    },
    "fields": {
      "items": {
        "$ref": "#/components/schemas/DocumentFieldResponseDto"
      },
      "type": "array"
    },
    "fieldsEnabled": {
      "description": "Field suggestions are switched on",
      "type": "boolean"
    },
    "lines": {
      "items": {
        "$ref": "#/components/schemas/DocumentLineDto"
      },
      "type": "array"
    },
    "recognition": {
      "allOf": [
        {
          "$ref": "#/components/schemas/DocumentRecognitionDto"
        }
      ],
      "description": "Whether the photo can be read again; owner only",
      "nullable": true
    },
    "recognizedAt": {
      "description": "When the text was last read",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "canEdit",
    "fields",
    "fieldsEnabled",
    "lines",
    "recognition",
    "recognizedAt"
  ],
  "type": "object"
}
```

## DocumentSearchResponseDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/AssetResponseDto"
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
    "items",
    "nextPage",
    "total"
  ],
  "type": "object"
}
```

## DownloadArchiveDto


```json
{
  "properties": {
    "archiveName": {
      "description": "The name of the archive to download, without extension",
      "type": "string"
    },
    "assetIds": {
      "description": "Asset IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "edited": {
      "description": "Download edited asset if available",
      "type": "boolean"
    }
  },
  "required": [
    "assetIds"
  ],
  "type": "object"
}
```

## DownloadArchiveInfo


```json
{
  "properties": {
    "assetIds": {
      "description": "Asset IDs in this archive",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "size": {
      "description": "Archive size in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "assetIds",
    "size"
  ],
  "type": "object"
}
```

## DownloadInfoDto


```json
{
  "properties": {
    "albumId": {
      "description": "Album ID to download",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "archiveSize": {
      "description": "Archive size limit in bytes",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "assetIds": {
      "description": "Asset IDs to download",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "userId": {
      "description": "User ID to download assets from",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## DownloadResponse


```json
{
  "properties": {
    "archiveSize": {
      "description": "Maximum archive size in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "includeEmbeddedVideos": {
      "description": "Whether to include embedded videos in downloads",
      "type": "boolean"
    }
  },
  "required": [
    "archiveSize",
    "includeEmbeddedVideos"
  ],
  "type": "object"
}
```

## DownloadResponseDto

Related models: [DownloadArchiveInfo](models-11.md#downloadarchiveinfo).

```json
{
  "properties": {
    "archives": {
      "description": "Archive information",
      "items": {
        "$ref": "#/components/schemas/DownloadArchiveInfo"
      },
      "type": "array"
    },
    "totalSize": {
      "description": "Total size in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "archives",
    "totalSize"
  ],
  "type": "object"
}
```

## DownloadUpdate


```json
{
  "properties": {
    "archiveSize": {
      "description": "Maximum archive size in bytes",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "includeEmbeddedVideos": {
      "description": "Whether to include embedded videos in downloads",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## DuplicateActiveGroupDto


```json
{
  "properties": {
    "duplicateId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "memberIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "duplicateId",
    "memberIds"
  ],
  "type": "object"
}
```

## DuplicateActiveOperationDto

Related models: [DuplicateActiveGroupDto](models-11.md#duplicateactivegroupdto), [MediaOperationBulkAction](models-17.md#mediaoperationbulkaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MediaOperationBulkAction"
    },
    "groups": {
      "items": {
        "$ref": "#/components/schemas/DuplicateActiveGroupDto"
      },
      "type": "array"
    },
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "action",
    "groups",
    "operationId"
  ],
  "type": "object"
}
```

## DuplicateDecisionBatchDto

Related models: [DuplicateDecisionGroupDto](models-11.md#duplicatedecisiongroupdto).

```json
{
  "properties": {
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "groups": {
      "items": {
        "$ref": "#/components/schemas/DuplicateDecisionGroupDto"
      },
      "type": "array"
    },
    "operationId": {
      "description": "The durable job that applied these decisions",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "undoable": {
      "description": "Every decision of the job is applied and none has been undone",
      "type": "boolean"
    }
  },
  "required": [
    "createdAt",
    "groups",
    "operationId",
    "undoable"
  ],
  "type": "object"
}
```

## DuplicateDecisionGroupDto

Related models: [DuplicateDecisionKind](models-11.md#duplicatedecisionkind).

```json
{
  "properties": {
    "applied": {
      "type": "boolean"
    },
    "decision": {
      "$ref": "#/components/schemas/DuplicateDecisionKind"
    },
    "decisionId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "duplicateId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "keepAssetIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "memberIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "trashAssetIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "undoing": {
      "description": "An undo job has started on this decision",
      "type": "boolean"
    },
    "undone": {
      "type": "boolean"
    }
  },
  "required": [
    "applied",
    "decision",
    "decisionId",
    "duplicateId",
    "keepAssetIds",
    "memberIds",
    "trashAssetIds",
    "undoing",
    "undone"
  ],
  "type": "object"
}
```

## DuplicateDecisionHistoryDto

Related models: [DuplicateActiveOperationDto](models-11.md#duplicateactiveoperationdto), [DuplicateDecisionBatchDto](models-11.md#duplicatedecisionbatchdto).

```json
{
  "properties": {
    "active": {
      "description": "Decision and undo jobs still running",
      "items": {
        "$ref": "#/components/schemas/DuplicateActiveOperationDto"
      },
      "type": "array"
    },
    "recent": {
      "description": "The most recent decision jobs, newest first",
      "items": {
        "$ref": "#/components/schemas/DuplicateDecisionBatchDto"
      },
      "type": "array"
    }
  },
  "required": [
    "active",
    "recent"
  ],
  "type": "object"
}
```

## DuplicateDecisionKind


```json
{
  "description": "What the owner decided for a duplicate group",
  "enum": [
    "keepers",
    "keep-all",
    "stack"
  ],
  "type": "string"
}
```

## DuplicateGroupBlock


```json
{
  "description": "Why a duplicate group cannot be decided from this session",
  "enum": [
    "hidden-members",
    "other-owner"
  ],
  "type": "string"
}
```

## DuplicateGroupKind


```json
{
  "description": "Whether a duplicate group holds copies of one photo or frames of a burst",
  "enum": [
    "duplicates",
    "burst"
  ],
  "type": "string"
}
```

## DuplicateQualityReason


```json
{
  "description": "Evidence behind a duplicate keeper suggestion",
  "enum": [
    "original-format",
    "largest-file",
    "highest-resolution",
    "most-metadata",
    "compressed-copy",
    "lower-resolution"
  ],
  "type": "string"
}
```

## DuplicateResolveDto

Related models: [DuplicateResolveGroupDto](models-11.md#duplicateresolvegroupdto).

```json
{
  "properties": {
    "groups": {
      "description": "List of duplicate groups to resolve",
      "items": {
        "$ref": "#/components/schemas/DuplicateResolveGroupDto"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "groups"
  ],
  "type": "object"
}
```

## DuplicateResolveGroupDto


```json
{
  "properties": {
    "duplicateId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "keepAssetIds": {
      "description": "Asset IDs to keep",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "trashAssetIds": {
      "description": "Asset IDs to trash or delete",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "duplicateId",
    "keepAssetIds",
    "trashAssetIds"
  ],
  "type": "object"
}
```

## DuplicateResponseDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto).

```json
{
  "properties": {
    "assets": {
      "description": "Duplicate assets",
      "items": {
        "$ref": "#/components/schemas/AssetResponseDto"
      },
      "type": "array"
    },
    "duplicateId": {
      "description": "Duplicate group ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "reviewRequiredReasons": {
      "description": "Safety reasons that prevent unattended disposal of the non-suggested copies",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "suggestedKeepAssetIds": {
      "description": "Suggested asset IDs to keep based on format preference (RAW, HEIC/HEIF/HIF, then other formats), file size and EXIF data",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "assets",
    "duplicateId",
    "suggestedKeepAssetIds"
  ],
  "type": "object"
}
```

## DuplicateReviewGroupDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto), [DuplicateGroupBlock](models-11.md#duplicategroupblock), [DuplicateGroupKind](models-11.md#duplicategroupkind), [DuplicateReviewQualityDto](models-11.md#duplicatereviewqualitydto).

```json
{
  "properties": {
    "assets": {
      "description": "The photos of the group this session may see",
      "items": {
        "$ref": "#/components/schemas/AssetResponseDto"
      },
      "type": "array"
    },
    "blockedReason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/DuplicateGroupBlock"
        }
      ],
      "nullable": true
    },
    "duplicateId": {
      "description": "Duplicate group ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "editable": {
      "description": "Whether this session may decide the group",
      "type": "boolean"
    },
    "hiddenMemberCount": {
      "description": "Photos of the group this session does not see",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "kind": {
      "$ref": "#/components/schemas/DuplicateGroupKind"
    },
    "otherOwnerNames": {
      "description": "Display names of the other accounts owning photos of a group blocked by another owner",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "qualities": {
      "items": {
        "$ref": "#/components/schemas/DuplicateReviewQualityDto"
      },
      "type": "array"
    },
    "reviewRequiredReasons": {
      "description": "Safety reasons requiring review before duplicate disposal",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "suggestedKeepAssetIds": {
      "description": "The suggested keeper, from format preference, file size and metadata. Never set for a burst",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "totalBytes": {
      "description": "Size of the originals shown, in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "assets",
    "blockedReason",
    "duplicateId",
    "editable",
    "hiddenMemberCount",
    "kind",
    "qualities",
    "suggestedKeepAssetIds",
    "totalBytes"
  ],
  "type": "object"
}
```

## DuplicateReviewQualityDto

Related models: [DuplicateQualityReason](models-11.md#duplicatequalityreason).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "reasons": {
      "description": "Evidence for or against keeping this copy",
      "items": {
        "$ref": "#/components/schemas/DuplicateQualityReason"
      },
      "type": "array"
    }
  },
  "required": [
    "assetId",
    "reasons"
  ],
  "type": "object"
}
```

## EmailNotificationsResponse


```json
{
  "properties": {
    "albumInvite": {
      "description": "Whether to receive email notifications for album invites",
      "type": "boolean"
    },
    "albumUpdate": {
      "description": "Whether to receive email notifications for album updates",
      "type": "boolean"
    },
    "enabled": {
      "description": "Whether email notifications are enabled",
      "type": "boolean"
    }
  },
  "required": [
    "albumInvite",
    "albumUpdate",
    "enabled"
  ],
  "type": "object"
}
```

## EmailNotificationsUpdate


```json
{
  "properties": {
    "albumInvite": {
      "description": "Whether to receive email notifications for album invites",
      "type": "boolean"
    },
    "albumUpdate": {
      "description": "Whether to receive email notifications for album updates",
      "type": "boolean"
    },
    "enabled": {
      "description": "Whether email notifications are enabled",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## EnrichmentDestinationAdmissionDto


```json
{
  "properties": {
    "admitted": {
      "type": "boolean"
    },
    "refusal": {
      "description": "Stable refusal code when it would not",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "admitted",
    "refusal"
  ],
  "type": "object"
}
```

## EnrichmentDestinationOptionDto

Related models: [EnrichmentDestinationAdmissionDto](models-11.md#enrichmentdestinationadmissiondto), [MlDestinationHealth](models-18.md#mldestinationhealth), [MlDestinationKind](models-18.md#mldestinationkind).

```json
{
  "properties": {
    "cloud": {
      "description": "Sends media off this network; needs recorded consent",
      "type": "boolean"
    },
    "enrichment": {
      "$ref": "#/components/schemas/EnrichmentDestinationAdmissionDto"
    },
    "health": {
      "$ref": "#/components/schemas/MlDestinationHealth"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/MlDestinationKind"
    },
    "name": {
      "type": "string"
    },
    "search": {
      "$ref": "#/components/schemas/EnrichmentDestinationAdmissionDto"
    }
  },
  "required": [
    "cloud",
    "enrichment",
    "health",
    "id",
    "kind",
    "name",
    "search"
  ],
  "type": "object"
}
```

## EnrichmentItemState


```json
{
  "description": "Enrichment plan item state",
  "enum": [
    "queued",
    "running",
    "skipped",
    "failed",
    "completed",
    "cancelled"
  ],
  "type": "string"
}
```

## EnrichmentOptionsResponseDto

Related models: [EnrichmentDestinationOptionDto](models-11.md#enrichmentdestinationoptiondto), [EnrichmentStage](models-11.md#enrichmentstage).

```json
{
  "properties": {
    "defaultStages": {
      "description": "Stages a new plan starts with; never moment captions",
      "items": {
        "$ref": "#/components/schemas/EnrichmentStage"
      },
      "type": "array"
    },
    "descriptionEnabled": {
      "type": "boolean"
    },
    "destinations": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentDestinationOptionDto"
      },
      "type": "array"
    },
    "framesPerVideo": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "lockedCheckEnabled": {
      "type": "boolean"
    },
    "maxAssets": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxSamples": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "modelName": {
      "description": "Saved description model",
      "type": "string"
    },
    "routes": {
      "description": "The destinations library work is routed to; a plan uses these unless another is chosen",
      "properties": {
        "enrichment": {
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        },
        "search": {
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        }
      },
      "required": [
        "enrichment",
        "search"
      ],
      "type": "object"
    },
    "searchEnabled": {
      "type": "boolean"
    },
    "searchModelName": {
      "description": "Saved search model",
      "type": "string"
    }
  },
  "required": [
    "defaultStages",
    "descriptionEnabled",
    "destinations",
    "framesPerVideo",
    "lockedCheckEnabled",
    "maxAssets",
    "maxSamples",
    "modelName",
    "routes",
    "searchEnabled",
    "searchModelName"
  ],
  "type": "object"
}
```

## EnrichmentPlanCountsDto


```json
{
  "properties": {
    "cancelled": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "completed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "failed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "queued": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "running": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "skipped": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "cancelled",
    "completed",
    "failed",
    "queued",
    "running",
    "skipped",
    "total"
  ],
  "type": "object"
}
```

## EnrichmentPlanCreateDto

Related models: [EnrichmentStage](models-11.md#enrichmentstage).

```json
{
  "properties": {
    "assetIds": {
      "description": "The frozen set, in order; never re-resolved",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    },
    "destinationId": {
      "description": "Destination for descriptions, checks and captions",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "requestKey": {
      "description": "Client idempotency key; submitting the same key again returns the existing plan",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "searchDestinationId": {
      "description": "Destination for search embeddings",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "stages": {
      "description": "Chosen stages; the ones they need are added",
      "items": {
        "$ref": "#/components/schemas/EnrichmentStage"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "assetIds",
    "stages"
  ],
  "type": "object"
}
```

## EnrichmentPlanDestinationDto


```json
{
  "properties": {
    "cloud": {
      "type": "boolean"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "type": "string"
    }
  },
  "required": [
    "cloud",
    "id",
    "name"
  ],
  "type": "object"
}
```

## EnrichmentPlanItemDto

Related models: [EnrichmentItemState](models-11.md#enrichmentitemstate), [EnrichmentPlanStageOutcomeDto](models-11.md#enrichmentplanstageoutcomedto).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "retryPending": {
      "description": "Waiting for its one automatic retry",
      "type": "boolean"
    },
    "stages": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentPlanStageOutcomeDto"
      },
      "type": "array"
    },
    "state": {
      "$ref": "#/components/schemas/EnrichmentItemState"
    }
  },
  "required": [
    "assetId",
    "retryPending",
    "stages",
    "state"
  ],
  "type": "object"
}
```

## EnrichmentPlanResponseDto

Related models: [EnrichmentPlanCountsDto](models-11.md#enrichmentplancountsdto), [EnrichmentPlanDestinationDto](models-11.md#enrichmentplandestinationdto), [EnrichmentPlanItemDto](models-11.md#enrichmentplanitemdto), [EnrichmentStage](models-11.md#enrichmentstage), [MediaOperationDto](models-17.md#mediaoperationdto).

```json
{
  "properties": {
    "addedStages": {
      "description": "Stages run only because a chosen stage needs them",
      "items": {
        "$ref": "#/components/schemas/EnrichmentStage"
      },
      "type": "array"
    },
    "configHash": {
      "type": "string"
    },
    "counts": {
      "$ref": "#/components/schemas/EnrichmentPlanCountsDto"
    },
    "enrichmentDestination": {
      "allOf": [
        {
          "$ref": "#/components/schemas/EnrichmentPlanDestinationDto"
        }
      ],
      "nullable": true
    },
    "hiddenCount": {
      "description": "Locked items not listed because this session is not unlocked",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentPlanItemDto"
      },
      "type": "array"
    },
    "modelName": {
      "type": "string"
    },
    "operation": {
      "$ref": "#/components/schemas/MediaOperationDto"
    },
    "requestedStages": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentStage"
      },
      "type": "array"
    },
    "searchDestination": {
      "allOf": [
        {
          "$ref": "#/components/schemas/EnrichmentPlanDestinationDto"
        }
      ],
      "nullable": true
    },
    "searchModelName": {
      "type": "string"
    },
    "stages": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentStage"
      },
      "type": "array"
    }
  },
  "required": [
    "addedStages",
    "configHash",
    "counts",
    "enrichmentDestination",
    "hiddenCount",
    "items",
    "modelName",
    "operation",
    "requestedStages",
    "searchDestination",
    "searchModelName",
    "stages"
  ],
  "type": "object"
}
```

## EnrichmentPlanStageOutcomeDto

Related models: [EnrichmentItemState](models-11.md#enrichmentitemstate), [EnrichmentStage](models-11.md#enrichmentstage).

```json
{
  "properties": {
    "at": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "message": {
      "nullable": true,
      "type": "string"
    },
    "reasonKey": {
      "nullable": true,
      "type": "string"
    },
    "stage": {
      "$ref": "#/components/schemas/EnrichmentStage"
    },
    "state": {
      "$ref": "#/components/schemas/EnrichmentItemState"
    }
  },
  "required": [
    "at",
    "message",
    "reasonKey",
    "stage",
    "state"
  ],
  "type": "object"
}
```

## EnrichmentPreviewRequestDto

Related models: [AdminConfigImageDescriptionPromptDto](models-01.md#adminconfigimagedescriptionpromptdto).

```json
{
  "properties": {
    "assetIds": {
      "description": "Samples to describe; run one at a time",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 6,
      "minItems": 1,
      "type": "array"
    },
    "destinationId": {
      "description": "Destination to run on; the routed one when omitted",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "fallbackModelName": {
      "type": "string"
    },
    "modelName": {
      "description": "Draft model; the saved one when omitted",
      "minLength": 1,
      "type": "string"
    },
    "prompt": {
      "$ref": "#/components/schemas/AdminConfigImageDescriptionPromptDto",
      "description": "Draft prompt; the saved one when omitted"
    }
  },
  "required": [
    "assetIds"
  ],
  "type": "object"
}
```

## EnrichmentPreviewResponseDto

Related models: [EnrichmentPreviewSampleDto](models-11.md#enrichmentpreviewsampledto).

```json
{
  "properties": {
    "cloud": {
      "type": "boolean"
    },
    "destinationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "destinationName": {
      "type": "string"
    },
    "modelName": {
      "type": "string"
    },
    "samples": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentPreviewSampleDto"
      },
      "type": "array"
    }
  },
  "required": [
    "cloud",
    "destinationId",
    "destinationName",
    "modelName",
    "samples"
  ],
  "type": "object"
}
```

## EnrichmentPreviewSampleDto

Related models: [EnrichmentPreviewStatus](models-11.md#enrichmentpreviewstatus).

```json
{
  "properties": {
    "ambiguousReferences": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "candidate": {
      "description": "What the draft produced; stored nowhere",
      "nullable": true,
      "type": "string"
    },
    "current": {
      "description": "The stored generated description, unchanged",
      "nullable": true,
      "type": "string"
    },
    "durationMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "frameCount": {
      "description": "Video frames the draft saw; 0 for a photo",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "hallucinatedNames": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "message": {
      "nullable": true,
      "type": "string"
    },
    "reasonKey": {
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/EnrichmentPreviewStatus"
    },
    "tags": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "warnings": {
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "ambiguousReferences",
    "assetId",
    "candidate",
    "current",
    "durationMs",
    "frameCount",
    "hallucinatedNames",
    "message",
    "reasonKey",
    "status",
    "tags",
    "warnings"
  ],
  "type": "object"
}
```

## EnrichmentPreviewStatus


```json
{
  "description": "Enrichment preview sample status",
  "enum": [
    "success",
    "failed",
    "skipped"
  ],
  "type": "string"
}
```

## EnrichmentStage


```json
{
  "description": "Enrichment plan stage",
  "enum": [
    "frames",
    "locked-check",
    "description",
    "moment-index",
    "moment-captions"
  ],
  "type": "string"
}
```

## EnrichmentStaleReason


```json
{
  "description": "Why a generated result is out of date",
  "enum": [
    "source-changed",
    "identity-changed",
    "config-changed"
  ],
  "type": "string"
}
```

## EnumFilterAssetType

Related models: [AssetTypeEnum](models-06.md#assettypeenum).

```json
{
  "properties": {
    "eq": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "in": {
      "items": {
        "$ref": "#/components/schemas/AssetTypeEnum"
      },
      "minItems": 1,
      "type": "array"
    },
    "ne": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "notIn": {
      "items": {
        "$ref": "#/components/schemas/AssetTypeEnum"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## EnumFilterAssetVisibility

Related models: [AssetVisibility](models-06.md#assetvisibility).

```json
{
  "properties": {
    "eq": {
      "$ref": "#/components/schemas/AssetVisibility"
    },
    "in": {
      "items": {
        "$ref": "#/components/schemas/AssetVisibility"
      },
      "minItems": 1,
      "type": "array"
    },
    "ne": {
      "$ref": "#/components/schemas/AssetVisibility"
    },
    "notIn": {
      "items": {
        "$ref": "#/components/schemas/AssetVisibility"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## EventStoryDto

Related models: [LandmarkSummaryDto](models-15.md#landmarksummarydto), [MemoryStoryPlaceDto](models-18.md#memorystoryplacedto).

```json
{
  "properties": {
    "assetCount": {
      "description": "Number of assets the event held before the diversity pass",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "dayCount": {
      "description": "Number of distinct local days the event covers",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "endDate": {
      "description": "Last local day of the event, 'yyyy-MM-dd'",
      "type": "string"
    },
    "kind": {
      "description": "Discriminator for an event story",
      "enum": [
        "event_story"
      ],
      "type": "string"
    },
    "landmark": {
      "$ref": "#/components/schemas/LandmarkSummaryDto",
      "description": "The landmark the event was a visit to, when most of it was taken at one"
    },
    "place": {
      "$ref": "#/components/schemas/MemoryStoryPlaceDto"
    },
    "startDate": {
      "description": "First local day of the event, 'yyyy-MM-dd'",
      "type": "string"
    },
    "title": {
      "description": "Landmark name or place label for the event, when it has one",
      "type": "string"
    },
    "year": {
      "description": "Year the event started",
      "maximum": 9999,
      "minimum": 1000,
      "type": "integer"
    }
  },
  "required": [
    "assetCount",
    "dayCount",
    "endDate",
    "kind",
    "startDate",
    "year"
  ],
  "type": "object"
}
```
