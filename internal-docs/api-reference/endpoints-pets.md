# Server API — Pets

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAllPets

`GET /api/pets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L41).

Retrieve pets

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetResponseDto](models-19.md#petresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Get()
@Authenticated()
@Endpoint({
    summary: 'Retrieve pets',
    description: 'Retrieve the signed-in account’s pet identities.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the signed-in account’s pet identities.",
  "operationId": "getAllPets",
  "parameters": [
    {
      "name": "withHidden",
      "required": false,
      "in": "query",
      "description": "Include hidden pets",
      "schema": {
        "type": "boolean"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PetResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve pets",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## createPet

`POST /api/pets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L52).

Create a pet

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetCreateDto](models-19.md#petcreatedto), [PetResponseDto](models-19.md#petresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Post()
@Authenticated()
@Endpoint({
    summary: 'Create a pet',
    description: 'Create a durable pet identity with a name, species and optional birthday.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a durable pet identity with a name, species and optional birthday.",
  "operationId": "createPet",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PetCreateDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Create a pet",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## getPetCandidates

`GET /api/pets/candidates`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L63).

Retrieve pet recognition candidates

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetCandidateListResponseDto](models-19.md#petcandidatelistresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Get('candidates')
@Authenticated()
@Endpoint({
    summary: 'Retrieve pet recognition candidates',
    description:
      'Retrieve recognition proposals awaiting review, with whether a recognition model is available at all.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve recognition proposals awaiting review, with whether a recognition model is available at all.",
  "operationId": "getPetCandidates",
  "parameters": [
    {
      "name": "size",
      "required": false,
      "in": "query",
      "description": "Number of candidates to return",
      "schema": {
        "minimum": 1,
        "maximum": 500,
        "default": 100,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetCandidateListResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve pet recognition candidates",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## acceptPetCandidate

`POST /api/pets/candidates/{id}/accept`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L75).

Accept a pet recognition candidate

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetCandidateReviewDto](models-19.md#petcandidatereviewdto), [PetObservationResponseDto](models-19.md#petobservationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Post('candidates/:id/accept')
@Authenticated()
@Endpoint({
    summary: 'Accept a pet recognition candidate',
    description:
      'Record a durable confirmed observation for the proposed pet, or for a different pet when one is supplied.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Record a durable confirmed observation for the proposed pet, or for a different pet when one is supplied.",
  "operationId": "acceptPetCandidate",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PetCandidateReviewDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetObservationResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Accept a pet recognition candidate",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## rejectPetCandidate

`POST /api/pets/candidates/{id}/reject`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L91).

Reject a pet recognition candidate

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetCandidateRejectDto](models-19.md#petcandidaterejectdto), [PetObservationResponseDto](models-19.md#petobservationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Post('candidates/:id/reject')
@Authenticated()
@Endpoint({
    summary: 'Reject a pet recognition candidate',
    description: 'Record a durable rejection so the proposal does not return after the model is rerun.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Record a durable rejection so the proposal does not return after the model is rerun.",
  "operationId": "rejectPetCandidate",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PetCandidateRejectDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetObservationResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Reject a pet recognition candidate",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## getAssetPetObservations

`GET /api/pets/observations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L141).

Retrieve the pet observations of an asset

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetObservationResponseDto](models-19.md#petobservationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Get('observations')
@Authenticated()
@Endpoint({
    summary: 'Retrieve the pet observations of an asset',
    description: 'Retrieve the signed-in account’s decisions about which of its pets appear in one asset.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the signed-in account’s decisions about which of its pets appear in one asset.",
  "operationId": "getAssetPetObservations",
  "parameters": [
    {
      "name": "assetId",
      "required": true,
      "in": "query",
      "description": "Asset whose pet observations to list",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PetObservationResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve the pet observations of an asset",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## deletePetObservation

`DELETE /api/pets/observations/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L155).

Remove a pet observation

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Delete('observations/:id')
@Authenticated()
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Remove a pet observation',
    description:
      'Undo a durable observation, whether it was drawn by hand or made in review. With `expectedChecksum`, refused with 409 when the original changed.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Undo a durable observation, whether it was drawn by hand or made in review. With `expectedChecksum`, refused with 409 when the original changed.",
  "operationId": "deletePetObservation",
  "parameters": [
    {
      "name": "expectedChecksum",
      "required": false,
      "in": "query",
      "description": "Checksum of the original the decision was made on (base64); refused with 409 when it changed",
      "schema": {
        "minLength": 1,
        "maxLength": 200,
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Remove a pet observation",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## cancelPetRecognition

`DELETE /api/pets/recognition`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L130).

Cancel pet recognition

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetRecognitionStatusResponseDto](models-19.md#petrecognitionstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Delete('recognition')
@Authenticated()
@Endpoint({
    summary: 'Cancel pet recognition',
    description: 'Cancel the running pet recognition run over this library. Proposals already made stay for review.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Cancel the running pet recognition run over this library. Proposals already made stay for review.",
  "operationId": "cancelPetRecognition",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetRecognitionStatusResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Cancel pet recognition",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## getPetRecognition

`GET /api/pets/recognition`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L106).

Retrieve pet recognition status

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetRecognitionStatusResponseDto](models-19.md#petrecognitionstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Get('recognition')
@Authenticated()
@Endpoint({
    summary: 'Retrieve pet recognition status',
    description:
      'Whether pet recognition can run on the destination it is routed to, why not when it cannot, and the latest run over this library.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether pet recognition can run on the destination it is routed to, why not when it cannot, and the latest run over this library.",
  "operationId": "getPetRecognition",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetRecognitionStatusResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve pet recognition status",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## startPetRecognition

`POST /api/pets/recognition`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L118).

Start pet recognition

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetRecognitionStatusResponseDto](models-19.md#petrecognitionstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Post('recognition')
@Authenticated()
@Endpoint({
    summary: 'Start pet recognition',
    description:
      'Look through this library for the pets confirmed so far, on the routed destination only. Refused with the reason when recognition is unavailable.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Look through this library for the pets confirmed so far, on the routed destination only. Refused with the reason when recognition is unavailable.",
  "operationId": "startPetRecognition",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetRecognitionStatusResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Start pet recognition",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## deletePet

`DELETE /api/pets/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L194).

Delete a pet

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Delete(':id')
@Authenticated()
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a pet',
    description: 'Delete a pet identity and every observation recorded for it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a pet identity and every observation recorded for it.",
  "operationId": "deletePet",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Delete a pet",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## getPet

`GET /api/pets/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L172).

Retrieve a pet

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetResponseDto](models-19.md#petresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Get(':id')
@Authenticated()
@Endpoint({
    summary: 'Retrieve a pet',
    description: 'Retrieve a single pet identity.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a single pet identity.",
  "operationId": "getPet",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve a pet",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## updatePet

`PUT /api/pets/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L183).

Update a pet

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetResponseDto](models-19.md#petresponsedto), [PetUpdateDto](models-19.md#petupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Put(':id')
@Authenticated()
@Endpoint({
    summary: 'Update a pet',
    description: 'Update a pet’s name, species, birthday, featured photo, hidden or favorite state.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Update a pet’s name, species, birthday, featured photo, hidden or favorite state.",
  "operationId": "updatePet",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PetUpdateDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Update a pet",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## mergePets

`POST /api/pets/{id}/merge`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L206).

Merge pets

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetMergeDto](models-19.md#petmergedto), [PetResponseDto](models-19.md#petresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Post(':id/merge')
@Authenticated()
@Endpoint({
    summary: 'Merge pets',
    description: 'Merge other pet identities into this one, keeping every durable observation.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Merge other pet identities into this one, keeping every durable observation.",
  "operationId": "mergePets",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PetMergeDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Merge pets",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## getPetObservations

`GET /api/pets/{id}/observations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L217).

Retrieve pet observations

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetObservationResponseDto](models-19.md#petobservationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Get(':id/observations')
@Authenticated()
@Endpoint({
    summary: 'Retrieve pet observations',
    description: 'Retrieve the durable observations recorded for a pet.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the durable observations recorded for a pet.",
  "operationId": "getPetObservations",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PetObservationResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve pet observations",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## createPetObservation

`POST /api/pets/{id}/observations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/pet.controller.ts#L228).

Add a pet observation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PetObservationCreateDto](models-19.md#petobservationcreatedto), [PetObservationResponseDto](models-19.md#petobservationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Pets)
@Controller('pets')
@Post(':id/observations')
@Authenticated()
@Endpoint({
    summary: 'Add a pet observation',
    description: 'Record by hand that a pet appears in an asset, optionally with a drawn region.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Record by hand that a pet appears in an asset, optionally with a drawn region.",
  "operationId": "createPetObservation",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PetObservationCreateDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PetObservationResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Add a pet observation",
  "tags": [
    "Pets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```
