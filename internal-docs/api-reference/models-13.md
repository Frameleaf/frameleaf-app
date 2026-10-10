# Server API models 13

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## HdrAssetDevelopRecipeV5

Related models: [AssetDevelopCleanup](models-04.md#assetdevelopcleanup), [AssetDevelopMask](models-04.md#assetdevelopmask), [AssetDevelopPerspective](models-04.md#assetdevelopperspective), [AssetDevelopPreset](models-04.md#assetdeveloppreset), [KnownAssetDevelopCrop](models-15.md#knownassetdevelopcrop).

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

## HdrAssetDevelopRecipeV6

Related models: [AssetDevelopCleanup](models-04.md#assetdevelopcleanup), [AssetDevelopMask](models-04.md#assetdevelopmask), [AssetDevelopPerspective](models-04.md#assetdevelopperspective), [AssetDevelopPreset](models-04.md#assetdeveloppreset), [KnownAssetDevelopCrop](models-15.md#knownassetdevelopcrop).

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
          "default": "libultrahdr/2.0.2-frameleaf.4",
          "enum": [
            "libultrahdr/2.0.2-frameleaf.4"
          ],
          "type": "string"
        },
        "version": {
          "default": 4,
          "enum": [
            4
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
      "default": "frameleaf-develop-hdr/4",
      "enum": [
        "frameleaf-develop-hdr/4"
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
        6
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

Related models: [ICloudAttachState](models-13.md#icloudattachstate).

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

Related models: [ICloudAttachItemDto](models-13.md#icloudattachitemdto).

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

Related models: [ICloudIdentityRole](models-14.md#icloudidentityrole).

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

Related models: [ICloudAttachAnswerDto](models-13.md#icloudattachanswerdto).

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

Related models: [ICloudAuthAction](models-13.md#icloudauthaction).

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

Related models: [ICloudClaimHolder](models-13.md#icloudclaimholder), [ICloudClaimState](models-13.md#icloudclaimstate).

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

Related models: [ICloudClaimItemDto](models-13.md#icloudclaimitemdto).

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

Related models: [ICloudClaimRenewedDto](models-13.md#icloudclaimreneweddto).

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

Related models: [ICloudClaimAnswerDto](models-13.md#icloudclaimanswerdto).

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

Related models: [ICloudSyncRunDto](models-14.md#icloudsyncrundto).

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

## ICloudConnectionsResponseDto

Related models: [ICloudConnectionResponseDto](models-13.md#icloudconnectionresponsedto).

```json
{
  "properties": {
    "connections": {
      "items": {
        "$ref": "#/components/schemas/ICloudConnectionResponseDto"
      },
      "type": "array"
    },
    "enabled": {
      "type": "boolean"
    }
  },
  "required": [
    "connections",
    "enabled"
  ],
  "type": "object"
}
```

## ICloudControlAction


```json
{
  "enum": [
    "run",
    "pause",
    "resume",
    "cancel",
    "rescan",
    "retry"
  ],
  "type": "string"
}
```

## ICloudControlDto

Related models: [ICloudControlAction](models-13.md#icloudcontrolaction).

```json
{
  "additionalProperties": false,
  "properties": {
    "action": {
      "$ref": "#/components/schemas/ICloudControlAction"
    }
  },
  "required": [
    "action"
  ],
  "type": "object"
}
```

## ICloudCoverageConnectionDto

Related models: [ICloudConnectionHealth](models-13.md#icloudconnectionhealth), [ICloudCoverageScopeKind](models-13.md#icloudcoveragescopekind).

```json
{
  "properties": {
    "account": {
      "description": "The Apple Account, masked (a•••@icloud.com); null until it signs in again",
      "nullable": true,
      "type": "string"
    },
    "connectionId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "covers": {
      "description": "At least 20 samples and 95 % of them matched: this connection covers the device library",
      "type": "boolean"
    },
    "includeEdits": {
      "type": "boolean"
    },
    "label": {
      "type": "string"
    },
    "lastCompleteInventoryAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "matched": {
      "description": "Of those, matched in the inventory as corroborated or better",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "nextRunAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "sampled": {
      "description": "Samples that existed before the last complete inventory",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "scope": {
      "properties": {
        "albums": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "kind": {
          "$ref": "#/components/schemas/ICloudCoverageScopeKind"
        },
        "libraries": {
          "description": "Library zones; empty means every supported library",
          "items": {
            "type": "string"
          },
          "type": "array"
        }
      },
      "required": [
        "kind",
        "libraries",
        "albums"
      ],
      "type": "object"
    },
    "state": {
      "$ref": "#/components/schemas/ICloudConnectionHealth"
    },
    "unhealthySince": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "account",
    "connectionId",
    "covers",
    "includeEdits",
    "label",
    "lastCompleteInventoryAt",
    "matched",
    "nextRunAt",
    "sampled",
    "scope",
    "state",
    "unhealthySince"
  ],
  "type": "object"
}
```

## ICloudCoverageDto

Related models: [ICloudCoverageSampleDto](models-13.md#icloudcoveragesampledto).

```json
{
  "properties": {
    "deviceKey": {
      "description": "This device's backup identity (the backup device registry's deviceKey)",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "samples": {
      "description": "Sampled items: some old, some recent, some in albums",
      "items": {
        "$ref": "#/components/schemas/ICloudCoverageSampleDto"
      },
      "maxItems": 200,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "deviceKey",
    "samples"
  ],
  "type": "object"
}
```

## ICloudCoverageResponseDto

Related models: [ICloudCoverageConnectionDto](models-13.md#icloudcoverageconnectiondto).

```json
{
  "properties": {
    "connections": {
      "items": {
        "$ref": "#/components/schemas/ICloudCoverageConnectionDto"
      },
      "type": "array"
    },
    "identityMatching": {
      "description": "False when identity matching is switched off: no connection can then be shown to cover the library",
      "type": "boolean"
    }
  },
  "required": [
    "connections",
    "identityMatching"
  ],
  "type": "object"
}
```

## ICloudCoverageSampleDto


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
    "cloudIdentifier"
  ],
  "type": "object"
}
```

## ICloudCoverageScopeKind


```json
{
  "description": "Whole libraries, or only some albums",
  "enum": [
    "libraries",
    "albums"
  ],
  "type": "string"
}
```

## ICloudEditBaselineDto

Related models: [ICloudEditDeviceHolderKind](models-13.md#icloudeditdeviceholderkind), [ICloudEditOriginalRevertKind](models-14.md#icloudeditoriginalrevertkind), [ICloudEditRetentionPolicy](models-14.md#icloudeditretentionpolicy), [ICloudEditSyncHolderKind](models-14.md#icloudeditsyncholderkind).

```json
{
  "additionalProperties": false,
  "properties": {
    "expectedGeneration": {
      "maximum": 2147483646,
      "minimum": 0,
      "type": "integer"
    },
    "holder": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "$ref": "#/components/schemas/ICloudEditDeviceHolderKind"
            },
            "id": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            }
          },
          "required": [
            "kind",
            "id"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "$ref": "#/components/schemas/ICloudEditSyncHolderKind"
            },
            "id": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            }
          },
          "required": [
            "kind",
            "id"
          ],
          "additionalProperties": false
        }
      ]
    },
    "intent": {
      "description": "Explicit local original-primary policy transition, separate from administrative baseline acceptance; binds the current immutable publication and explicit retention choice",
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "$ref": "#/components/schemas/ICloudEditOriginalRevertKind"
            },
            "expectedPublicationId": {
              "type": "string",
              "format": "uuid",
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
            },
            "retention": {
              "$ref": "#/components/schemas/ICloudEditRetentionPolicy"
            }
          },
          "required": [
            "kind",
            "expectedPublicationId",
            "retention"
          ],
          "additionalProperties": false
        }
      ]
    },
    "nativeVersion": {
      "maxLength": 256,
      "minLength": 1,
      "type": "string"
    },
    "receiptId": {
      "description": "An accessible owned stored source identity with verified current asset digest",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "requestId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "sourceIncarnation": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "takeOver": {
      "default": false,
      "description": "Only bypasses the 72-hour wait for an unhealthy source",
      "type": "boolean"
    }
  },
  "required": [
    "expectedGeneration",
    "holder",
    "nativeVersion",
    "receiptId",
    "requestId",
    "sourceIncarnation"
  ],
  "type": "object"
}
```

## ICloudEditDecisionResponseDto


```json
{
  "properties": {
    "decisionId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "evidenceType": {
      "enum": [
        "administrative"
      ],
      "type": "string"
    },
    "generation": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "versionId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "decisionId",
    "evidenceType",
    "generation",
    "versionId"
  ],
  "type": "object"
}
```

## ICloudEditDeviceHolderKind


```json
{
  "enum": [
    "device"
  ],
  "type": "string"
}
```
