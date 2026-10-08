# Server API models 5

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## AssetDevelopRecipeDto

Related models: [AssetDevelopCrop](models-04.md#assetdevelopcrop), [AssetDevelopPreset](models-04.md#assetdeveloppreset).

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "version": {
          "type": "number",
          "enum": [
            1
          ]
        },
        "exposure": {
          "type": "number",
          "minimum": -2,
          "maximum": 2,
          "format": "double"
        },
        "contrast": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "brilliance": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "highlights": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "shadows": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "whites": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "blacks": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "temperature": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "tint": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "vibrance": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "saturation": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "clarity": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "dehaze": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "vignette": {
          "type": "number",
          "minimum": -100,
          "maximum": 100,
          "format": "double"
        },
        "grain": {
          "type": "number",
          "minimum": 0,
          "maximum": 100,
          "format": "double"
        },
        "sharpen": {
          "type": "number",
          "minimum": 0,
          "maximum": 100,
          "format": "double"
        },
        "noiseReduction": {
          "type": "number",
          "minimum": 0,
          "maximum": 100,
          "format": "double"
        },
        "crop": {
          "$ref": "#/components/schemas/AssetDevelopCrop"
        },
        "straighten": {
          "type": "number",
          "minimum": -45,
          "maximum": 45,
          "format": "double"
        },
        "rotation": {
          "type": "integer",
          "minimum": 0,
          "maximum": 270
        },
        "flipHorizontal": {
          "type": "boolean"
        },
        "flipVertical": {
          "type": "boolean"
        },
        "preset": {
          "$ref": "#/components/schemas/AssetDevelopPreset"
        },
        "presetStrength": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "masks": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": {}
          }
        },
        "cleanup": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": {}
          }
        }
      },
      "required": [
        "version"
      ],
      "additionalProperties": {}
    },
    {
      "type": "object",
      "properties": {
        "version": {
          "type": "integer",
          "minimum": 2,
          "maximum": 2147483647
        }
      },
      "required": [
        "version"
      ],
      "additionalProperties": {}
    }
  ]
}
```

## AssetDevelopRegion


```json
{
  "properties": {
    "h": {
      "description": "Height as a fraction of the original",
      "format": "double",
      "maximum": 1,
      "minimum": 0.001,
      "type": "number"
    },
    "w": {
      "description": "Width as a fraction of the original",
      "format": "double",
      "maximum": 1,
      "minimum": 0.001,
      "type": "number"
    },
    "x": {
      "description": "Left edge as a fraction of the original image width",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "y": {
      "description": "Top edge as a fraction of the original image height",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "required": [
    "h",
    "w",
    "x",
    "y"
  ],
  "type": "object"
}
```

## AssetDevelopResponseDto

Related models: [AssetDevelopRevisionResponseDto](models-05.md#assetdeveloprevisionresponsedto).

```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID these revisions belong to",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "currentRevisionId": {
      "description": "The revision the asset currently shows; null means the original",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "revisions": {
      "description": "Every saved version of the recipe, newest first",
      "items": {
        "$ref": "#/components/schemas/AssetDevelopRevisionResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "assetId",
    "currentRevisionId",
    "revisions"
  ],
  "type": "object"
}
```

## AssetDevelopRevertDto


```json
{
  "properties": {
    "revisionId": {
      "description": "Rendered revision to make current again; omitted, the original becomes current",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## AssetDevelopRevisionKind


```json
{
  "description": "How a develop version was produced",
  "enum": [
    "recipe",
    "external"
  ],
  "type": "string"
}
```

## AssetDevelopRevisionResponseDto

Related models: [AssetDevelopRecipeDto](models-05.md#assetdeveloprecipedto), [AssetDevelopRevisionKind](models-05.md#assetdeveloprevisionkind), [AssetDevelopRevisionStatus](models-05.md#assetdeveloprevisionstatus).

```json
{
  "properties": {
    "assetId": {
      "description": "Asset this revision belongs to",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "attempts": {
      "description": "Render attempts so far; one automatic retry follows a first failure",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "createdAt": {
      "description": "When the version was saved",
      "format": "date-time",
      "type": "string"
    },
    "error": {
      "description": "Why the last render failed, when it did",
      "nullable": true,
      "type": "string"
    },
    "exportId": {
      "description": "The export of the original an imported version was developed from",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "fileName": {
      "description": "Name of the imported file, for a version developed elsewhere",
      "nullable": true,
      "type": "string"
    },
    "hasHdrMaster": {
      "type": "boolean"
    },
    "hasHdrPreview": {
      "type": "boolean"
    },
    "hasMaster": {
      "description": "True once the edited master file exists",
      "type": "boolean"
    },
    "hasPreview": {
      "description": "True once the preview file exists",
      "type": "boolean"
    },
    "hdrRenderStatus": {
      "enum": [
        "not-requested",
        "pending",
        "rendered",
        "failed",
        "disabled"
      ],
      "type": "string"
    },
    "height": {
      "description": "Height of the edited master in pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "id": {
      "description": "Develop revision ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isCurrent": {
      "description": "True for the version the asset currently shows",
      "type": "boolean"
    },
    "kind": {
      "$ref": "#/components/schemas/AssetDevelopRevisionKind"
    },
    "label": {
      "description": "Name given when the version was saved",
      "nullable": true,
      "type": "string"
    },
    "outputDynamicRange": {
      "enum": [
        "hdr",
        "sdr",
        "unknown"
      ],
      "type": "string"
    },
    "progress": {
      "description": "Render progress as a percentage",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "recipe": {
      "$ref": "#/components/schemas/AssetDevelopRecipeDto"
    },
    "renderedAt": {
      "description": "When the render finished",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "rendererVersion": {
      "description": "Identity of the renderer that produced the files, for lineage",
      "nullable": true,
      "type": "string"
    },
    "renditionChecksum": {
      "description": "SHA-256 (hex) of the edited master file, once it exists",
      "nullable": true,
      "type": "string"
    },
    "revision": {
      "description": "Per-asset sequence number, 1 for the first saved version",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "software": {
      "description": "Application an imported version was developed with, when known",
      "nullable": true,
      "type": "string"
    },
    "sourceChecksum": {
      "description": "SHA-256 (hex) of the original this version was rendered or developed from",
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/AssetDevelopRevisionStatus"
    },
    "updatedAt": {
      "description": "When the revision last changed",
      "format": "date-time",
      "type": "string"
    },
    "width": {
      "description": "Width of the edited master in pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "assetId",
    "attempts",
    "createdAt",
    "error",
    "exportId",
    "fileName",
    "hasMaster",
    "hasPreview",
    "height",
    "id",
    "isCurrent",
    "kind",
    "label",
    "progress",
    "recipe",
    "renderedAt",
    "rendererVersion",
    "renditionChecksum",
    "revision",
    "software",
    "sourceChecksum",
    "status",
    "updatedAt",
    "width"
  ],
  "type": "object"
}
```

## AssetDevelopRevisionStatus


```json
{
  "description": "Render state of a develop revision",
  "enum": [
    "saved",
    "queued",
    "rendering",
    "rendered",
    "failed",
    "cancelled"
  ],
  "type": "string"
}
```

## AssetDevelopSaveDto

Related models: [AssetDevelopRecipeDto](models-05.md#assetdeveloprecipedto).

```json
{
  "properties": {
    "label": {
      "description": "Optional name for the saved version",
      "maxLength": 120,
      "minLength": 1,
      "type": "string"
    },
    "recipe": {
      "$ref": "#/components/schemas/AssetDevelopRecipeDto"
    },
    "render": {
      "default": true,
      "description": "Queue the edited master render immediately after saving the recipe",
      "type": "boolean"
    },
    "replaceRecipe": {
      "description": "Explicit complete replacement instead of preserving omitted source fields, including intentional removals",
      "type": "boolean"
    },
    "sourceRevisionId": {
      "description": "Immutable revision of this owned asset whose omitted fields are preserved; never the implicit current revision",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "recipe"
  ],
  "type": "object"
}
```

## AssetDevelopSemanticMaskDto


```json
{
  "additionalProperties": false,
  "properties": {
    "target": {
      "enum": [
        "subject",
        "sky"
      ],
      "type": "string"
    }
  },
  "required": [
    "target"
  ],
  "type": "object"
}
```

## AssetDevelopStroke


```json
{
  "properties": {
    "erase": {
      "default": false,
      "description": "Erase from the mask instead of painting it (brush masks only)",
      "type": "boolean"
    },
    "points": {
      "items": {
        "description": "A point as [x, y] fractions of the original image (before rotation, flips and crop)",
        "items": {
          "format": "double",
          "maximum": 1,
          "minimum": 0,
          "type": "number"
        },
        "type": "array"
      },
      "maxItems": 512,
      "minItems": 1,
      "type": "array"
    },
    "radius": {
      "description": "Stroke radius as a fraction of the original image's shorter side",
      "format": "double",
      "maximum": 0.5,
      "minimum": 0.001,
      "type": "number"
    }
  },
  "required": [
    "points",
    "radius"
  ],
  "type": "object"
}
```

## AssetEditAction


```json
{
  "description": "Type of edit action to perform",
  "enum": [
    "crop",
    "rotate",
    "mirror",
    "trim",
    "straighten",
    "adjust",
    "filter",
    "effect",
    "autoEnhance",
    "stabilize",
    "textOverlay",
    "audio",
    "speed"
  ],
  "type": "string"
}
```

## AssetEditActionItemDto

Related models: [AdjustParameters](models-01.md#adjustparameters), [AssetEditAction](models-05.md#asseteditaction), [AudioParameters](models-06.md#audioparameters), [CropParameters](models-10.md#cropparameters), [LookParameters](models-15.md#lookparameters), [MirrorParameters](models-17.md#mirrorparameters), [RotateParameters](models-29.md#rotateparameters), [SpeedParameters](models-32.md#speedparameters), [StabilizeParameters](models-32.md#stabilizeparameters), [StraightenParameters](models-32.md#straightenparameters), [TextOverlayParameters](models-37.md#textoverlayparameters), [ToggleParameters](models-37.md#toggleparameters), [TrimParameters](models-37.md#trimparameters).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/AssetEditAction"
    },
    "parameters": {
      "anyOf": [
        {
          "$ref": "#/components/schemas/CropParameters"
        },
        {
          "$ref": "#/components/schemas/RotateParameters"
        },
        {
          "$ref": "#/components/schemas/MirrorParameters"
        },
        {
          "$ref": "#/components/schemas/TrimParameters"
        },
        {
          "$ref": "#/components/schemas/StraightenParameters"
        },
        {
          "$ref": "#/components/schemas/AdjustParameters"
        },
        {
          "$ref": "#/components/schemas/LookParameters"
        },
        {
          "$ref": "#/components/schemas/ToggleParameters"
        },
        {
          "$ref": "#/components/schemas/StabilizeParameters"
        },
        {
          "$ref": "#/components/schemas/TextOverlayParameters"
        },
        {
          "$ref": "#/components/schemas/AudioParameters"
        },
        {
          "$ref": "#/components/schemas/SpeedParameters"
        }
      ],
      "description": "List of edit actions to apply"
    }
  },
  "required": [
    "action",
    "parameters"
  ],
  "type": "object"
}
```

## AssetEditActionItemResponseDto

Related models: [AdjustParameters](models-01.md#adjustparameters), [AssetEditAction](models-05.md#asseteditaction), [AudioParameters](models-06.md#audioparameters), [CropParameters](models-10.md#cropparameters), [LookParameters](models-15.md#lookparameters), [MirrorParameters](models-17.md#mirrorparameters), [RotateParameters](models-29.md#rotateparameters), [SpeedParameters](models-32.md#speedparameters), [StabilizeParameters](models-32.md#stabilizeparameters), [StraightenParameters](models-32.md#straightenparameters), [TextOverlayParameters](models-37.md#textoverlayparameters), [ToggleParameters](models-37.md#toggleparameters), [TrimParameters](models-37.md#trimparameters).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/AssetEditAction"
    },
    "id": {
      "description": "Asset edit ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "parameters": {
      "anyOf": [
        {
          "$ref": "#/components/schemas/CropParameters"
        },
        {
          "$ref": "#/components/schemas/RotateParameters"
        },
        {
          "$ref": "#/components/schemas/MirrorParameters"
        },
        {
          "$ref": "#/components/schemas/TrimParameters"
        },
        {
          "$ref": "#/components/schemas/StraightenParameters"
        },
        {
          "$ref": "#/components/schemas/AdjustParameters"
        },
        {
          "$ref": "#/components/schemas/LookParameters"
        },
        {
          "$ref": "#/components/schemas/ToggleParameters"
        },
        {
          "$ref": "#/components/schemas/StabilizeParameters"
        },
        {
          "$ref": "#/components/schemas/TextOverlayParameters"
        },
        {
          "$ref": "#/components/schemas/AudioParameters"
        },
        {
          "$ref": "#/components/schemas/SpeedParameters"
        }
      ],
      "description": "List of edit actions to apply"
    }
  },
  "required": [
    "action",
    "id",
    "parameters"
  ],
  "type": "object"
}
```

## AssetEditKeyframesResponseDto


```json
{
  "properties": {
    "keyframesMs": {
      "description": "Times of the original's video keyframes in milliseconds from its start, ascending. A fast trim starts at the last one at or before its in point.",
      "items": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "type": "array"
    }
  },
  "required": [
    "keyframesMs"
  ],
  "type": "object"
}
```

## AssetEditsColorPolicy


```json
{
  "enum": [
    "preserve",
    "tone-map",
    "unsupported"
  ],
  "type": "string"
}
```

## AssetEditsCreateDto

Related models: [AssetEditActionItemDto](models-05.md#asseteditactionitemdto).

```json
{
  "properties": {
    "edits": {
      "description": "List of edit actions to apply",
      "items": {
        "$ref": "#/components/schemas/AssetEditActionItemDto"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "edits"
  ],
  "type": "object"
}
```

## AssetEditsOriginalVideoDto

Related models: [AssetEditsColorPolicy](models-05.md#asseteditscolorpolicy), [DecodeRefusal](models-10.md#decoderefusal).

```json
{
  "properties": {
    "colorPolicy": {
      "$ref": "#/components/schemas/AssetEditsColorPolicy",
      "description": "FL-113: what an edited version does with the original's colour. 'tone-map': an HDR original is rendered to SDR and kept as the reference; 'unsupported': this server cannot render an edited version (Dolby Vision profile 5), so saving is refused and the original stays unchanged"
    },
    "colorReason": {
      "description": "Why, in plain words, for the person editing",
      "type": "string"
    },
    "decodeRefusal": {
      "$ref": "#/components/schemas/DecodeRefusal",
      "description": "FL-101: set when this server cannot decode the original at all (a Dolby Vision profile outside the qualified matrix, more than 12 bits per component, an undescribable pixel format). colorPolicy is then 'unsupported' and colorReason says why; saving an edited version is refused before any editing"
    },
    "durationMs": {
      "description": "Duration of the original in milliseconds",
      "exclusiveMinimum": true,
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "height": {
      "description": "Displayed height of the original, after its rotation",
      "exclusiveMinimum": true,
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "width": {
      "description": "Displayed width of the original, after its rotation",
      "exclusiveMinimum": true,
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "durationMs",
    "height",
    "width"
  ],
  "type": "object"
}
```

## AssetEditsResponseDto

Related models: [AssetEditActionItemResponseDto](models-05.md#asseteditactionitemresponsedto), [AssetEditsOriginalVideoDto](models-05.md#asseteditsoriginalvideodto).

```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID these edits belong to",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "edits": {
      "description": "List of edit actions applied to the asset",
      "items": {
        "$ref": "#/components/schemas/AssetEditActionItemResponseDto"
      },
      "type": "array"
    },
    "originalVideo": {
      "$ref": "#/components/schemas/AssetEditsOriginalVideoDto",
      "description": "Original video display raster and timeline, independent of the current edited version"
    }
  },
  "required": [
    "assetId",
    "edits"
  ],
  "type": "object"
}
```

## AssetFaceBoxDto


```json
{
  "properties": {
    "height": {
      "description": "Face bounding box height",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "imageHeight": {
      "description": "Height in pixels of the image the box was drawn on",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Width in pixels of the image the box was drawn on",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "width": {
      "description": "Face bounding box width",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "x": {
      "description": "Face bounding box X coordinate",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "y": {
      "description": "Face bounding box Y coordinate",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "height",
    "imageHeight",
    "imageWidth",
    "width",
    "x",
    "y"
  ],
  "type": "object"
}
```

## AssetFaceCorrectionDto

Related models: [AssetFaceBoxDto](models-05.md#assetfaceboxdto).

```json
{
  "properties": {
    "box": {
      "$ref": "#/components/schemas/AssetFaceBoxDto",
      "description": "Move or resize the face, in the displayed (edited) image"
    },
    "expectedPersonId": {
      "description": "The person the face was assigned to when the correction was made (null when unassigned)",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "expectedRevision": {
      "description": "The face revision this correction was made against; a different current revision is refused with 409",
      "type": "string"
    },
    "expectedSourceRevision": {
      "description": "The face source revision (GET /faces/source) the coordinates were drawn on. When the image, its orientation or its edits changed since, the request is refused with 409",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        }
      ]
    },
    "hidden": {
      "description": "Hide the face, or show a hidden face again",
      "type": "boolean"
    },
    "personId": {
      "description": "Assign the face to this person, or null to unassign it",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "expectedRevision"
  ],
  "type": "object"
}
```

## AssetFaceCreateDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "expectedSourceRevision": {
      "description": "The face source revision (GET /faces/source) the coordinates were drawn on. When the image, its orientation or its edits changed since, the request is refused with 409",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        }
      ]
    },
    "height": {
      "description": "Face bounding box height",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "imageHeight": {
      "description": "Image height in pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Image width in pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "personId": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "width": {
      "description": "Face bounding box width",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "x": {
      "description": "Face bounding box X coordinate",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "y": {
      "description": "Face bounding box Y coordinate",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "assetId",
    "height",
    "imageHeight",
    "imageWidth",
    "personId",
    "width",
    "x",
    "y"
  ],
  "type": "object"
}
```

## AssetFaceDeleteDto


```json
{
  "properties": {
    "expectedRevision": {
      "description": "The face revision the deletion was decided on; a different current revision is refused with 409",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        }
      ]
    },
    "force": {
      "description": "Force delete even if person has other faces",
      "type": "boolean"
    }
  },
  "required": [
    "force"
  ],
  "type": "object"
}
```

## AssetFaceResponseDto

Related models: [PersonResponseDto](models-19.md#personresponsedto), [SourceType](models-32.md#sourcetype).

```json
{
  "description": "Asset face with person",
  "properties": {
    "boundingBoxX1": {
      "description": "Bounding box X1 coordinate",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxX2": {
      "description": "Bounding box X2 coordinate",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY1": {
      "description": "Bounding box Y1 coordinate",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY2": {
      "description": "Bounding box Y2 coordinate",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "correctedAt": {
      "description": "When a person last corrected this face (moved, resized, reassigned or unassigned it), or null",
      "format": "date-time",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        }
      ]
    },
    "hiddenAt": {
      "description": "When the owner hid this face, or null. Hidden faces are only listed with withHidden",
      "format": "date-time",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        }
      ]
    },
    "id": {
      "description": "Face ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "imageHeight": {
      "description": "Image height in pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Image width in pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "person": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PersonResponseDto"
        }
      ],
      "nullable": true
    },
    "revision": {
      "description": "Changes whenever this face changes; send it back as expectedRevision so a correction made against an older face is refused with 409",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        }
      ]
    },
    "sourceType": {
      "$ref": "#/components/schemas/SourceType"
    }
  },
  "required": [
    "boundingBoxX1",
    "boundingBoxX2",
    "boundingBoxY1",
    "boundingBoxY2",
    "correctedAt",
    "hiddenAt",
    "id",
    "imageHeight",
    "imageWidth",
    "person",
    "revision"
  ],
  "type": "object"
}
```

## AssetFaceSourceResponseDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "revision": {
      "description": "Changes when the image, its orientation or its edits change; send it back as expectedSourceRevision",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "revision"
  ],
  "type": "object"
}
```

## AssetFaceUpdateDto

Related models: [AssetFaceUpdateItem](models-05.md#assetfaceupdateitem).

```json
{
  "properties": {
    "data": {
      "description": "Face update items",
      "items": {
        "$ref": "#/components/schemas/AssetFaceUpdateItem"
      },
      "type": "array"
    }
  },
  "required": [
    "data"
  ],
  "type": "object"
}
```

## AssetFaceUpdateItem


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "personId": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "personId"
  ],
  "type": "object"
}
```

## AssetFileResponseDto

Related models: [AssetFileType](models-05.md#assetfiletype).

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
    "id": {
      "description": "Asset file ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isEdited": {
      "description": "The file was generated from an edit",
      "type": "boolean"
    },
    "isProgressive": {
      "description": "The file is a progressively encoded JPEG",
      "type": "boolean"
    },
    "isTransparent": {
      "description": "The file is transparent",
      "type": "boolean"
    },
    "path": {
      "description": "File path",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetFileType"
    },
    "updatedAt": {
      "description": "Update date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "id",
    "isEdited",
    "isProgressive",
    "isTransparent",
    "path",
    "type",
    "updatedAt"
  ],
  "type": "object"
}
```

## AssetFileType


```json
{
  "description": "Type of file",
  "enum": [
    "fullsize",
    "preview",
    "hdr_preview",
    "hdr_fullsize",
    "thumbnail",
    "sidecar",
    "encoded_video"
  ],
  "type": "string"
}
```

## AssetIdErrorReason


```json
{
  "description": "Error reason if failed",
  "enum": [
    "duplicate",
    "no_permission",
    "not_found"
  ],
  "type": "string"
}
```

## AssetIdsDto


```json
{
  "properties": {
    "assetIds": {
      "description": "Asset IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "assetIds"
  ],
  "type": "object"
}
```

## AssetIdsResponseDto

Related models: [AssetIdErrorReason](models-05.md#assetiderrorreason).

```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "error": {
      "$ref": "#/components/schemas/AssetIdErrorReason"
    },
    "success": {
      "description": "Whether operation succeeded",
      "type": "boolean"
    }
  },
  "required": [
    "assetId",
    "success"
  ],
  "type": "object"
}
```

## AssetImageEnrichmentAction


```json
{
  "description": "Image enrichment repair action",
  "enum": [
    "rerun-image-description",
    "rerun-nsfw-detection",
    "accept-nsfw-result",
    "mark-nsfw",
    "mark-safe",
    "clear-generated-description",
    "clear-generated-tags"
  ],
  "type": "string"
}
```

## AssetImageEnrichmentActionRequestDto

Related models: [AssetImageEnrichmentAction](models-05.md#assetimageenrichmentaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/AssetImageEnrichmentAction"
    }
  },
  "required": [
    "action"
  ],
  "type": "object"
}
```

## AssetImageEnrichmentResponseDto

Related models: [ImageDescriptionEnrichmentResponseDto](models-14.md#imagedescriptionenrichmentresponsedto), [NsfwDetectionEnrichmentResponseDto](models-18.md#nsfwdetectionenrichmentresponsedto).

```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "type": "string"
    },
    "description": {
      "$ref": "#/components/schemas/ImageDescriptionEnrichmentResponseDto"
    },
    "nsfwDetection": {
      "$ref": "#/components/schemas/NsfwDetectionEnrichmentResponseDto"
    }
  },
  "required": [
    "assetId",
    "description",
    "nsfwDetection"
  ],
  "type": "object"
}
```

## AssetJobName


```json
{
  "description": "Job name",
  "enum": [
    "refresh-faces",
    "refresh-metadata",
    "refresh-ocr",
    "regenerate-thumbnail",
    "transcode-video"
  ],
  "type": "string"
}
```

## AssetJobsDto

Related models: [AssetJobName](models-05.md#assetjobname).

```json
{
  "properties": {
    "assetIds": {
      "description": "Asset IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "name": {
      "$ref": "#/components/schemas/AssetJobName"
    }
  },
  "required": [
    "assetIds",
    "name"
  ],
  "type": "object"
}
```

## AssetLockReason


```json
{
  "description": "Why an asset is locked",
  "enum": [
    "marked",
    "detected",
    "immich-locked-folder"
  ],
  "type": "string"
}
```

## AssetMediaCreateDto

Related models: [AssetMetadataUpsertItemDto](models-05.md#assetmetadataupsertitemdto), [AssetVisibility](models-06.md#assetvisibility).

```json
{
  "properties": {
    "assetData": {
      "description": "Asset file data",
      "format": "binary",
      "type": "string"
    },
    "duration": {
      "description": "Duration in milliseconds (for videos)",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "fileCreatedAt": {
      "description": "File creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "fileModifiedAt": {
      "description": "File modification date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "filename": {
      "description": "Filename",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "livePhotoVideoId": {
      "description": "Live photo video ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "metadata": {
      "description": "Asset metadata items",
      "items": {
        "$ref": "#/components/schemas/AssetMetadataUpsertItemDto"
      },
      "type": "array"
    },
    "sidecarData": {
      "description": "Sidecar file data",
      "format": "binary",
      "type": "string"
    },
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility"
    }
  },
  "required": [
    "assetData",
    "fileCreatedAt",
    "fileModifiedAt"
  ],
  "type": "object"
}
```

## AssetMediaResponseDto

Related models: [AssetMediaStatus](models-05.md#assetmediastatus).

```json
{
  "properties": {
    "id": {
      "description": "Asset media ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/AssetMediaStatus"
    }
  },
  "required": [
    "id",
    "status"
  ],
  "type": "object"
}
```

## AssetMediaSize


```json
{
  "description": "Asset media size",
  "enum": [
    "original",
    "fullsize",
    "preview",
    "thumbnail"
  ],
  "type": "string"
}
```

## AssetMediaStatus


```json
{
  "description": "Upload status",
  "enum": [
    "created",
    "duplicate"
  ],
  "type": "string"
}
```

## AssetMetadataBulkDeleteDto

Related models: [AssetMetadataBulkDeleteItemDto](models-05.md#assetmetadatabulkdeleteitemdto).

```json
{
  "properties": {
    "items": {
      "description": "Metadata items to delete",
      "items": {
        "$ref": "#/components/schemas/AssetMetadataBulkDeleteItemDto"
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

## AssetMetadataBulkDeleteItemDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "key": {
      "description": "Metadata key",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "key"
  ],
  "type": "object"
}
```

## AssetMetadataBulkResponseDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "key": {
      "description": "Metadata key",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "value": {
      "additionalProperties": {},
      "description": "Metadata value (object)",
      "type": "object"
    }
  },
  "required": [
    "assetId",
    "key",
    "updatedAt",
    "value"
  ],
  "type": "object"
}
```

## AssetMetadataBulkUpsertDto

Related models: [AssetMetadataBulkUpsertItemDto](models-05.md#assetmetadatabulkupsertitemdto).

```json
{
  "properties": {
    "items": {
      "description": "Metadata items to upsert",
      "items": {
        "$ref": "#/components/schemas/AssetMetadataBulkUpsertItemDto"
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

## AssetMetadataBulkUpsertItemDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "key": {
      "description": "Metadata key",
      "type": "string"
    },
    "value": {
      "additionalProperties": {},
      "description": "Metadata value (object)",
      "type": "object"
    }
  },
  "required": [
    "assetId",
    "key",
    "value"
  ],
  "type": "object"
}
```

## AssetMetadataResponseDto


```json
{
  "properties": {
    "key": {
      "description": "Metadata key",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "value": {
      "additionalProperties": {},
      "description": "Metadata value (object)",
      "type": "object"
    }
  },
  "required": [
    "key",
    "updatedAt",
    "value"
  ],
  "type": "object"
}
```

## AssetMetadataUpsertDto

Related models: [AssetMetadataUpsertItemDto](models-05.md#assetmetadataupsertitemdto).

```json
{
  "properties": {
    "items": {
      "description": "Metadata items to upsert",
      "items": {
        "$ref": "#/components/schemas/AssetMetadataUpsertItemDto"
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

## AssetMetadataUpsertItemDto


```json
{
  "properties": {
    "key": {
      "description": "Metadata key",
      "type": "string"
    },
    "value": {
      "additionalProperties": {},
      "description": "Metadata value (object)",
      "type": "object"
    }
  },
  "required": [
    "key",
    "value"
  ],
  "type": "object"
}
```

## AssetOcrResponseDto


```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boxScore": {
      "description": "Confidence score for text detection box",
      "format": "double",
      "type": "number"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "text": {
      "description": "Recognized text",
      "type": "string"
    },
    "textScore": {
      "description": "Confidence score for text recognition",
      "format": "double",
      "type": "number"
    },
    "x1": {
      "description": "Normalized x coordinate of box corner 1 (0-1)",
      "format": "double",
      "type": "number"
    },
    "x2": {
      "description": "Normalized x coordinate of box corner 2 (0-1)",
      "format": "double",
      "type": "number"
    },
    "x3": {
      "description": "Normalized x coordinate of box corner 3 (0-1)",
      "format": "double",
      "type": "number"
    },
    "x4": {
      "description": "Normalized x coordinate of box corner 4 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y1": {
      "description": "Normalized y coordinate of box corner 1 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y2": {
      "description": "Normalized y coordinate of box corner 2 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y3": {
      "description": "Normalized y coordinate of box corner 3 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y4": {
      "description": "Normalized y coordinate of box corner 4 (0-1)",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "assetId",
    "boxScore",
    "id",
    "text",
    "textScore",
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

## AssetOrder


```json
{
  "description": "Asset sort order",
  "enum": [
    "asc",
    "desc"
  ],
  "type": "string"
}
```

## AssetOrderBy


```json
{
  "description": "Asset sorting property",
  "enum": [
    "takenAt",
    "createdAt"
  ],
  "type": "string"
}
```

## AssetRejectReason


```json
{
  "description": "Rejection reason if rejected",
  "enum": [
    "duplicate",
    "unsupported-format"
  ],
  "type": "string"
}
```
