# Server API models 34

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## SyncAssetExifV1

Related models: [ImageEncodingInfo](models-13.md#imageencodinginfo).

```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "city": {
      "description": "City",
      "nullable": true,
      "type": "string"
    },
    "country": {
      "description": "Country",
      "nullable": true,
      "type": "string"
    },
    "dateTimeOriginal": {
      "description": "Date time original",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "description": {
      "description": "Description",
      "nullable": true,
      "type": "string"
    },
    "exifImageHeight": {
      "description": "Exif image height",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "exifImageWidth": {
      "description": "Exif image width",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "exposureTime": {
      "description": "Exposure time",
      "nullable": true,
      "type": "string"
    },
    "fNumber": {
      "description": "F number",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "fileSizeInByte": {
      "description": "File size in byte",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "focalLength": {
      "description": "Focal length",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "fps": {
      "description": "FPS",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "imageEncoding": {
      "allOf": [
        {
          "$ref": "#/components/schemas/ImageEncodingInfo"
        }
      ],
      "nullable": true
    },
    "iso": {
      "description": "ISO",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "latitude": {
      "description": "Latitude",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "lensModel": {
      "description": "Lens model",
      "nullable": true,
      "type": "string"
    },
    "longitude": {
      "description": "Longitude",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "make": {
      "description": "Make",
      "nullable": true,
      "type": "string"
    },
    "model": {
      "description": "Model",
      "nullable": true,
      "type": "string"
    },
    "modifyDate": {
      "description": "Modify date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "orientation": {
      "description": "Orientation",
      "nullable": true,
      "type": "string"
    },
    "profileDescription": {
      "description": "Profile description",
      "nullable": true,
      "type": "string"
    },
    "projectionType": {
      "description": "Projection type",
      "nullable": true,
      "type": "string"
    },
    "rating": {
      "description": "Rating",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "state": {
      "description": "State",
      "nullable": true,
      "type": "string"
    },
    "timeZone": {
      "description": "Time zone",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "city",
    "country",
    "dateTimeOriginal",
    "description",
    "exifImageHeight",
    "exifImageWidth",
    "exposureTime",
    "fNumber",
    "fileSizeInByte",
    "focalLength",
    "fps",
    "iso",
    "latitude",
    "lensModel",
    "longitude",
    "make",
    "model",
    "modifyDate",
    "orientation",
    "profileDescription",
    "projectionType",
    "rating",
    "state",
    "timeZone"
  ],
  "type": "object"
}
```

## SyncAssetFaceDeleteV1


```json
{
  "properties": {
    "assetFaceId": {
      "description": "Asset face ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetFaceId"
  ],
  "type": "object"
}
```

## SyncAssetFaceV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boundingBoxX1": {
      "description": "Bounding box X1",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxX2": {
      "description": "Bounding box X2",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY1": {
      "description": "Bounding box Y1",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY2": {
      "description": "Bounding box Y2",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "id": {
      "description": "Asset face ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "imageHeight": {
      "description": "Image height",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Image width",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "personId": {
      "description": "Person ID",
      "nullable": true,
      "type": "string"
    },
    "sourceType": {
      "description": "Source type",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "boundingBoxX1",
    "boundingBoxX2",
    "boundingBoxY1",
    "boundingBoxY2",
    "id",
    "imageHeight",
    "imageWidth",
    "personId",
    "sourceType"
  ],
  "type": "object"
}
```

## SyncAssetFaceV2

Related models: [SyncAssetFaceV3](models-34.md#syncassetfacev3).

```json
{
  "$ref": "#/components/schemas/SyncAssetFaceV3"
}
```

## SyncAssetFaceV3


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boundingBoxX1": {
      "description": "Bounding box X1",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxX2": {
      "description": "Bounding box X2",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY1": {
      "description": "Bounding box Y1",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY2": {
      "description": "Bounding box Y2",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "deletedAt": {
      "description": "Face deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Asset face ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "imageHeight": {
      "description": "Image height",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Image width",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "isVisible": {
      "description": "Is the face visible in the asset",
      "type": "boolean"
    },
    "personId": {
      "description": "Person ID",
      "nullable": true,
      "type": "string"
    },
    "sourceType": {
      "description": "Source type",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "boundingBoxX1",
    "boundingBoxX2",
    "boundingBoxY1",
    "boundingBoxY2",
    "deletedAt",
    "id",
    "imageHeight",
    "imageWidth",
    "isVisible",
    "personId",
    "sourceType"
  ],
  "type": "object"
}
```

## SyncAssetMetadataDeleteV1


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
      "description": "Key",
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

## SyncAssetMetadataV1


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
      "description": "Key",
      "type": "string"
    },
    "value": {
      "additionalProperties": {},
      "description": "Value",
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

## SyncAssetOcrDeleteV1


```json
{
  "properties": {
    "assetId": {
      "description": "Original asset ID of the deleted OCR entry",
      "type": "string"
    },
    "deletedAt": {
      "description": "Timestamp when the OCR entry was deleted",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Audit row ID of the deleted OCR entry",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "deletedAt",
    "id"
  ],
  "type": "object"
}
```

## SyncAssetOcrV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boxScore": {
      "description": "Confidence score of the bounding box",
      "format": "double",
      "type": "number"
    },
    "id": {
      "description": "OCR entry ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isVisible": {
      "description": "Whether the OCR entry is visible",
      "type": "boolean"
    },
    "text": {
      "description": "Recognized text content",
      "type": "string"
    },
    "textScore": {
      "description": "Confidence score of the recognized text",
      "format": "double",
      "type": "number"
    },
    "x1": {
      "description": "Top-left X coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "x2": {
      "description": "Top-right X coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "x3": {
      "description": "Bottom-right X coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "x4": {
      "description": "Bottom-left X coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "y1": {
      "description": "Top-left Y coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "y2": {
      "description": "Top-right Y coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "y3": {
      "description": "Bottom-right Y coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "y4": {
      "description": "Bottom-left Y coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "assetId",
    "boxScore",
    "id",
    "isVisible",
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

## SyncAssetTagDeleteV1

Related models: [SyncAssetTagV1](models-34.md#syncassettagv1).

```json
{
  "$ref": "#/components/schemas/SyncAssetTagV1"
}
```

## SyncAssetTagV1


```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "tagId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "tagId"
  ],
  "type": "object"
}
```

## SyncAssetTrashStateDeleteV1


```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetId"
  ],
  "type": "object"
}
```

## SyncAssetTrashStateV1


```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "deletedAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "isOffline": {
      "type": "boolean"
    },
    "status": {
      "enum": [
        "active",
        "trashed",
        "deleted"
      ],
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "deletedAt",
    "isOffline",
    "status"
  ],
  "type": "object"
}
```

## SyncAssetV1

Related models: [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility).

```json
{
  "properties": {
    "checksum": {
      "description": "Checksum",
      "type": "string"
    },
    "createdAt": {
      "description": "Uploaded to Frameleaf at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "deletedAt": {
      "description": "Deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "duration": {
      "description": "Duration",
      "nullable": true,
      "type": "string"
    },
    "fileCreatedAt": {
      "description": "File created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "fileModifiedAt": {
      "description": "File modified at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "height": {
      "description": "Asset height",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "id": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isEdited": {
      "description": "Is edited",
      "type": "boolean"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean"
    },
    "libraryId": {
      "description": "Library ID",
      "nullable": true,
      "type": "string"
    },
    "livePhotoVideoId": {
      "description": "Live photo video ID",
      "nullable": true,
      "type": "string"
    },
    "localDateTime": {
      "description": "Local date time",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "originalFileName": {
      "description": "Original file name",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "stackId": {
      "description": "Stack ID",
      "nullable": true,
      "type": "string"
    },
    "thumbhash": {
      "description": "Thumbhash",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility"
    },
    "width": {
      "description": "Asset width",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "checksum",
    "createdAt",
    "deletedAt",
    "duration",
    "fileCreatedAt",
    "fileModifiedAt",
    "height",
    "id",
    "isEdited",
    "isFavorite",
    "libraryId",
    "livePhotoVideoId",
    "localDateTime",
    "originalFileName",
    "ownerId",
    "stackId",
    "thumbhash",
    "type",
    "visibility",
    "width"
  ],
  "type": "object"
}
```

## SyncAssetV2

Related models: [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility).

```json
{
  "properties": {
    "checksum": {
      "description": "Checksum",
      "type": "string"
    },
    "createdAt": {
      "description": "Uploaded to Frameleaf at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "deletedAt": {
      "description": "Deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "duration": {
      "description": "Duration",
      "maximum": 2147483647,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "fileCreatedAt": {
      "description": "File created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "fileModifiedAt": {
      "description": "File modified at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "height": {
      "description": "Asset height",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "id": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isEdited": {
      "description": "Is edited",
      "type": "boolean"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean"
    },
    "libraryId": {
      "description": "Library ID",
      "nullable": true,
      "type": "string"
    },
    "livePhotoVideoId": {
      "description": "Live photo video ID",
      "nullable": true,
      "type": "string"
    },
    "localDateTime": {
      "description": "Local date time",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "originalFileName": {
      "description": "Original file name",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "stackId": {
      "description": "Stack ID",
      "nullable": true,
      "type": "string"
    },
    "thumbhash": {
      "description": "Thumbhash",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility"
    },
    "width": {
      "description": "Asset width",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "checksum",
    "createdAt",
    "deletedAt",
    "duration",
    "fileCreatedAt",
    "fileModifiedAt",
    "height",
    "id",
    "isEdited",
    "isFavorite",
    "libraryId",
    "livePhotoVideoId",
    "localDateTime",
    "originalFileName",
    "ownerId",
    "stackId",
    "thumbhash",
    "type",
    "visibility",
    "width"
  ],
  "type": "object"
}
```

## SyncAuthUserV1

Related models: [UserAvatarColor](models-36.md#useravatarcolor).

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
    "deletedAt": {
      "description": "User deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "email": {
      "description": "User email",
      "type": "string"
    },
    "hasProfileImage": {
      "description": "User has profile image",
      "type": "boolean"
    },
    "id": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isAdmin": {
      "description": "User is admin",
      "type": "boolean"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "oauthId": {
      "description": "User OAuth ID",
      "type": "string"
    },
    "pinCode": {
      "description": "User pin code",
      "nullable": true,
      "type": "string"
    },
    "profileChangedAt": {
      "description": "User profile changed at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "quotaSizeInBytes": {
      "description": "Quota size in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "quotaUsageInBytes": {
      "description": "Quota usage in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "storageLabel": {
      "description": "User storage label",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "deletedAt",
    "email",
    "hasProfileImage",
    "id",
    "isAdmin",
    "name",
    "oauthId",
    "pinCode",
    "profileChangedAt",
    "quotaSizeInBytes",
    "quotaUsageInBytes",
    "storageLabel"
  ],
  "type": "object"
}
```

## SyncAuthUserV2

Related models: [UserAvatarColor](models-36.md#useravatarcolor).

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
    "deletedAt": {
      "description": "User deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "email": {
      "description": "User email",
      "type": "string"
    },
    "hasProfileImage": {
      "description": "User has profile image",
      "type": "boolean"
    },
    "id": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isAdmin": {
      "description": "User is admin",
      "type": "boolean"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "oauthId": {
      "description": "User OAuth ID",
      "nullable": true,
      "type": "string"
    },
    "pinCode": {
      "description": "User pin code",
      "nullable": true,
      "type": "string"
    },
    "profileChangedAt": {
      "description": "User profile changed at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "quotaSizeInBytes": {
      "description": "Quota size in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "quotaUsageInBytes": {
      "description": "Quota usage in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "storageLabel": {
      "description": "User storage label",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "deletedAt",
    "email",
    "hasProfileImage",
    "id",
    "isAdmin",
    "name",
    "oauthId",
    "pinCode",
    "profileChangedAt",
    "quotaSizeInBytes",
    "quotaUsageInBytes",
    "storageLabel"
  ],
  "type": "object"
}
```

## SyncCompleteV1


```json
{
  "properties": {},
  "type": "object"
}
```

## SyncDuplicateGroupDeleteV1


```json
{
  "properties": {
    "groupId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "groupId"
  ],
  "type": "object"
}
```

## SyncDuplicateGroupV1


```json
{
  "properties": {
    "assetIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      },
      "minItems": 2,
      "type": "array"
    },
    "groupId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetIds",
    "groupId"
  ],
  "type": "object"
}
```

## SyncEntityType


```json
{
  "description": "Sync entity type",
  "enum": [
    "AlbumAssetAccessV1",
    "AlbumAssetAccessDeleteV1",
    "PartnerAssetAccessV1",
    "PartnerAssetAccessDeleteV1",
    "PinnedCollectionV1",
    "PinnedCollectionDeleteV1",
    "AssetTrashStateV1",
    "AssetTrashStateDeleteV1",
    "DuplicateGroupV1",
    "DuplicateGroupDeleteV1",
    "SharedSpaceV1",
    "SharedSpaceDeleteV1",
    "SharedSpaceMemberV1",
    "SharedSpaceMemberDeleteV1",
    "SharedSpaceAlbumV1",
    "SharedSpaceAlbumDeleteV1",
    "SharedSpacePersonV1",
    "SharedSpacePersonDeleteV1",
    "PetV1",
    "PetDeleteV1",
    "AlbumSourceLinkV1",
    "AlbumSourceLinkDeleteV1",
    "PetObservationV1",
    "PetObservationDeleteV1",
    "TagV1",
    "TagDeleteV1",
    "AssetTagV1",
    "AssetTagDeleteV1",
    "AuthUserV1",
    "AuthUserV2",
    "UserV1",
    "UserDeleteV1",
    "AssetV1",
    "AssetV2",
    "AssetV3",
    "AssetBootstrapV1",
    "AssetDeleteV2",
    "AssetDeleteV1",
    "AssetExifV1",
    "AssetEditV1",
    "AssetEditDeleteV1",
    "AssetMetadataV1",
    "AssetMetadataDeleteV1",
    "AssetOcrV1",
    "AssetOcrDeleteV1",
    "PartnerV1",
    "PartnerDeleteV1",
    "PartnerAssetV1",
    "PartnerAssetV2",
    "PartnerAssetBackfillV1",
    "PartnerAssetBackfillV2",
    "PartnerAssetDeleteV1",
    "PartnerAssetExifV1",
    "PartnerAssetExifBackfillV1",
    "PartnerStackBackfillV1",
    "PartnerStackDeleteV1",
    "PartnerStackV1",
    "AlbumV1",
    "AlbumV2",
    "AlbumV3",
    "AlbumBootstrapV1",
    "AlbumDeleteV2",
    "AlbumDeleteV1",
    "AlbumUserV1",
    "AlbumUserBackfillV1",
    "AlbumUserDeleteV1",
    "AlbumAssetCreateV1",
    "AlbumAssetCreateV2",
    "AlbumAssetUpdateV1",
    "AlbumAssetUpdateV2",
    "AlbumAssetBackfillV1",
    "AlbumAssetBackfillV2",
    "AlbumAssetExifCreateV1",
    "AlbumAssetExifUpdateV1",
    "AlbumAssetExifBackfillV1",
    "AlbumToAssetV1",
    "AlbumToAssetDeleteV1",
    "AlbumToAssetBackfillV1",
    "MemoryV1",
    "MemoryDeleteV1",
    "MemoryToAssetV1",
    "MemoryToAssetDeleteV1",
    "StackV1",
    "StackDeleteV1",
    "PersonV1",
    "PersonDeleteV1",
    "AssetFaceV1",
    "AssetFaceV2",
    "AssetFaceV3",
    "AssetFaceDeleteV1",
    "UserMetadataV1",
    "PinnedCollectionsV1",
    "UserMetadataDeleteV1",
    "SyncAckV1",
    "SyncResetV1",
    "SyncCompleteV1"
  ],
  "type": "string"
}
```

## SyncMemoryAssetDeleteV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "memoryId": {
      "description": "Memory ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "memoryId"
  ],
  "type": "object"
}
```

## SyncMemoryAssetV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "memoryId": {
      "description": "Memory ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "memoryId"
  ],
  "type": "object"
}
```

## SyncMemoryDeleteV1


```json
{
  "properties": {
    "memoryId": {
      "description": "Memory ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "memoryId"
  ],
  "type": "object"
}
```

## SyncMemoryV1

Related models: [MemoryType](models-16.md#memorytype).

```json
{
  "properties": {
    "createdAt": {
      "description": "Created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "data": {
      "additionalProperties": {},
      "description": "Data",
      "type": "object"
    },
    "deletedAt": {
      "description": "Deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "hideAt": {
      "description": "Hide at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Memory ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isSaved": {
      "description": "Is saved",
      "type": "boolean"
    },
    "memoryAt": {
      "description": "Memory at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "seenAt": {
      "description": "Seen at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "showAt": {
      "description": "Show at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/MemoryType"
    },
    "updatedAt": {
      "description": "Updated at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "data",
    "deletedAt",
    "hideAt",
    "id",
    "isSaved",
    "memoryAt",
    "ownerId",
    "seenAt",
    "showAt",
    "type",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncPartnerAssetAccessDeleteV1


```json
{
  "description": "Drop this partner-source asset and its descriptive mirror data, preserving independently authorized sources.",
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "sharedById": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "sharedById"
  ],
  "type": "object"
}
```

## SyncPartnerAssetAccessV1

Related models: [SyncAssetV2](models-34.md#syncassetv2).

```json
{
  "properties": {
    "asset": {
      "$ref": "#/components/schemas/SyncAssetV2"
    },
    "sharedById": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "asset",
    "sharedById"
  ],
  "type": "object"
}
```

## SyncPartnerDeleteV1


```json
{
  "properties": {
    "sharedById": {
      "description": "Shared by ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "sharedWithId": {
      "description": "Shared with ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "sharedById",
    "sharedWithId"
  ],
  "type": "object"
}
```

## SyncPartnerV1


```json
{
  "properties": {
    "inTimeline": {
      "description": "In timeline",
      "type": "boolean"
    },
    "sharedById": {
      "description": "Shared by ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "sharedWithId": {
      "description": "Shared with ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "inTimeline",
    "sharedById",
    "sharedWithId"
  ],
  "type": "object"
}
```

## SyncPersonDeleteV1


```json
{
  "properties": {
    "personId": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "personId"
  ],
  "type": "object"
}
```

## SyncPersonV1


```json
{
  "properties": {
    "birthDate": {
      "description": "Birth date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "color": {
      "description": "Color",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "description": "Created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "faceAssetId": {
      "description": "Face asset ID",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Is hidden",
      "type": "boolean"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "updatedAt": {
      "description": "Updated at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "birthDate",
    "color",
    "createdAt",
    "faceAssetId",
    "id",
    "isFavorite",
    "isHidden",
    "name",
    "ownerId",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncPetDeleteV1


```json
{
  "properties": {
    "petId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "petId"
  ],
  "type": "object"
}
```

## SyncPetObservationDeleteV1


```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "observationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "petId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "observationId",
    "petId"
  ],
  "type": "object"
}
```

## SyncPetObservationV1

Related models: [PetObservationResponseDto](models-18.md#petobservationresponsedto).

```json
{
  "$ref": "#/components/schemas/PetObservationResponseDto"
}
```

## SyncPetV1

Related models: [PetResponseDto](models-18.md#petresponsedto).

```json
{
  "$ref": "#/components/schemas/PetResponseDto"
}
```
