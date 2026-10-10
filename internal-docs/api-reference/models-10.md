# Server API models 10

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## ConfigFileActivationResponseDto


```json
{
  "additionalProperties": false,
  "properties": {
    "epoch": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "sourceKind": {
      "enum": [
        "file"
      ],
      "type": "string"
    }
  },
  "required": [
    "epoch",
    "sourceKind"
  ],
  "type": "object"
}
```

## ConfigFileReloadDto


```json
{
  "additionalProperties": false,
  "properties": {
    "expectedEpoch": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "expectedEpoch"
  ],
  "type": "object"
}
```

## ContributorCountResponseDto


```json
{
  "properties": {
    "assetCount": {
      "description": "Number of assets contributed",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetCount",
    "userId"
  ],
  "type": "object"
}
```

## CreateAlbumDto

Related models: [AlbumKind](models-02.md#albumkind), [AlbumUserCreateDto](models-02.md#albumusercreatedto).

```json
{
  "properties": {
    "albumName": {
      "description": "Album name",
      "type": "string"
    },
    "albumUsers": {
      "description": "Album users",
      "items": {
        "$ref": "#/components/schemas/AlbumUserCreateDto"
      },
      "type": "array"
    },
    "assetIds": {
      "description": "Initial asset IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "description": {
      "description": "Album description",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v3",
          "state": "Updated",
          "description": "Sending an empty string is deprecated; send null instead. Empty strings will no longer be coerced to null in v4."
        }
      ]
    },
    "icon": {
      "description": "Optional icon: any Material Design Icons name (see GET /albums/icons)",
      "maxLength": 80,
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/AlbumKind",
      "default": "album",
      "description": "What to create: an album (default), a collection of albums or a shared space"
    },
    "parentId": {
      "description": "Collection to create the album inside (omit for top-level). Only albums nest, and only inside a collection.",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumName"
  ],
  "type": "object"
}
```

## CreateLibraryDto


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
      "description": "Import paths (max 128)",
      "items": {
        "maxLength": 1024,
        "type": "string"
      },
      "maxItems": 128,
      "type": "array"
    },
    "name": {
      "description": "Library name",
      "maxLength": 160,
      "minLength": 1,
      "type": "string"
    },
    "ownerId": {
      "description": "Owner user ID. Fixed once the library exists.",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "ownerId"
  ],
  "type": "object"
}
```

## CreateProfileImageDto


```json
{
  "properties": {
    "assetId": {
      "description": "ID of the photo the image was copied from, if any. A Locked photo is refused.",
      "format": "uuid",
      "type": "string"
    },
    "file": {
      "description": "Profile image file",
      "format": "binary",
      "type": "string"
    },
    "keepSource": {
      "description": "The image is a new crop of the current profile picture: keep the photo it was copied from, if any. Ignored when assetId is set.",
      "type": "boolean"
    }
  },
  "required": [
    "file"
  ],
  "type": "object"
}
```

## CreateProfileImageResponseDto


```json
{
  "properties": {
    "profileChangedAt": {
      "description": "Profile image change date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "profileImagePath": {
      "description": "Profile image file path",
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
    "profileChangedAt",
    "profileImagePath",
    "userId"
  ],
  "type": "object"
}
```

## CropParameters


```json
{
  "properties": {
    "height": {
      "description": "Height of the crop",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "width": {
      "description": "Width of the crop",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "x": {
      "description": "Top-Left X coordinate of crop",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "y": {
      "description": "Top-Left Y coordinate of crop",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "height",
    "width",
    "x",
    "y"
  ],
  "type": "object"
}
```

## DarktableDevelopRecipe

Related models: [AssetDevelopMaskKind](models-04.md#assetdevelopmaskkind).

```json
{
  "additionalProperties": false,
  "properties": {
    "contrast": {
      "format": "double",
      "maximum": 1.99,
      "minimum": 0.01,
      "type": "number"
    },
    "crop": {
      "additionalProperties": false,
      "properties": {
        "h": {
          "description": "Crop height as a fraction of the frame",
          "format": "double",
          "maximum": 1,
          "minimum": 0.05,
          "type": "number"
        },
        "w": {
          "description": "Crop width as a fraction of the frame",
          "format": "double",
          "maximum": 1,
          "minimum": 0.05,
          "type": "number"
        },
        "x": {
          "description": "Left edge of the crop as a fraction of the oriented frame width",
          "format": "double",
          "maximum": 1,
          "minimum": 0,
          "type": "number"
        },
        "y": {
          "description": "Top edge of the crop as a fraction of the oriented frame height",
          "format": "double",
          "maximum": 1,
          "minimum": 0,
          "type": "number"
        }
      },
      "required": [
        "x",
        "y",
        "w",
        "h"
      ],
      "type": "object"
    },
    "curve": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "x": {
            "description": "Input",
            "format": "double",
            "maximum": 1,
            "minimum": 0,
            "type": "number"
          },
          "y": {
            "description": "Output",
            "format": "double",
            "maximum": 1,
            "minimum": 0,
            "type": "number"
          }
        },
        "required": [
          "x",
          "y"
        ],
        "type": "object"
      },
      "maxItems": 20,
      "minItems": 2,
      "type": "array"
    },
    "exposureEV": {
      "default": 0,
      "format": "double",
      "maximum": 18,
      "minimum": -18,
      "type": "number"
    },
    "flipHorizontal": {
      "type": "boolean"
    },
    "flipVertical": {
      "type": "boolean"
    },
    "highlights": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "lensCorrection": {
      "description": "Use native embedded metadata or Lensfun; refuse absent calibration",
      "type": "boolean"
    },
    "masks": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "adjustments": {
            "additionalProperties": false,
            "properties": {
              "contrast": {
                "format": "double",
                "maximum": 1.99,
                "minimum": 0.01,
                "type": "number"
              },
              "curve": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "x": {
                      "description": "Input",
                      "format": "double",
                      "maximum": 1,
                      "minimum": 0,
                      "type": "number"
                    },
                    "y": {
                      "description": "Output",
                      "format": "double",
                      "maximum": 1,
                      "minimum": 0,
                      "type": "number"
                    }
                  },
                  "required": [
                    "x",
                    "y"
                  ],
                  "type": "object"
                },
                "maxItems": 20,
                "minItems": 2,
                "type": "array"
              },
              "exposureEV": {
                "default": 0,
                "format": "double",
                "maximum": 18,
                "minimum": -18,
                "type": "number"
              },
              "highlights": {
                "format": "double",
                "maximum": 100,
                "minimum": -100,
                "type": "number"
              },
              "saturation": {
                "format": "double",
                "maximum": 2,
                "minimum": 0,
                "type": "number"
              },
              "shadows": {
                "format": "double",
                "maximum": 100,
                "minimum": -100,
                "type": "number"
              }
            },
            "type": "object"
          },
          "amount": {
            "default": 100,
            "description": "How much of the adjustment is applied, as a percentage",
            "maximum": 100,
            "minimum": 0,
            "type": "integer"
          },
          "artifact": {
            "description": "Subject, sky and background masks: the stored greyscale mask bitmap, covering the whole original image",
            "nullable": true,
            "pattern": "^[0-9a-f]{64}$",
            "type": "string"
          },
          "coordinates": {
            "enum": [
              "sensor-active"
            ],
            "type": "string"
          },
          "enabled": {
            "default": true,
            "description": "A disabled mask is kept but not rendered",
            "type": "boolean"
          },
          "endX": {
            "default": 0.5,
            "description": "Where a linear mask has faded out, across the frame",
            "format": "double",
            "maximum": 1,
            "minimum": 0,
            "type": "number"
          },
          "endY": {
            "default": 1,
            "description": "Where a linear mask has faded out, down the frame",
            "format": "double",
            "maximum": 1,
            "minimum": 0,
            "type": "number"
          },
          "feather": {
            "default": 50,
            "description": "Softness of a radial edge as a percentage of the radius, or of a brush stroke as one of its radius",
            "maximum": 100,
            "minimum": 0,
            "type": "integer"
          },
          "id": {
            "description": "Client-chosen identifier, unique within the recipe",
            "maxLength": 40,
            "minLength": 1,
            "type": "string"
          },
          "invert": {
            "default": false,
            "description": "Apply the adjustment outside the shape instead of inside",
            "type": "boolean"
          },
          "kind": {
            "$ref": "#/components/schemas/AssetDevelopMaskKind"
          },
          "name": {
            "default": null,
            "description": "Optional name shown in the editor",
            "maxLength": 60,
            "minLength": 1,
            "nullable": true,
            "type": "string"
          },
          "radiusX": {
            "default": 0.25,
            "description": "Horizontal radius of a radial mask as a fraction of the frame width",
            "format": "double",
            "maximum": 1,
            "minimum": 0.01,
            "type": "number"
          },
          "radiusY": {
            "default": 0.25,
            "description": "Vertical radius of a radial mask as a fraction of the frame height",
            "format": "double",
            "maximum": 1,
            "minimum": 0.01,
            "type": "number"
          },
          "strokes": {
            "items": {
              "additionalProperties": false,
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
            },
            "maxItems": 64,
            "type": "array"
          },
          "x": {
            "description": "Centre (radial) or start (linear) across the oriented frame; any value for brush and bitmap masks",
            "format": "double",
            "maximum": 1,
            "minimum": 0,
            "type": "number"
          },
          "y": {
            "description": "Centre (radial) or start (linear) down the oriented frame; any value for brush and bitmap masks",
            "format": "double",
            "maximum": 1,
            "minimum": 0,
            "type": "number"
          }
        },
        "required": [
          "id",
          "kind",
          "x",
          "y",
          "coordinates",
          "adjustments"
        ],
        "type": "object"
      },
      "maxItems": 8,
      "type": "array"
    },
    "noiseThreshold": {
      "description": "Native pre-demosaic wavelet noise threshold",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "renderer": {
      "enum": [
        "darktable/5.6.1"
      ],
      "type": "string"
    },
    "rotation": {
      "anyOf": [
        {
          "type": "integer",
          "format": "int32",
          "enum": [
            0
          ]
        },
        {
          "type": "integer",
          "format": "int32",
          "enum": [
            90
          ]
        },
        {
          "type": "integer",
          "format": "int32",
          "enum": [
            180
          ]
        },
        {
          "type": "integer",
          "format": "int32",
          "enum": [
            270
          ]
        }
      ],
      "description": "Additional clockwise rotation after camera orientation"
    },
    "saturation": {
      "format": "double",
      "maximum": 2,
      "minimum": 0,
      "type": "number"
    },
    "sensorCanvas": {
      "description": "Unrotated, uncropped, uncorrected canvas for selecting sensor-space masks",
      "type": "boolean"
    },
    "shadows": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "sharpen": {
      "additionalProperties": false,
      "properties": {
        "amount": {
          "format": "double",
          "maximum": 2,
          "minimum": 0,
          "type": "number"
        },
        "radius": {
          "format": "double",
          "maximum": 99,
          "minimum": 0,
          "type": "number"
        },
        "threshold": {
          "format": "double",
          "maximum": 100,
          "minimum": 0,
          "type": "number"
        }
      },
      "required": [
        "radius",
        "amount",
        "threshold"
      ],
      "type": "object"
    },
    "straighten": {
      "format": "double",
      "maximum": 45,
      "minimum": -45,
      "type": "number"
    },
    "version": {
      "enum": [
        2
      ],
      "format": "int32",
      "type": "integer"
    },
    "whiteBalance": {
      "additionalProperties": false,
      "description": "Multipliers of native camera white-balance coefficients, not Kelvin estimates",
      "properties": {
        "blue": {
          "format": "double",
          "maximum": 8,
          "minimum": 0.1,
          "type": "number"
        },
        "green": {
          "format": "double",
          "maximum": 8,
          "minimum": 0.1,
          "type": "number"
        },
        "red": {
          "format": "double",
          "maximum": 8,
          "minimum": 0.1,
          "type": "number"
        }
      },
      "required": [
        "red",
        "green",
        "blue"
      ],
      "type": "object"
    }
  },
  "required": [
    "renderer",
    "version"
  ],
  "type": "object"
}
```

## DatabaseBackupDeleteDto


```json
{
  "properties": {
    "backups": {
      "description": "Backup filenames to delete",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "backups"
  ],
  "type": "object"
}
```

## DatabaseBackupDto


```json
{
  "properties": {
    "filename": {
      "description": "Backup filename",
      "type": "string"
    },
    "filesize": {
      "description": "Backup file size",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "timezone": {
      "description": "Backup timezone",
      "type": "string"
    }
  },
  "required": [
    "filename",
    "filesize",
    "timezone"
  ],
  "type": "object"
}
```

## DatabaseBackupListResponseDto

Related models: [DatabaseBackupDto](models-10.md#databasebackupdto).

```json
{
  "properties": {
    "backups": {
      "description": "List of backups",
      "items": {
        "$ref": "#/components/schemas/DatabaseBackupDto"
      },
      "type": "array"
    }
  },
  "required": [
    "backups"
  ],
  "type": "object"
}
```

## DatabaseBackupUploadDto


```json
{
  "properties": {
    "file": {
      "description": "Database backup file",
      "format": "binary",
      "type": "string"
    }
  },
  "type": "object"
}
```

## DateFilter


```json
{
  "properties": {
    "eq": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "gt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "gte": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "lt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "lte": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "ne": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## DateFilterNullable


```json
{
  "properties": {
    "eq": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "gt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "gte": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "lt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "lte": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "ne": {
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

## DecodeRefusal


```json
{
  "description": "FL-101: why this server cannot decode a video source",
  "enum": [
    "dolbyVisionProfile5",
    "dolbyVisionEnhancementLayer",
    "dolbyVisionProfileUnqualified",
    "dolbyVisionBaseLayerUnknown",
    "unknownPixelFormat",
    "unsupportedBitDepth",
    "unusableGeometry"
  ],
  "type": "string"
}
```

## DevelopExportResponseDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset whose original was exported",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "createdAt": {
      "description": "When the original was exported",
      "format": "date-time",
      "type": "string"
    },
    "fileName": {
      "description": "File name of the exported original",
      "type": "string"
    },
    "id": {
      "description": "Export ID; quote it when bringing the developed file back",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isCurrentOriginal": {
      "description": "False once the asset original no longer matches the exported bytes; a return is then refused",
      "type": "boolean"
    },
    "sourceChecksum": {
      "description": "SHA-256 (hex) of the original when it was exported",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "createdAt",
    "fileName",
    "id",
    "isCurrentOriginal",
    "sourceChecksum"
  ],
  "type": "object"
}
```

## DevelopPresetCreateDto

Related models: [DevelopPresetSettingsDto](models-10.md#developpresetsettingsdto).

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
      "$ref": "#/components/schemas/DevelopPresetSettingsDto",
      "description": "Settings of the new preset; any left out take their neutral value"
    }
  },
  "required": [
    "name",
    "settings"
  ],
  "type": "object"
}
```

## DevelopPresetMask

Related models: [AssetDevelopMaskAdjustments](models-04.md#assetdevelopmaskadjustments), [DevelopPresetMaskKind](models-10.md#developpresetmaskkind).

```json
{
  "properties": {
    "adjustments": {
      "$ref": "#/components/schemas/AssetDevelopMaskAdjustments",
      "default": {
        "blacks": 0,
        "contrast": 0,
        "dehaze": 0,
        "exposure": 0,
        "highlights": 0,
        "saturation": 0,
        "shadows": 0,
        "temperature": 0,
        "tint": 0,
        "vibrance": 0,
        "whites": 0
      }
    },
    "amount": {
      "default": 100,
      "description": "How much of the adjustment is applied, as a percentage",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "enabled": {
      "default": true,
      "description": "A disabled mask is kept but not rendered",
      "type": "boolean"
    },
    "endX": {
      "default": 0.5,
      "description": "Where a linear mask has faded out, across the frame",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "endY": {
      "default": 1,
      "description": "Where a linear mask has faded out, down the frame",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "feather": {
      "default": 50,
      "description": "Softness of a radial edge as a percentage of the radius, or of a brush stroke as one of its radius",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "id": {
      "description": "Client-chosen identifier, unique within the recipe",
      "maxLength": 40,
      "minLength": 1,
      "type": "string"
    },
    "invert": {
      "default": false,
      "description": "Apply the adjustment outside the shape instead of inside",
      "type": "boolean"
    },
    "kind": {
      "$ref": "#/components/schemas/DevelopPresetMaskKind"
    },
    "name": {
      "default": null,
      "description": "Optional name shown in the editor",
      "maxLength": 60,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "radiusX": {
      "default": 0.25,
      "description": "Horizontal radius of a radial mask as a fraction of the frame width",
      "format": "double",
      "maximum": 1,
      "minimum": 0.01,
      "type": "number"
    },
    "radiusY": {
      "default": 0.25,
      "description": "Vertical radius of a radial mask as a fraction of the frame height",
      "format": "double",
      "maximum": 1,
      "minimum": 0.01,
      "type": "number"
    },
    "x": {
      "description": "Centre (radial) or start (linear) across the oriented frame; any value for brush and bitmap masks",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "y": {
      "description": "Centre (radial) or start (linear) down the oriented frame; any value for brush and bitmap masks",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "required": [
    "id",
    "kind",
    "x",
    "y"
  ],
  "type": "object"
}
```

## DevelopPresetMaskKind


```json
{
  "description": "Shape of a selective adjustment mask",
  "enum": [
    "radial",
    "linear"
  ],
  "type": "string"
}
```

## DevelopPresetResponseDto

Related models: [DevelopPresetSettingsDto](models-10.md#developpresetsettingsdto).

```json
{
  "properties": {
    "createdAt": {
      "description": "When the preset was saved",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Preset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "Preset name",
      "type": "string"
    },
    "settings": {
      "$ref": "#/components/schemas/DevelopPresetSettingsDto"
    },
    "updatedAt": {
      "description": "When the preset last changed",
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "id",
    "name",
    "settings",
    "updatedAt"
  ],
  "type": "object"
}
```

## DevelopPresetSettingsDto

Related models: [AssetDevelopPreset](models-04.md#assetdeveloppreset), [DarktableDevelopRecipe](models-10.md#darktabledeveloprecipe), [DevelopPresetMask](models-10.md#developpresetmask).

```json
{
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
    "contrast": {
      "default": 0,
      "description": "Contrast around middle grey",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
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
    "grain": {
      "default": 0,
      "description": "Film grain amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
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
  "type": "object"
}
```

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
      "description": "FL-233: opens the shadows and holds back the highlights (positive), or the reverse (negative), with a slight colour lift; see the develop recipe protocol",
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

Related models: [DevelopPresetSettingsUpdateDto](models-10.md#developpresetsettingsupdatedto).

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

Related models: [DocumentEditAction](models-10.md#documenteditaction).

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

Related models: [DocumentField](models-10.md#documentfield), [DocumentFieldCandidateDto](models-10.md#documentfieldcandidatedto), [DocumentFieldStatus](models-10.md#documentfieldstatus), [DocumentRegionDto](models-11.md#documentregiondto).

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

Related models: [DocumentLineStatus](models-10.md#documentlinestatus), [DocumentRegionDto](models-11.md#documentregiondto).

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

Related models: [DocumentEditAction](models-10.md#documenteditaction).

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
