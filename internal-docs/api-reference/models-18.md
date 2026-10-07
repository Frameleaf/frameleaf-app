# Server API models 18

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## PersonCorrectionAction


```json
{
  "description": "What the decision did",
  "enum": [
    "reassign",
    "new-person",
    "unassign",
    "remove",
    "merge",
    "box-move",
    "partner-merge"
  ],
  "type": "string"
}
```

## PersonCorrectionDto

Related models: [FaceEvidenceDto](models-11.md#faceevidencedto), [PersonCorrectionAction](models-18.md#personcorrectionaction), [PersonCorrectionPersonDto](models-18.md#personcorrectionpersondto).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/PersonCorrectionAction"
    },
    "createdAt": {
      "description": "When the decision was made",
      "format": "date-time",
      "type": "string"
    },
    "evidence": {
      "allOf": [
        {
          "$ref": "#/components/schemas/FaceEvidenceDto"
        }
      ],
      "description": "The photo and face, when it may still be shown",
      "nullable": true
    },
    "evidenceRevoked": {
      "description": "True when the decision was about a photo that can no longer be shown (trashed, Locked, hidden)",
      "type": "boolean"
    },
    "fromPerson": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PersonCorrectionPersonDto"
        }
      ],
      "description": "Who the face belonged to before",
      "nullable": true
    },
    "id": {
      "description": "Correction ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "toPerson": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PersonCorrectionPersonDto"
        }
      ],
      "description": "Who the face belongs to after",
      "nullable": true
    },
    "undoable": {
      "description": "Whether this kind of decision can be undone and has not been",
      "type": "boolean"
    },
    "undoneAt": {
      "description": "When the decision was undone",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "action",
    "createdAt",
    "evidence",
    "evidenceRevoked",
    "fromPerson",
    "id",
    "toPerson",
    "undoable",
    "undoneAt"
  ],
  "type": "object"
}
```

## PersonCorrectionPersonDto


```json
{
  "properties": {
    "exists": {
      "description": "Whether the person still exists",
      "type": "boolean"
    },
    "id": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "The current name, or the name at the time when the person no longer exists",
      "type": "string"
    }
  },
  "required": [
    "exists",
    "id",
    "name"
  ],
  "type": "object"
}
```

## PersonCorrectionsResponseDto

Related models: [PersonCorrectionDto](models-18.md#personcorrectiondto).

```json
{
  "properties": {
    "corrections": {
      "description": "Manual face decisions for this person, most recent first",
      "items": {
        "$ref": "#/components/schemas/PersonCorrectionDto"
      },
      "type": "array"
    },
    "hasNextPage": {
      "description": "Whether there are more pages",
      "type": "boolean"
    }
  },
  "required": [
    "corrections",
    "hasNextPage"
  ],
  "type": "object"
}
```

## PersonCreateDto


```json
{
  "properties": {
    "birthDate": {
      "description": "Person date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "color": {
      "description": "Person color (hex)",
      "nullable": true,
      "pattern": "^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Person visibility (hidden)",
      "type": "boolean"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    }
  },
  "type": "object"
}
```

## PersonMergeSuggestionDto

Related models: [FaceEvidenceDto](models-11.md#faceevidencedto), [PersonResponseDto](models-18.md#personresponsedto).

```json
{
  "properties": {
    "distance": {
      "description": "Face embedding distance between the two people (lower is more similar)",
      "format": "double",
      "minimum": 0,
      "type": "number"
    },
    "person": {
      "$ref": "#/components/schemas/PersonResponseDto",
      "description": "The person being reviewed"
    },
    "personEvidence": {
      "allOf": [
        {
          "$ref": "#/components/schemas/FaceEvidenceDto"
        }
      ],
      "description": "The reviewed person's reference face and its complete photo, or null when none may be shown",
      "nullable": true
    },
    "suggestion": {
      "$ref": "#/components/schemas/PersonResponseDto",
      "description": "The suggested match for that person"
    },
    "suggestionEvidence": {
      "allOf": [
        {
          "$ref": "#/components/schemas/FaceEvidenceDto"
        }
      ],
      "description": "The suggested person's reference face and its complete photo, or null when none may be shown",
      "nullable": true
    }
  },
  "required": [
    "distance",
    "person",
    "personEvidence",
    "suggestion",
    "suggestionEvidence"
  ],
  "type": "object"
}
```

## PersonMergeVerdict


```json
{
  "description": "\"same\": merge the two people now (the named one survives, or `personId` when both or neither are named); \"different\": never suggest this pair again; \"later\": skip it for 30 days; \"ignore\": stop suggesting `personId` with anyone",
  "enum": [
    "same",
    "different",
    "later",
    "ignore"
  ],
  "type": "string"
}
```

## PersonMergeVerdictCreateDto

Related models: [PersonMergeVerdict](models-18.md#personmergeverdict).

```json
{
  "properties": {
    "personId": {
      "description": "One person of the suggested pair (the reviewed person, for \"ignore\")",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "suggestionId": {
      "description": "The other person of the suggested pair",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "verdict": {
      "$ref": "#/components/schemas/PersonMergeVerdict"
    }
  },
  "required": [
    "personId",
    "suggestionId",
    "verdict"
  ],
  "type": "object"
}
```

## PersonMergeVerdictDeleteDto


```json
{
  "properties": {
    "personId": {
      "description": "One person of the suggested pair (the reviewed person, for \"ignore\")",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "suggestionId": {
      "description": "The other person of the suggested pair",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "personId",
    "suggestionId"
  ],
  "type": "object"
}
```

## PersonMergeVerdictResponseDto

Related models: [PersonMergeVerdict](models-18.md#personmergeverdict).

```json
{
  "properties": {
    "createdAt": {
      "description": "When the verdict was recorded",
      "format": "date-time",
      "type": "string"
    },
    "personId": {
      "description": "The person of the pair whose id sorts first; the ignored person for \"ignore\"; the surviving person for \"same\"",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "suggestionId": {
      "description": "The other person of the pair; the ignored person again for \"ignore\"; the merged person for \"same\"",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "verdict": {
      "$ref": "#/components/schemas/PersonMergeVerdict"
    }
  },
  "required": [
    "createdAt",
    "personId",
    "suggestionId",
    "verdict"
  ],
  "type": "object"
}
```

## PersonRecapDto


```json
{
  "properties": {
    "assetCount": {
      "description": "Number of their photos and videos that year",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "kind": {
      "description": "Discriminator for a person or pet recap",
      "enum": [
        "person_recap"
      ],
      "type": "string"
    },
    "name": {
      "description": "Their name when the memory was made",
      "type": "string"
    },
    "subject": {
      "description": "Whether the recap is about a person or a pet",
      "enum": [
        "person",
        "pet"
      ],
      "type": "string"
    },
    "subjectId": {
      "description": "The owner's person or pet",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "year": {
      "description": "Calendar year being recapped",
      "maximum": 9999,
      "minimum": 1000,
      "type": "integer"
    }
  },
  "required": [
    "assetCount",
    "kind",
    "name",
    "subject",
    "subjectId",
    "year"
  ],
  "type": "object"
}
```

## PersonResponseDto


```json
{
  "properties": {
    "birthDate": {
      "description": "Person date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "color": {
      "description": "Person color (hex)",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1.126.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "featuredAssetId": {
      "description": "The photo the person's featured face is in (FL-37). Returned only to the person's owner, by GET and PUT /people/:id; null when there is none, when it is another account's photo, or when it may not be shown (trashed, hidden, Locked, a removed or invisible face, or hidden as NSFW)",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        },
        {
          "version": "v3.2.1",
          "state": "Alpha"
        }
      ],
      "x-immich-state": "Alpha"
    },
    "id": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v1.126.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "isHidden": {
      "description": "Is hidden",
      "type": "boolean"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    },
    "thumbnailPath": {
      "description": "Thumbnail path",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "format": "date-time",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1.107.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    }
  },
  "required": [
    "birthDate",
    "id",
    "isHidden",
    "name",
    "thumbnailPath"
  ],
  "type": "object"
}
```

## PersonStatisticsResponseDto


```json
{
  "properties": {
    "assets": {
      "description": "Number of assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "photos": {
      "description": "Number of photos among the assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "videos": {
      "description": "Number of videos among the assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "assets",
    "photos",
    "videos"
  ],
  "type": "object"
}
```

## PersonUpdateDto


```json
{
  "properties": {
    "birthDate": {
      "description": "Person date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "color": {
      "description": "Person color (hex)",
      "nullable": true,
      "pattern": "^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$",
      "type": "string"
    },
    "featureFaceAssetId": {
      "description": "Asset ID used for feature face thumbnail",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Person visibility (hidden)",
      "type": "boolean"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    }
  },
  "type": "object"
}
```

## PetCandidateListResponseDto

Related models: [PetCandidateResponseDto](models-18.md#petcandidateresponsedto), [PetRecognitionStatusResponseDto](models-18.md#petrecognitionstatusresponsedto).

```json
{
  "properties": {
    "candidates": {
      "description": "Proposals awaiting review",
      "items": {
        "$ref": "#/components/schemas/PetCandidateResponseDto"
      },
      "type": "array"
    },
    "recognition": {
      "$ref": "#/components/schemas/PetRecognitionStatusResponseDto"
    },
    "recognitionAvailable": {
      "description": "Whether a pet recognition model is configured and available",
      "type": "boolean"
    },
    "recognitionUnavailableReason": {
      "description": "Why recognition is unavailable, for display; null when it is available",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "candidates",
    "recognition",
    "recognitionAvailable",
    "recognitionUnavailableReason"
  ],
  "type": "object"
}
```

## PetCandidateRejectDto


```json
{
  "properties": {
    "expectedChecksum": {
      "description": "Checksum of the original the decision was made on (base64); refused with 409 when it changed",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

## PetCandidateResponseDto


```json
{
  "properties": {
    "assetChecksum": {
      "description": "Checksum (base64) of the asset now; send it back as expectedChecksum",
      "type": "string"
    },
    "assetId": {
      "description": "Asset the proposal is about",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boundingBoxX1": {
      "description": "Region X1, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxX2": {
      "description": "Region X2, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY1": {
      "description": "Region Y1, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY2": {
      "description": "Region Y2, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "detectedSpecies": {
      "description": "The detector's species guess, which is never the pet's species",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Candidate ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "imageHeight": {
      "description": "Height of the image the region was found on",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Width of the image the region was found on",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "modelName": {
      "description": "Model that produced the detection",
      "type": "string"
    },
    "modelRevision": {
      "description": "Revision of the model that produced the detection",
      "type": "string"
    },
    "petId": {
      "description": "Proposed pet ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "score": {
      "description": "Model confidence, 0 to 1",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "assetChecksum",
    "assetId",
    "boundingBoxX1",
    "boundingBoxX2",
    "boundingBoxY1",
    "boundingBoxY2",
    "detectedSpecies",
    "id",
    "imageHeight",
    "imageWidth",
    "modelName",
    "modelRevision",
    "petId",
    "score"
  ],
  "type": "object"
}
```

## PetCandidateReviewDto


```json
{
  "properties": {
    "expectedChecksum": {
      "description": "Checksum of the original the decision was made on (base64); refused with 409 when it changed",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "petId": {
      "description": "Pet to assign instead of the proposed one",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## PetCreateDto

Related models: [PetSpecies](models-18.md#petspecies).

```json
{
  "properties": {
    "birthDate": {
      "description": "Pet date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "featuredAssetId": {
      "description": "Asset used as the pet thumbnail",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Pet visibility (hidden)",
      "type": "boolean"
    },
    "name": {
      "description": "Pet name",
      "maxLength": 100,
      "type": "string"
    },
    "species": {
      "$ref": "#/components/schemas/PetSpecies",
      "default": "other"
    }
  },
  "type": "object"
}
```

## PetMergeDto


```json
{
  "properties": {
    "ids": {
      "description": "Pet IDs to merge into this pet",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
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

## PetObservationCreateDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset the pet appears in",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boundingBoxX1": {
      "description": "Region X1, in source pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "boundingBoxX2": {
      "description": "Region X2, in source pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "boundingBoxY1": {
      "description": "Region Y1, in source pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "boundingBoxY2": {
      "description": "Region Y2, in source pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "expectedChecksum": {
      "description": "Checksum of the original the decision was made on (base64); refused with 409 when it changed",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "imageHeight": {
      "description": "Height of the image the region was drawn on",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Width of the image the region was drawn on",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "assetId"
  ],
  "type": "object"
}
```

## PetObservationResponseDto

Related models: [PetObservationSource](models-18.md#petobservationsource), [PetObservationState](models-18.md#petobservationstate).

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
      "description": "Region X1, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "boundingBoxX2": {
      "description": "Region X2, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "boundingBoxY1": {
      "description": "Region Y1, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "boundingBoxY2": {
      "description": "Region Y2, in source pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "createdAt": {
      "description": "Creation date",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Observation ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "imageHeight": {
      "description": "Height of the image the region was drawn on",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Width of the image the region was drawn on",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "petId": {
      "description": "Pet ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "source": {
      "$ref": "#/components/schemas/PetObservationSource"
    },
    "sourceChecksum": {
      "description": "Checksum (base64) of the original when the decision was made; null for older decisions",
      "nullable": true,
      "type": "string"
    },
    "staleAt": {
      "description": "When the original was replaced under a drawn region, which then needs review; null when current",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/PetObservationState"
    },
    "updatedAt": {
      "description": "Last update date",
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "boundingBoxX1",
    "boundingBoxX2",
    "boundingBoxY1",
    "boundingBoxY2",
    "createdAt",
    "id",
    "imageHeight",
    "imageWidth",
    "petId",
    "source",
    "sourceChecksum",
    "staleAt",
    "state",
    "updatedAt"
  ],
  "type": "object"
}
```

## PetObservationSource


```json
{
  "description": "How a pet observation was recorded",
  "enum": [
    "manual",
    "review"
  ],
  "type": "string"
}
```

## PetObservationState


```json
{
  "description": "Pet observation state",
  "enum": [
    "confirmed",
    "rejected"
  ],
  "type": "string"
}
```

## PetRecognitionRunResponseDto

Related models: [MlDestinationKind](models-17.md#mldestinationkind), [PetRecognitionRunStatus](models-18.md#petrecognitionrunstatus).

```json
{
  "properties": {
    "assetCount": {
      "description": "Photos the run looks at",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "createdAt": {
      "description": "When the run was started",
      "format": "date-time",
      "type": "string"
    },
    "destinationKind": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MlDestinationKind"
        }
      ],
      "description": "Kind of destination the run was started on",
      "nullable": true
    },
    "error": {
      "description": "Why the run stopped, when it failed",
      "nullable": true,
      "type": "string"
    },
    "finishedAt": {
      "description": "When the run finished",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Run ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "processedCount": {
      "description": "Photos looked at so far",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "proposalCount": {
      "description": "Proposals made so far",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "status": {
      "$ref": "#/components/schemas/PetRecognitionRunStatus"
    }
  },
  "required": [
    "assetCount",
    "createdAt",
    "destinationKind",
    "error",
    "finishedAt",
    "id",
    "processedCount",
    "proposalCount",
    "status"
  ],
  "type": "object"
}
```

## PetRecognitionRunStatus


```json
{
  "description": "State of a pet recognition run",
  "enum": [
    "queued",
    "running",
    "completed",
    "cancelled",
    "failed"
  ],
  "type": "string"
}
```

## PetRecognitionStatusResponseDto

Related models: [MlDestinationKind](models-17.md#mldestinationkind), [PetRecognitionRunResponseDto](models-18.md#petrecognitionrunresponsedto), [PetRecognitionUnavailableReason](models-18.md#petrecognitionunavailablereason).

```json
{
  "properties": {
    "available": {
      "description": "Whether recognition can run on the routed destination now",
      "type": "boolean"
    },
    "destination": {
      "description": "The destination pet recognition is routed to, if any",
      "nullable": true,
      "properties": {
        "kind": {
          "$ref": "#/components/schemas/MlDestinationKind"
        },
        "name": {
          "description": "Destination name",
          "type": "string"
        }
      },
      "required": [
        "kind",
        "name"
      ],
      "type": "object"
    },
    "detail": {
      "description": "The refusal in words, for display",
      "nullable": true,
      "type": "string"
    },
    "hasConfirmedPhotos": {
      "description": "Whether any pet is confirmed in a photo, which recognition learns from",
      "type": "boolean"
    },
    "reason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PetRecognitionUnavailableReason"
        }
      ],
      "description": "Why it cannot; null when it can",
      "nullable": true
    },
    "run": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PetRecognitionRunResponseDto"
        }
      ],
      "description": "The latest run over this library",
      "nullable": true
    }
  },
  "required": [
    "available",
    "destination",
    "detail",
    "hasConfirmedPhotos",
    "reason",
    "run"
  ],
  "type": "object"
}
```

## PetRecognitionUnavailableReason


```json
{
  "description": "Why pet recognition is unavailable",
  "enum": [
    "machine-learning-disabled",
    "smart-search-disabled",
    "destination-missing",
    "destination-disabled",
    "workload-not-routed",
    "workload-not-allowed",
    "workload-not-served",
    "consent-missing",
    "budget-exceeded",
    "endpoint-unresolved",
    "destination-unhealthy",
    "role-conflict",
    "insufficient-memory",
    "cloud-unavailable",
    "entitlement-missing",
    "consent-version-outdated",
    "wallet-insufficient",
    "quota-exceeded",
    "model-mismatch",
    "request-invalid"
  ],
  "type": "string"
}
```

## PetResponseDto

Related models: [PetSpecies](models-18.md#petspecies).

```json
{
  "properties": {
    "assetCount": {
      "description": "Number of assets with a confirmed observation of this pet",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "birthDate": {
      "description": "Pet date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "description": "Creation date",
      "format": "date-time",
      "type": "string"
    },
    "featuredAssetId": {
      "description": "Asset used as the pet thumbnail",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "Pet ID",
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
      "description": "Pet name",
      "type": "string"
    },
    "species": {
      "$ref": "#/components/schemas/PetSpecies"
    },
    "updatedAt": {
      "description": "Last update date",
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "assetCount",
    "birthDate",
    "createdAt",
    "featuredAssetId",
    "id",
    "isFavorite",
    "isHidden",
    "name",
    "species",
    "updatedAt"
  ],
  "type": "object"
}
```

## PetSpecies


```json
{
  "description": "Pet species",
  "enum": [
    "cat",
    "dog",
    "bird",
    "rabbit",
    "horse",
    "reptile",
    "fish",
    "small_mammal",
    "other"
  ],
  "type": "string"
}
```

## PetStoryDto


```json
{
  "properties": {
    "assetCount": {
      "description": "Confirmed photos of the pet that month, before the diversity pass",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "kind": {
      "description": "Discriminator for a pet story",
      "enum": [
        "pet_story"
      ],
      "type": "string"
    },
    "month": {
      "description": "The owner's local month, 'yyyy-MM'",
      "type": "string"
    },
    "name": {
      "description": "The pet name",
      "type": "string"
    },
    "petId": {
      "description": "The pet the story is about",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "species": {
      "description": "The pet species",
      "type": "string"
    },
    "year": {
      "description": "Year of the month",
      "maximum": 9999,
      "minimum": 1000,
      "type": "integer"
    }
  },
  "required": [
    "assetCount",
    "kind",
    "month",
    "name",
    "petId",
    "species",
    "year"
  ],
  "type": "object"
}
```

## PetUpdateDto

Related models: [PetSpecies](models-18.md#petspecies).

```json
{
  "properties": {
    "birthDate": {
      "description": "Pet date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "featuredAssetId": {
      "description": "Asset used as the pet thumbnail",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Pet visibility (hidden)",
      "type": "boolean"
    },
    "name": {
      "description": "Pet name",
      "maxLength": 100,
      "type": "string"
    },
    "species": {
      "$ref": "#/components/schemas/PetSpecies"
    }
  },
  "type": "object"
}
```

## PhotographyApprovalDto


```json
{
  "additionalProperties": false,
  "properties": {
    "captureId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "expectedRevision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "requestClientApproval": {
      "type": "boolean"
    },
    "revisionId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "captureId",
    "expectedRevision",
    "requestClientApproval",
    "revisionId"
  ],
  "type": "object"
}
```

## PhotographyAssemblyDto


```json
{
  "additionalProperties": false,
  "properties": {
    "captures": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "chapterId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "offsetSeconds": {
            "maximum": 86400,
            "minimum": -86400,
            "type": "integer"
          },
          "photographer": {
            "maxLength": 200,
            "type": "string"
          },
          "position": {
            "maximum": 10000,
            "minimum": 0,
            "type": "integer"
          },
          "withheld": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "chapterId",
          "position",
          "offsetSeconds",
          "photographer",
          "withheld"
        ],
        "type": "object"
      },
      "maxItems": 10000,
      "type": "array"
    },
    "chapters": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "coverCaptureId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "description": {
            "maxLength": 2000,
            "type": "string"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "position": {
            "maximum": 10000,
            "minimum": 0,
            "type": "integer"
          },
          "title": {
            "maxLength": 200,
            "minLength": 1,
            "type": "string"
          }
        },
        "required": [
          "id",
          "title",
          "description",
          "position",
          "coverCaptureId"
        ],
        "type": "object"
      },
      "maxItems": 200,
      "type": "array"
    },
    "expectedRevision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "ordering": {
      "enum": [
        "chronological",
        "photographer",
        "manual",
        "chapters"
      ],
      "type": "string"
    }
  },
  "required": [
    "captures",
    "chapters",
    "expectedRevision",
    "ordering"
  ],
  "type": "object"
}
```

## PhotographyBrandDto


```json
{
  "properties": {
    "brand": {
      "additionalProperties": false,
      "properties": {
        "background": {
          "pattern": "^#[\\da-fA-F]{6}$",
          "type": "string"
        },
        "color": {
          "pattern": "^#[\\da-fA-F]{6}$",
          "type": "string"
        },
        "email": {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 254,
              "format": "email",
              "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
            },
            {
              "type": "string",
              "enum": [
                ""
              ]
            }
          ]
        },
        "exportWatermarkPresetId": {
          "default": null,
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        },
        "font": {
          "enum": [
            "editorial",
            "modern",
            "classic"
          ],
          "type": "string"
        },
        "logoAssetId": {
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        },
        "logoInitials": {
          "maxLength": 12,
          "type": "string"
        },
        "name": {
          "maxLength": 200,
          "minLength": 1,
          "type": "string"
        },
        "phone": {
          "maxLength": 100,
          "type": "string"
        },
        "proofWatermarkPresetId": {
          "default": null,
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        },
        "tagline": {
          "maxLength": 300,
          "type": "string"
        },
        "textColor": {
          "pattern": "^#[\\da-fA-F]{6}$",
          "type": "string"
        },
        "watermarkColor": {
          "pattern": "^#[\\da-fA-F]{6}$",
          "type": "string"
        },
        "watermarkOpacity": {
          "maximum": 100,
          "minimum": 10,
          "type": "integer"
        },
        "watermarkPosition": {
          "enum": [
            "bottom-right",
            "bottom-left",
            "center",
            "top-right"
          ],
          "type": "string"
        },
        "watermarkPresets": {
          "default": [],
          "items": {
            "additionalProperties": false,
            "properties": {
              "id": {
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                "type": "string"
              },
              "name": {
                "maxLength": 100,
                "minLength": 1,
                "type": "string"
              },
              "version": {
                "exclusiveMinimum": true,
                "maximum": 9007199254740991,
                "minimum": 0,
                "type": "integer"
              },
              "watermark": {
                "additionalProperties": false,
                "properties": {
                  "alignment": {
                    "default": "center",
                    "enum": [
                      "left",
                      "center",
                      "right"
                    ],
                    "type": "string"
                  },
                  "backing": {
                    "default": false,
                    "type": "boolean"
                  },
                  "color": {
                    "default": "#ffffff",
                    "pattern": "^#[\\da-fA-F]{6}$",
                    "type": "string"
                  },
                  "font": {
                    "default": "script",
                    "enum": [
                      "script",
                      "serif",
                      "sans"
                    ],
                    "type": "string"
                  },
                  "logoAssetId": {
                    "default": null,
                    "format": "uuid",
                    "nullable": true,
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "logoPosition": {
                    "default": "above",
                    "enum": [
                      "above",
                      "below",
                      "left",
                      "right"
                    ],
                    "type": "string"
                  },
                  "logoScale": {
                    "default": 1,
                    "maximum": 4,
                    "minimum": 0.25,
                    "type": "number"
                  },
                  "logoVariant": {
                    "default": "original",
                    "enum": [
                      "original",
                      "light",
                      "dark"
                    ],
                    "type": "string"
                  },
                  "margin": {
                    "default": 4,
                    "maximum": 25,
                    "minimum": 0,
                    "type": "number"
                  },
                  "opacity": {
                    "default": 45,
                    "maximum": 100,
                    "minimum": 1,
                    "type": "number"
                  },
                  "outline": {
                    "default": false,
                    "type": "boolean"
                  },
                  "pattern": {
                    "default": "signature",
                    "enum": [
                      "signature",
                      "centre",
                      "diagonal",
                      "tile"
                    ],
                    "type": "string"
                  },
                  "position": {
                    "default": "bottom-right",
                    "enum": [
                      "top-left",
                      "top-right",
                      "bottom-left",
                      "bottom-right",
                      "center"
                    ],
                    "type": "string"
                  },
                  "rotation": {
                    "default": 0,
                    "maximum": 180,
                    "minimum": -180,
                    "type": "number"
                  },
                  "secondLine": {
                    "default": "",
                    "maxLength": 200,
                    "type": "string"
                  },
                  "size": {
                    "default": 6,
                    "maximum": 30,
                    "minimum": 1,
                    "type": "number"
                  },
                  "spacing": {
                    "default": 6,
                    "maximum": 100,
                    "minimum": 0,
                    "type": "number"
                  },
                  "text": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string"
                  },
                  "type": {
                    "default": "text",
                    "enum": [
                      "text",
                      "logo",
                      "both"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "text"
                ],
                "type": "object"
              }
            },
            "required": [
              "id",
              "name",
              "version",
              "watermark"
            ],
            "type": "object"
          },
          "maxItems": 30,
          "type": "array"
        },
        "watermarkSize": {
          "maximum": 12,
          "minimum": 3,
          "type": "integer"
        },
        "webWatermarkPresetId": {
          "default": null,
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        }
      },
      "required": [
        "name",
        "tagline",
        "email",
        "phone",
        "logoInitials",
        "logoAssetId",
        "color",
        "background",
        "textColor",
        "font",
        "watermarkColor",
        "watermarkOpacity",
        "watermarkPosition",
        "watermarkSize"
      ],
      "type": "object"
    },
    "logoUnavailable": {
      "description": "Stored logo is no longer eligible; its identity is redacted",
      "type": "boolean"
    },
    "revision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "brand",
    "logoUnavailable",
    "revision"
  ],
  "type": "object"
}
```
