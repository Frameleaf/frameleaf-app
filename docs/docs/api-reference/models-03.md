# Server API models 3

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## AnalyticsHostDto

Related models: [AnalyticsState](models-03.md#analyticsstate), [AnalyticsVolumeBreakdownDto](models-03.md#analyticsvolumebreakdowndto).

```json
{
  "description": "The library volume, always the whole host whatever is selected",
  "properties": {
    "breakdown": {
      "allOf": [
        {
          "$ref": "#/components/schemas/AnalyticsVolumeBreakdownDto"
        }
      ],
      "nullable": true
    },
    "capacityBytes": {
      "description": "Bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "freeBytes": {
      "description": "Bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "observedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/AnalyticsState"
    },
    "volumeUsedBytes": {
      "description": "Bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "capacityBytes",
    "freeBytes",
    "observedAt",
    "state",
    "volumeUsedBytes"
  ],
  "type": "object"
}
```

## AnalyticsInsightsDto

Related models: [AnalyticsCoverageDto](models-02.md#analyticscoveragedto), [AnalyticsFocalLengthDto](models-02.md#analyticsfocallengthdto), [AnalyticsHdrDto](models-02.md#analyticshdrdto), [AnalyticsNamedCountDto](models-03.md#analyticsnamedcountdto), [AnalyticsOrientationDto](models-03.md#analyticsorientationdto), [AnalyticsPeopleAndPlacesDto](models-03.md#analyticspeopleandplacesdto), [AnalyticsPhotoFormatDto](models-03.md#analyticsphotoformatdto), [AnalyticsPunchcardCellDto](models-03.md#analyticspunchcardcelldto), [AnalyticsRecordsDto](models-03.md#analyticsrecordsdto), [AnalyticsVideoResolutionDto](models-03.md#analyticsvideoresolutiondto), [AnalyticsYearCountDto](models-03.md#analyticsyearcountdto).

```json
{
  "properties": {
    "capturesByYear": {
      "description": "Items per local capture year, all time",
      "items": {
        "$ref": "#/components/schemas/AnalyticsYearCountDto"
      },
      "type": "array"
    },
    "coverage": {
      "$ref": "#/components/schemas/AnalyticsCoverageDto"
    },
    "focalLengths": {
      "description": "Every bucket, in order; adds up to summary.items",
      "items": {
        "$ref": "#/components/schemas/AnalyticsFocalLengthDto"
      },
      "type": "array"
    },
    "hdr": {
      "allOf": [
        {
          "$ref": "#/components/schemas/AnalyticsHdrDto"
        }
      ],
      "description": "Null when no video stream has been read, so HDR cannot be told",
      "nullable": true
    },
    "hiddenItems": {
      "description": "Items this session keeps hidden (Locked people and tags, sensitive content). They are left out of every breakdown here, which adds up to summary.items minus hiddenItems (summary.photos and summary.videos likewise)",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "lenses": {
      "description": "Items per lens model, then every other lens, then no lens",
      "items": {
        "$ref": "#/components/schemas/AnalyticsNamedCountDto"
      },
      "type": "array"
    },
    "livePhotos": {
      "description": "Photos with a Live Photo motion part",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "orientation": {
      "description": "Every bucket; adds up to summary.items. Panorama is 2:1 or wider",
      "items": {
        "$ref": "#/components/schemas/AnalyticsOrientationDto"
      },
      "type": "array"
    },
    "peopleAndPlaces": {
      "allOf": [
        {
          "$ref": "#/components/schemas/AnalyticsPeopleAndPlacesDto"
        }
      ],
      "nullable": true
    },
    "photoFormats": {
      "description": "Every format; adds up to summary.photos, and RAW equals summary.raw",
      "items": {
        "$ref": "#/components/schemas/AnalyticsPhotoFormatDto"
      },
      "type": "array"
    },
    "punchcard": {
      "description": "All 168 weekday and hour cells of the local capture time",
      "items": {
        "$ref": "#/components/schemas/AnalyticsPunchcardCellDto"
      },
      "type": "array"
    },
    "records": {
      "$ref": "#/components/schemas/AnalyticsRecordsDto"
    },
    "videoResolutions": {
      "description": "Every bucket; adds up to summary.videos",
      "items": {
        "$ref": "#/components/schemas/AnalyticsVideoResolutionDto"
      },
      "type": "array"
    }
  },
  "required": [
    "capturesByYear",
    "coverage",
    "focalLengths",
    "hdr",
    "hiddenItems",
    "lenses",
    "livePhotos",
    "orientation",
    "peopleAndPlaces",
    "photoFormats",
    "punchcard",
    "records",
    "videoResolutions"
  ],
  "type": "object"
}
```

## AnalyticsLargestFileDto


```json
{
  "properties": {
    "bytes": {
      "description": "Bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "name": {
      "description": "File name; null unless the owner reads their own scope",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "bytes",
    "name"
  ],
  "type": "object"
}
```

## AnalyticsLongestVideoDto


```json
{
  "properties": {
    "durationMs": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "name": {
      "description": "File name; null unless the owner reads their own scope",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "durationMs",
    "name"
  ],
  "type": "object"
}
```

## AnalyticsMeasurementScope


```json
{
  "description": "Analytics measurement scope",
  "enum": [
    "selection",
    "host"
  ],
  "type": "string"
}
```

## AnalyticsMetadataDto

Related models: [AnalyticsMetadataField](models-03.md#analyticsmetadatafield).

```json
{
  "properties": {
    "field": {
      "$ref": "#/components/schemas/AnalyticsMetadataField"
    },
    "missing": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "present": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "field",
    "missing",
    "present",
    "total"
  ],
  "type": "object"
}
```

## AnalyticsMetadataField


```json
{
  "enum": [
    "captureDate",
    "location",
    "cameraModel",
    "aiDescription",
    "checksum"
  ],
  "type": "string"
}
```

## AnalyticsNamedCountDto

Related models: [AnalyticsNamedCountKind](models-03.md#analyticsnamedcountkind).

```json
{
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "kind": {
      "$ref": "#/components/schemas/AnalyticsNamedCountKind"
    },
    "name": {
      "description": "Null for the other and unknown rows",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "count",
    "kind",
    "name"
  ],
  "type": "object"
}
```

## AnalyticsNamedCountKind


```json
{
  "enum": [
    "named",
    "other",
    "unknown"
  ],
  "type": "string"
}
```

## AnalyticsOldestCaptureDto


```json
{
  "properties": {
    "date": {
      "format": "date",
      "type": "string"
    },
    "name": {
      "description": "File name; null unless the owner reads their own scope",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "date",
    "name"
  ],
  "type": "object"
}
```

## AnalyticsOrientationDto

Related models: [AnalyticsOrientationDtoKey](models-03.md#analyticsorientationdtokey).

```json
{
  "description": "Items per displayed orientation",
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "key": {
      "$ref": "#/components/schemas/AnalyticsOrientationDtoKey"
    }
  },
  "required": [
    "count",
    "key"
  ],
  "type": "object"
}
```

## AnalyticsOrientationDtoKey


```json
{
  "enum": [
    "landscape",
    "portrait",
    "square",
    "panorama",
    "unknown"
  ],
  "type": "string"
}
```

## AnalyticsPeopleAndPlacesDto

Related models: [AnalyticsNamedCountDto](models-03.md#analyticsnamedcountdto), [AnalyticsPersonCountDto](models-03.md#analyticspersoncountdto).

```json
{
  "description": "The owner's own people and places, only when the owner reads their own scope",
  "properties": {
    "cities": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "countries": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "faces": {
      "description": "Visible faces on the items",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "geotagged": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "itemsWithFaces": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "itemsWithoutFaces": {
      "description": "itemsWithFaces plus itemsWithoutFaces is summary.items minus hiddenItems",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "namedPeople": {
      "description": "Named, visible people of the owner seen on the items",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "pets": {
      "description": "The owner's visible pets confirmed on the items",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "places": {
      "description": "Items per city, then every other city, then no city",
      "items": {
        "$ref": "#/components/schemas/AnalyticsNamedCountDto"
      },
      "type": "array"
    },
    "topPeople": {
      "description": "Most photographed named people; overlapping, as one item can show several",
      "items": {
        "$ref": "#/components/schemas/AnalyticsPersonCountDto"
      },
      "type": "array"
    }
  },
  "required": [
    "cities",
    "countries",
    "faces",
    "geotagged",
    "itemsWithFaces",
    "itemsWithoutFaces",
    "namedPeople",
    "pets",
    "places",
    "topPeople"
  ],
  "type": "object"
}
```

## AnalyticsPersonCountDto


```json
{
  "properties": {
    "count": {
      "description": "Items showing them",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "id": {
      "description": "Person id",
      "type": "string"
    },
    "name": {
      "type": "string"
    }
  },
  "required": [
    "count",
    "id",
    "name"
  ],
  "type": "object"
}
```

## AnalyticsPhotoFormatDto

Related models: [AnalyticsPhotoFormatDtoKey](models-03.md#analyticsphotoformatdtokey).

```json
{
  "description": "Photos per original file format",
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "key": {
      "$ref": "#/components/schemas/AnalyticsPhotoFormatDtoKey"
    }
  },
  "required": [
    "count",
    "key"
  ],
  "type": "object"
}
```

## AnalyticsPhotoFormatDtoKey


```json
{
  "enum": [
    "HEIC",
    "JPEG",
    "RAW",
    "PNG",
    "OTHER"
  ],
  "type": "string"
}
```

## AnalyticsProcessingDto


```json
{
  "properties": {
    "attempts": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "available": {
      "description": "Processing is recorded for the whole server only",
      "type": "boolean"
    },
    "completed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "costedAttempts": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "durationMs": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "estimatedCostUsd": {
      "description": "Estimate from configured hourly rates; never a bill. Null when no attempt had a rate",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "failed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "uncostedAttempts": {
      "description": "Attempts without a configured rate; not included in the estimate",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "attempts",
    "available",
    "completed",
    "costedAttempts",
    "durationMs",
    "estimatedCostUsd",
    "failed",
    "uncostedAttempts"
  ],
  "type": "object"
}
```

## AnalyticsPunchcardCellDto


```json
{
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "hour": {
      "description": "Hour of the local capture time",
      "maximum": 23,
      "minimum": 0,
      "type": "integer"
    },
    "weekday": {
      "description": "ISO weekday of the local capture time, 1 = Monday",
      "maximum": 7,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "count",
    "hour",
    "weekday"
  ],
  "type": "object"
}
```

## AnalyticsRange


```json
{
  "description": "Analytics date range",
  "enum": [
    "90days",
    "year"
  ],
  "type": "string"
}
```

## AnalyticsRecordsDto

Related models: [AnalyticsLargestFileDto](models-03.md#analyticslargestfiledto), [AnalyticsLongestVideoDto](models-03.md#analyticslongestvideodto), [AnalyticsOldestCaptureDto](models-03.md#analyticsoldestcapturedto).

```json
{
  "properties": {
    "largestFile": {
      "allOf": [
        {
          "$ref": "#/components/schemas/AnalyticsLargestFileDto"
        }
      ],
      "nullable": true
    },
    "longestVideo": {
      "allOf": [
        {
          "$ref": "#/components/schemas/AnalyticsLongestVideoDto"
        }
      ],
      "nullable": true
    },
    "oldestCapture": {
      "allOf": [
        {
          "$ref": "#/components/schemas/AnalyticsOldestCaptureDto"
        }
      ],
      "nullable": true
    },
    "videoDurationMs": {
      "description": "All videos together",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "videoHours": {
      "description": "videoDurationMs in hours, one decimal",
      "format": "double",
      "minimum": 0,
      "type": "number"
    }
  },
  "required": [
    "largestFile",
    "longestVideo",
    "oldestCapture",
    "videoDurationMs",
    "videoHours"
  ],
  "type": "object"
}
```

## AnalyticsReportResponseDto

Related models: [AnalyticsAlbumsDto](models-02.md#analyticsalbumsdto), [AnalyticsBucketDto](models-02.md#analyticsbucketdto), [AnalyticsCameraDto](models-02.md#analyticscameradto), [AnalyticsDayDto](models-02.md#analyticsdaydto), [AnalyticsHistoryDto](models-02.md#analyticshistorydto), [AnalyticsHostDto](models-03.md#analyticshostdto), [AnalyticsInsightsDto](models-03.md#analyticsinsightsdto), [AnalyticsMetadataDto](models-03.md#analyticsmetadatadto), [AnalyticsProcessingDto](models-03.md#analyticsprocessingdto), [AnalyticsRange](models-03.md#analyticsrange), [AnalyticsScopeKind](models-03.md#analyticsscopekind), [AnalyticsSeriesDefinitionDto](models-03.md#analyticsseriesdefinitiondto), [AnalyticsSummaryDto](models-03.md#analyticssummarydto), [AnalyticsViewDto](models-03.md#analyticsviewdto).

```json
{
  "properties": {
    "albums": {
      "$ref": "#/components/schemas/AnalyticsAlbumsDto"
    },
    "cameras": {
      "items": {
        "$ref": "#/components/schemas/AnalyticsCameraDto"
      },
      "type": "array"
    },
    "days": {
      "items": {
        "$ref": "#/components/schemas/AnalyticsDayDto"
      },
      "type": "array"
    },
    "definitions": {
      "items": {
        "$ref": "#/components/schemas/AnalyticsSeriesDefinitionDto"
      },
      "type": "array"
    },
    "from": {
      "format": "date",
      "type": "string"
    },
    "generatedAt": {
      "format": "date-time",
      "type": "string"
    },
    "history": {
      "$ref": "#/components/schemas/AnalyticsHistoryDto"
    },
    "host": {
      "$ref": "#/components/schemas/AnalyticsHostDto"
    },
    "insights": {
      "$ref": "#/components/schemas/AnalyticsInsightsDto",
      "description": "Dashboard breakdowns of the same items as summary. People, places and file names are only for the owner reading their own scope"
    },
    "metadata": {
      "items": {
        "$ref": "#/components/schemas/AnalyticsMetadataDto"
      },
      "type": "array"
    },
    "processing": {
      "$ref": "#/components/schemas/AnalyticsProcessingDto"
    },
    "range": {
      "$ref": "#/components/schemas/AnalyticsRange"
    },
    "scope": {
      "type": "string"
    },
    "scopeKind": {
      "$ref": "#/components/schemas/AnalyticsScopeKind"
    },
    "scopeLabel": {
      "description": "Account or library name; empty for the whole server",
      "type": "string"
    },
    "series": {
      "items": {
        "$ref": "#/components/schemas/AnalyticsBucketDto"
      },
      "type": "array"
    },
    "summary": {
      "$ref": "#/components/schemas/AnalyticsSummaryDto"
    },
    "through": {
      "format": "date",
      "type": "string"
    },
    "views": {
      "items": {
        "$ref": "#/components/schemas/AnalyticsViewDto"
      },
      "type": "array"
    }
  },
  "required": [
    "albums",
    "cameras",
    "days",
    "definitions",
    "from",
    "generatedAt",
    "history",
    "host",
    "metadata",
    "processing",
    "range",
    "scope",
    "scopeKind",
    "scopeLabel",
    "series",
    "summary",
    "through",
    "views"
  ],
  "type": "object"
}
```

## AnalyticsScopeKind


```json
{
  "description": "Analytics scope kind",
  "enum": [
    "host",
    "account",
    "library"
  ],
  "type": "string"
}
```

## AnalyticsScopeOptionDto

Related models: [AnalyticsScopeKind](models-03.md#analyticsscopekind).

```json
{
  "properties": {
    "kind": {
      "$ref": "#/components/schemas/AnalyticsScopeKind"
    },
    "label": {
      "description": "Account or library name; empty for the whole server",
      "type": "string"
    },
    "libraryId": {
      "nullable": true,
      "type": "string"
    },
    "removed": {
      "description": "The account or library has been removed; its items may still count until deleted",
      "type": "boolean"
    },
    "userId": {
      "description": "The account, or the library owner",
      "nullable": true,
      "type": "string"
    },
    "value": {
      "description": "The value to pass as `scope`",
      "type": "string"
    }
  },
  "required": [
    "kind",
    "label",
    "libraryId",
    "removed",
    "userId",
    "value"
  ],
  "type": "object"
}
```

## AnalyticsScopesResponseDto

Related models: [AnalyticsScopeOptionDto](models-03.md#analyticsscopeoptiondto).

```json
{
  "properties": {
    "scopes": {
      "items": {
        "$ref": "#/components/schemas/AnalyticsScopeOptionDto"
      },
      "type": "array"
    }
  },
  "required": [
    "scopes"
  ],
  "type": "object"
}
```

## AnalyticsSeriesDefinitionDto

Related models: [AnalyticsGrain](models-02.md#analyticsgrain), [AnalyticsMeasurementScope](models-03.md#analyticsmeasurementscope), [AnalyticsScopeKind](models-03.md#analyticsscopekind), [AnalyticsSeriesId](models-03.md#analyticsseriesid), [AnalyticsSeriesOwner](models-03.md#analyticsseriesowner), [AnalyticsUnit](models-03.md#analyticsunit).

```json
{
  "properties": {
    "available": {
      "description": "Whether this report carries the series for the selected scope",
      "type": "boolean"
    },
    "collected": {
      "description": "Written by the local nightly collector rather than read live",
      "type": "boolean"
    },
    "estimate": {
      "description": "An estimate, never a charge",
      "type": "boolean"
    },
    "grain": {
      "$ref": "#/components/schemas/AnalyticsGrain"
    },
    "id": {
      "$ref": "#/components/schemas/AnalyticsSeriesId"
    },
    "measurementScope": {
      "$ref": "#/components/schemas/AnalyticsMeasurementScope"
    },
    "owner": {
      "$ref": "#/components/schemas/AnalyticsSeriesOwner"
    },
    "scopes": {
      "description": "Selections the series can be read for",
      "items": {
        "$ref": "#/components/schemas/AnalyticsScopeKind"
      },
      "type": "array"
    },
    "source": {
      "description": "Where the number comes from",
      "type": "string"
    },
    "unit": {
      "$ref": "#/components/schemas/AnalyticsUnit"
    }
  },
  "required": [
    "available",
    "collected",
    "estimate",
    "grain",
    "id",
    "measurementScope",
    "owner",
    "scopes",
    "source",
    "unit"
  ],
  "type": "object"
}
```

## AnalyticsSeriesId


```json
{
  "description": "Approved analytics series",
  "enum": [
    "library.items",
    "library.photos",
    "library.videos",
    "library.logicalBytes",
    "library.physicalBytes",
    "host.volumeUsedBytes",
    "host.capacityBytes",
    "host.thumbnailBytes",
    "host.encodedVideoBytes",
    "host.thumbnailOtherDiskBytes",
    "host.encodedVideoOtherDiskBytes",
    "library.arrivals",
    "library.captures",
    "processing.completed",
    "processing.failed",
    "processing.estimatedCostUsd"
  ],
  "type": "string"
}
```

## AnalyticsSeriesOwner


```json
{
  "description": "The part of the product that answers for it",
  "enum": [
    "library",
    "host",
    "processing"
  ],
  "type": "string"
}
```

## AnalyticsState


```json
{
  "description": "Analytics reading state",
  "enum": [
    "measured",
    "stale",
    "unknown"
  ],
  "type": "string"
}
```

## AnalyticsSummaryDto


```json
{
  "properties": {
    "duplicateReferences": {
      "description": "Items sharing an original file with another item in this selection",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "externalLogicalBytes": {
      "description": "Originals in external libraries, usually outside the library volume",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "externalPhysicalBytes": {
      "description": "Bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "files": {
      "description": "Original files, Live Photo motion parts included",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "items": {
      "description": "Photos and videos, Trash included, Locked media and Live Photo motion parts excluded",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "logicalBytes": {
      "description": "Every original reference, before physical deduplication",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "photos": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "physicalBytes": {
      "description": "Original files, each shared file counted once within this selection",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "raw": {
      "description": "RAW photos; a subset of photos",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "savedBytes": {
      "description": "logicalBytes minus physicalBytes of this same selection",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "unmeasuredFiles": {
      "description": "Original files whose size has not been read; excluded from byte totals",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "uploadedLogicalBytes": {
      "description": "Bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "uploadedPhysicalBytes": {
      "description": "Bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "videos": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "duplicateReferences",
    "externalLogicalBytes",
    "externalPhysicalBytes",
    "files",
    "items",
    "logicalBytes",
    "photos",
    "physicalBytes",
    "raw",
    "savedBytes",
    "unmeasuredFiles",
    "uploadedLogicalBytes",
    "uploadedPhysicalBytes",
    "videos"
  ],
  "type": "object"
}
```

## AnalyticsUnit


```json
{
  "description": "Analytics unit",
  "enum": [
    "items",
    "bytes",
    "attempts",
    "usd"
  ],
  "type": "string"
}
```

## AnalyticsVideoResolutionDto

Related models: [AnalyticsVideoResolutionDtoKey](models-03.md#analyticsvideoresolutiondtokey).

```json
{
  "description": "Videos per resolution",
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "key": {
      "$ref": "#/components/schemas/AnalyticsVideoResolutionDtoKey"
    }
  },
  "required": [
    "count",
    "key"
  ],
  "type": "object"
}
```

## AnalyticsVideoResolutionDtoKey


```json
{
  "enum": [
    "4K",
    "1080p",
    "720p",
    "SD",
    "unknown"
  ],
  "type": "string"
}
```

## AnalyticsView


```json
{
  "enum": [
    "timeline",
    "favorites",
    "archive",
    "trash"
  ],
  "type": "string"
}
```

## AnalyticsViewDto

Related models: [AnalyticsView](models-03.md#analyticsview).

```json
{
  "properties": {
    "overlaps": {
      "description": "Also counted in another view",
      "type": "boolean"
    },
    "photos": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "videos": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "view": {
      "$ref": "#/components/schemas/AnalyticsView"
    }
  },
  "required": [
    "overlaps",
    "photos",
    "total",
    "videos",
    "view"
  ],
  "type": "object"
}
```

## AnalyticsVolumeBreakdownDto

Related models: [AnalyticsVolumePart](models-03.md#analyticsvolumepart).

```json
{
  "description": "What uses the library volume, only in the whole-server report; the parts and otherBytes add up to volumeUsedBytes",
  "properties": {
    "databaseBytes": {
      "description": "This server database on disk (pg_database_size)",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "encodedVideoBytes": {
      "description": "Encoded video folder, from the nightly collector; null before its first reading",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "exceedsUsed": {
      "description": "The measured parts add up to more than the volume used, for example a database on another disk; otherBytes is then 0",
      "type": "boolean"
    },
    "generatedObservedAt": {
      "description": "When the generated folders were last measured",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "onOtherDisk": {
      "description": "Generated folders the collector found on another disk than the library; not part of volumeUsedBytes",
      "items": {
        "$ref": "#/components/schemas/AnalyticsVolumePart"
      },
      "type": "array"
    },
    "originalsBytes": {
      "description": "Uploaded original files on the volume, each shared file counted once (Locked excluded)",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "otherBytes": {
      "description": "volumeUsedBytes minus every measured part: other files on the volume, Locked originals and anything unmeasured",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "previewsBytes": {
      "description": "Thumbnail and preview folder, from the nightly collector; null before its first reading",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "databaseBytes",
    "encodedVideoBytes",
    "exceedsUsed",
    "generatedObservedAt",
    "onOtherDisk",
    "originalsBytes",
    "otherBytes",
    "previewsBytes"
  ],
  "type": "object"
}
```

## AnalyticsVolumePart


```json
{
  "enum": [
    "previews",
    "encodedVideo"
  ],
  "type": "string"
}
```

## AnalyticsYearCountDto


```json
{
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "year": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "count",
    "year"
  ],
  "type": "object"
}
```

## ApiKeyCreateDto

Related models: [Permission](models-17.md#permission).

```json
{
  "properties": {
    "name": {
      "description": "API key name",
      "type": "string"
    },
    "permissions": {
      "description": "List of permissions",
      "items": {
        "$ref": "#/components/schemas/Permission"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "permissions"
  ],
  "type": "object"
}
```

## ApiKeyCreateResponseDto

Related models: [ApiKeyResponseDto](models-03.md#apikeyresponsedto), [Permission](models-17.md#permission).

```json
{
  "properties": {
    "apiKey": {
      "$ref": "#/components/schemas/ApiKeyResponseDto",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v3.2.0",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    },
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "API key ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "API key name",
      "type": "string"
    },
    "permissions": {
      "description": "List of permissions",
      "items": {
        "$ref": "#/components/schemas/Permission"
      },
      "type": "array"
    },
    "secret": {
      "description": "API key secret (only shown once)",
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
    "apiKey",
    "createdAt",
    "id",
    "name",
    "permissions",
    "secret",
    "updatedAt"
  ],
  "type": "object"
}
```

## ApiKeyResponseDto

Related models: [Permission](models-17.md#permission).

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
      "description": "API key ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "API key name",
      "type": "string"
    },
    "permissions": {
      "description": "List of permissions",
      "items": {
        "$ref": "#/components/schemas/Permission"
      },
      "type": "array"
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
    "createdAt",
    "id",
    "name",
    "permissions",
    "updatedAt"
  ],
  "type": "object"
}
```

## ApiKeyUpdateDto

Related models: [Permission](models-17.md#permission).

```json
{
  "properties": {
    "name": {
      "description": "API key name",
      "type": "string"
    },
    "permissions": {
      "description": "List of permissions",
      "items": {
        "$ref": "#/components/schemas/Permission"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## ArchiveOperationConfirmDto


```json
{
  "additionalProperties": false,
  "properties": {
    "requestKey": {
      "description": "The request key the selection was prepared with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "requestKey"
  ],
  "type": "object"
}
```

## ArchiveOperationCreateDto


```json
{
  "additionalProperties": false,
  "properties": {
    "assetIds": {
      "description": "The selection, in order",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "minItems": 1,
      "type": "array"
    },
    "requestKey": {
      "description": "Client idempotency key; the same key answers with the same operation instead of starting another",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetIds",
    "requestKey"
  ],
  "type": "object"
}
```

## ArchiveOperationPrepareDto

Related models: [ArchiveOperationPrepareScope](models-03.md#archiveoperationpreparescope).

```json
{
  "additionalProperties": false,
  "properties": {
    "requestKey": {
      "description": "Client idempotency key; the same key answers with the same operation instead of starting another",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "scope": {
      "$ref": "#/components/schemas/ArchiveOperationPrepareScope"
    }
  },
  "required": [
    "requestKey",
    "scope"
  ],
  "type": "object"
}
```

## ArchiveOperationPrepareScope


```json
{
  "description": "Only the owner’s own normal Timeline can be prepared on the server",
  "enum": [
    "matching-owned-timeline"
  ],
  "type": "string"
}
```

## ArchiveOperationResponseDto

Related models: [ArchiveOperationScope](models-03.md#archiveoperationscope).

```json
{
  "properties": {
    "archiveJobId": {
      "description": "The durable bulk job that archives the frozen set",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "archived": {
      "description": "Archived by this operation and not undone",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "conflict": {
      "description": "Changed after the archive, so Undo left them as they are",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "count": {
      "description": "Assets frozen into this operation",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "currentSession": {
      "description": "The operation was submitted or confirmed from the session asking, so it may offer its Undo",
      "type": "boolean"
    },
    "expiresAt": {
      "description": "When an unconfirmed prepared selection stops being confirmable",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Archive operation ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "pending": {
      "description": "Not reached yet",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "prepared": {
      "description": "Counted and frozen, waiting for the owner to confirm; nothing has changed yet",
      "type": "boolean"
    },
    "requestKey": {
      "description": "The request key the operation was created with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "scope": {
      "$ref": "#/components/schemas/ArchiveOperationScope"
    },
    "skipped": {
      "description": "Left as they were: no longer in the Timeline, or stopped before they were reached",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "undoJobId": {
      "description": "The durable bulk job that undoes it, once requested",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "undoable": {
      "description": "Undo is available for this operation",
      "type": "boolean"
    },
    "undone": {
      "description": "Restored by Undo",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "archiveJobId",
    "archived",
    "conflict",
    "count",
    "createdAt",
    "currentSession",
    "expiresAt",
    "id",
    "pending",
    "prepared",
    "requestKey",
    "scope",
    "skipped",
    "undoJobId",
    "undoable",
    "undone"
  ],
  "type": "object"
}
```

## ArchiveOperationScope


```json
{
  "description": "What an archive operation covers",
  "enum": [
    "selected-owned-assets",
    "matching-owned-timeline"
  ],
  "type": "string"
}
```

## ArchiveOperationUndoDto


```json
{
  "additionalProperties": false,
  "properties": {
    "requestKey": {
      "description": "Client idempotency key; the same key answers with the same operation instead of starting another",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "requestKey"
  ],
  "type": "object"
}
```

## AskSearchDto


```json
{
  "properties": {
    "language": {
      "description": "Search language code",
      "type": "string"
    },
    "page": {
      "description": "Page number",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "query": {
      "description": "Natural language Ask Search query",
      "minLength": 1,
      "type": "string"
    },
    "size": {
      "description": "Number of results to return",
      "maximum": 1000,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "query"
  ],
  "type": "object"
}
```
