# Server API — People

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## deletePeople

`DELETE /api/people`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L90).

Delete people

Permission: `person.delete`. Admin only: `false`.

Models: [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Delete()
@Authenticated({ permission: Permission.PersonDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete people',
    description: 'Bulk delete a list of people at once.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Bulk delete a list of people at once.",
  "operationId": "deletePeople",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BulkIdsDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Delete people",
  "tags": [
    "People"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.delete",
  "x-immich-state": "Stable"
}
```

## getAllPeople

`GET /api/people`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L57).

Get all people

Permission: `person.read`. Admin only: `false`.

Models: [PeopleResponseDto](models-18.md#peopleresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Get()
@Authenticated({ permission: Permission.PersonRead })
@Endpoint({
    summary: 'Get all people',
    description: 'Retrieve a list of all people.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of all people.",
  "operationId": "getAllPeople",
  "parameters": [
    {
      "name": "closestAssetId",
      "required": false,
      "in": "query",
      "description": "Closest asset ID for similarity search",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "closestPersonId",
      "required": false,
      "in": "query",
      "description": "Closest person ID for similarity search",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "page",
      "required": false,
      "in": "query",
      "description": "Page number for pagination",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "default": 1,
        "type": "integer"
      }
    },
    {
      "name": "size",
      "required": false,
      "in": "query",
      "description": "Number of items per page",
      "schema": {
        "minimum": 1,
        "maximum": 1000,
        "default": 500,
        "type": "integer"
      }
    },
    {
      "name": "withHidden",
      "required": false,
      "in": "query",
      "description": "Include hidden people",
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
            "$ref": "#/components/schemas/PeopleResponseDto"
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
  "summary": "Get all people",
  "tags": [
    "People"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.read",
  "x-immich-state": "Stable"
}
```

## createPerson

`POST /api/people`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L68).

Create a person

Permission: `person.create`. Admin only: `false`.

Models: [PersonCreateDto](models-19.md#personcreatedto), [PersonResponseDto](models-19.md#personresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Post()
@Authenticated({ permission: Permission.PersonCreate })
@Endpoint({
    summary: 'Create a person',
    description: 'Create a new person that can have multiple faces assigned to them.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new person that can have multiple faces assigned to them.",
  "operationId": "createPerson",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PersonCreateDto"
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
            "$ref": "#/components/schemas/PersonResponseDto"
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
  "summary": "Create a person",
  "tags": [
    "People"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.create",
  "x-immich-state": "Stable"
}
```

## updatePeople

`PUT /api/people`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L79).

Update people

Permission: `person.update`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [PeopleUpdateDto](models-18.md#peopleupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Put()
@Authenticated({ permission: Permission.PersonUpdate })
@Endpoint({
    summary: 'Update people',
    description: 'Bulk update multiple people at once.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Bulk update multiple people at once.",
  "operationId": "updatePeople",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PeopleUpdateDto"
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
            "items": {
              "$ref": "#/components/schemas/BulkIdResponseDto"
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
  "summary": "Update people",
  "tags": [
    "People"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.update",
  "x-immich-state": "Stable"
}
```

## undoCorrection

`POST /api/people/corrections/{id}/undo`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L145).

Undo a face correction

Permission: `person.update`. Admin only: `false`.

Models: [PersonCorrectionDto](models-19.md#personcorrectiondto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Post('corrections/:id/undo')
@Authenticated({ permission: Permission.PersonUpdate })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Undo a face correction',
    description:
      'Reverse one manual face decision from the correction history, while the face still stands as the decision ' +
      'left it (same original, same place, same person). Otherwise 409 with a `reason`.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Reverse one manual face decision from the correction history, while the face still stands as the decision left it (same original, same place, same person). Otherwise 409 with a `reason`.",
  "operationId": "undoCorrection",
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
            "$ref": "#/components/schemas/PersonCorrectionDto"
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
  "summary": "Undo a face correction",
  "tags": [
    "People"
  ],
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
  "x-immich-permission": "person.update",
  "x-immich-state": "Alpha"
}
```

## mergePeople

`POST /api/people/merge`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L275).

Merge people

Permission: `person.merge`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [MergePersonDto](models-17.md#mergepersondto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Post('merge')
@Authenticated({ permission: Permission.PersonMerge })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Merge people',
    description:
      'Merge an ordered list of people together into a single person. The final name and birth date are always the first defined value, following the order. Also automatically merges people for other users in the cluster group, skipping people that would result in overriding a previously set name or birth date.',
    history: new HistoryBuilder().added('v3.2.1').stable('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Merge an ordered list of people together into a single person. The final name and birth date are always the first defined value, following the order. Also automatically merges people for other users in the cluster group, skipping people that would result in overriding a previously set name or birth date.",
  "operationId": "mergePeople",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MergePersonDto"
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
            "items": {
              "$ref": "#/components/schemas/BulkIdResponseDto"
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
  "summary": "Merge people",
  "tags": [
    "People"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.merge",
  "x-immich-state": "Stable"
}
```

## getMergeSuggestions

`GET /api/people/merge-suggestions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L105).

Get merge suggestions

Permission: `person.read`. Admin only: `false`.

Models: [MergeSuggestionsResponseDto](models-17.md#mergesuggestionsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Get('merge-suggestions')
@Authenticated({ permission: Permission.PersonRead })
@Endpoint({
    summary: 'Get merge suggestions',
    description:
      'Retrieve suggested pairs of people that may be the same person, based on face similarity, for the guided merge review flow.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve suggested pairs of people that may be the same person, based on face similarity, for the guided merge review flow.",
  "operationId": "getMergeSuggestions",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MergeSuggestionsResponseDto"
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
  "summary": "Get merge suggestions",
  "tags": [
    "People"
  ],
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
  "x-immich-permission": "person.read",
  "x-immich-state": "Alpha"
}
```

## deleteMergeVerdict

`DELETE /api/people/merge-suggestions/verdicts`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L132).

Undo a merge suggestion verdict

Permission: `person.update`. Admin only: `false`.

Models: [PersonMergeVerdictDeleteDto](models-19.md#personmergeverdictdeletedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Delete('merge-suggestions/verdicts')
@Authenticated({ permission: Permission.PersonUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Undo a merge suggestion verdict',
    description:
      'Remove the recorded verdict for a pair of people, so the pair can be suggested again. The same person id twice undoes "ignore" for that person.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove the recorded verdict for a pair of people, so the pair can be suggested again. The same person id twice undoes \"ignore\" for that person.",
  "operationId": "deleteMergeVerdict",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PersonMergeVerdictDeleteDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Undo a merge suggestion verdict",
  "tags": [
    "People"
  ],
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
  "x-immich-permission": "person.update",
  "x-immich-state": "Alpha"
}
```

## setMergeVerdict

`PUT /api/people/merge-suggestions/verdicts`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L117).

Record a merge suggestion verdict

Permission: `person.update`. Admin only: `false`.

Models: [PersonMergeVerdictCreateDto](models-19.md#personmergeverdictcreatedto), [PersonMergeVerdictResponseDto](models-19.md#personmergeverdictresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Put('merge-suggestions/verdicts')
@Authenticated({ permission: Permission.PersonUpdate })
@Endpoint({
    summary: 'Record a merge suggestion verdict',
    description:
      'Answer a suggested pair of people: "same" merges them now, "different" never suggests the pair again, "later" skips it for 30 days and "ignore" stops suggesting `personId` with anyone. Replaces an earlier verdict for the same pair (a "later" never replaces a "different"); the pair may be given in either order.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Answer a suggested pair of people: \"same\" merges them now, \"different\" never suggests the pair again, \"later\" skips it for 30 days and \"ignore\" stops suggesting `personId` with anyone. Replaces an earlier verdict for the same pair (a \"later\" never replaces a \"different\"); the pair may be given in either order.",
  "operationId": "setMergeVerdict",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PersonMergeVerdictCreateDto"
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
            "$ref": "#/components/schemas/PersonMergeVerdictResponseDto"
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
  "summary": "Record a merge suggestion verdict",
  "tags": [
    "People"
  ],
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
  "x-immich-permission": "person.update",
  "x-immich-state": "Alpha"
}
```

## deletePerson

`DELETE /api/people/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L200).

Delete person

Permission: `person.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Delete(':id')
@Authenticated({ permission: Permission.PersonDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete person',
    description: 'Delete an individual person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete an individual person.",
  "operationId": "deletePerson",
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
  "summary": "Delete person",
  "tags": [
    "People"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.delete",
  "x-immich-state": "Stable"
}
```

## getPerson

`GET /api/people/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L159).

Get a person

Permission: `person.read`. Admin only: `false`.

Models: [PersonResponseDto](models-19.md#personresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Get(':id')
@Authenticated({ permission: Permission.PersonRead })
@Endpoint({
    summary: 'Get a person',
    description: 'Retrieve a person by id.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a person by id.",
  "operationId": "getPerson",
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
            "$ref": "#/components/schemas/PersonResponseDto"
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
  "summary": "Get a person",
  "tags": [
    "People"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.read",
  "x-immich-state": "Stable"
}
```

## updatePerson

`PUT /api/people/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L170).

Update person

Permission: `person.update`. Admin only: `false`.

Models: [PersonResponseDto](models-19.md#personresponsedto), [PersonUpdateDto](models-19.md#personupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Put(':id')
@Authenticated({ permission: Permission.PersonUpdate })
@Endpoint({
    summary: 'Update person',
    description: 'Update an individual person.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updatePerson' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update an individual person.",
  "operationId": "updatePerson",
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
          "$ref": "#/components/schemas/PersonUpdateDto"
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
            "$ref": "#/components/schemas/PersonResponseDto"
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
  "summary": "Update person",
  "tags": [
    "People",
    "Deprecated"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    },
    {
      "version": "v3",
      "state": "Deprecated",
      "replacementId": "updatePerson"
    }
  ],
  "x-immich-permission": "person.update",
  "x-immich-state": "Deprecated"
}
```

## getCorrectionHistory

`GET /api/people/{id}/corrections`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L212).

Get correction history

Permission: `person.read`. Admin only: `false`.

Models: [PersonCorrectionsResponseDto](models-19.md#personcorrectionsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Get(':id/corrections')
@Authenticated({ permission: Permission.PersonRead })
@Endpoint({
    summary: 'Get correction history',
    description:
      'Retrieve the manual face decisions made about this person (faces moved onto or off them, "not a face of ' +
      'anyone", merges and moved face boxes), most recent first, a page at a time. Only the owner sees them. A ' +
      'photo that can no longer be shown (trashed, Locked, hidden) is left out of the evidence.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the manual face decisions made about this person (faces moved onto or off them, \"not a face of anyone\", merges and moved face boxes), most recent first, a page at a time. Only the owner sees them. A photo that can no longer be shown (trashed, Locked, hidden) is left out of the evidence.",
  "operationId": "getCorrectionHistory",
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
    },
    {
      "name": "page",
      "required": false,
      "in": "query",
      "description": "Page number",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "default": 1,
        "type": "integer"
      }
    },
    {
      "name": "size",
      "required": false,
      "in": "query",
      "description": "Number of decisions per page",
      "schema": {
        "minimum": 1,
        "maximum": 100,
        "default": 25,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PersonCorrectionsResponseDto"
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
  "summary": "Get correction history",
  "tags": [
    "People"
  ],
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
  "x-immich-permission": "person.read",
  "x-immich-state": "Alpha"
}
```

## mergePersonLegacy

`POST /api/people/{id}/merge`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L288).

Merge people

Permission: `person.merge`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [MergePersonDto](models-17.md#mergepersondto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Post(':id/merge')
@Authenticated({ permission: Permission.PersonMerge })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Merge people',
    description: 'Merge a list of people into the person specified in the path parameter.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3.2.1', { replacementId: 'mergePeople' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Merge a list of people into the person specified in the path parameter.",
  "operationId": "mergePersonLegacy",
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
          "$ref": "#/components/schemas/MergePersonDto"
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
            "items": {
              "$ref": "#/components/schemas/BulkIdResponseDto"
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
  "summary": "Merge people",
  "tags": [
    "People",
    "Deprecated"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    },
    {
      "version": "v3.2.1",
      "state": "Deprecated",
      "replacementId": "mergePeople"
    }
  ],
  "x-immich-permission": "person.merge",
  "x-immich-state": "Deprecated"
}
```

## reassignFaces

`PUT /api/people/{id}/reassign`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L260).

Reassign faces

Permission: `person.reassign`. Admin only: `false`.

Models: [AssetFaceUpdateDto](models-05.md#assetfaceupdatedto), [PersonResponseDto](models-19.md#personresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Put(':id/reassign')
@Authenticated({ permission: Permission.PersonReassign })
@Endpoint({
    summary: 'Reassign faces',
    description: 'Bulk reassign a list of faces to a different person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Bulk reassign a list of faces to a different person.",
  "operationId": "reassignFaces",
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
          "$ref": "#/components/schemas/AssetFaceUpdateDto"
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
            "items": {
              "$ref": "#/components/schemas/PersonResponseDto"
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
  "summary": "Reassign faces",
  "tags": [
    "People"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.reassign",
  "x-immich-state": "Stable"
}
```

## getPersonStatistics

`GET /api/people/{id}/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L230).

Get person statistics

Permission: `person.statistics`. Admin only: `false`.

Models: [PersonStatisticsResponseDto](models-19.md#personstatisticsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Get(':id/statistics')
@Authenticated({ permission: Permission.PersonStatistics })
@Endpoint({
    summary: 'Get person statistics',
    description: 'Retrieve statistics about a specific person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve statistics about a specific person.",
  "operationId": "getPersonStatistics",
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
            "$ref": "#/components/schemas/PersonStatisticsResponseDto"
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
  "summary": "Get person statistics",
  "tags": [
    "People"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.statistics",
  "x-immich-state": "Stable"
}
```

## getPersonThumbnail

`GET /api/people/{id}/thumbnail`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L241).

Get person thumbnail

Permission: `person.read`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Get(':id/thumbnail')
@FileResponse()
@Authenticated({ permission: Permission.PersonRead })
@RemoteMediaCeiling()
@Endpoint({
    summary: 'Get person thumbnail',
    description: 'Retrieve the thumbnail file for a person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the thumbnail file for a person.",
  "operationId": "getPersonThumbnail",
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
        "application/octet-stream": {
          "schema": {
            "format": "binary",
            "type": "string"
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
  "summary": "Get person thumbnail",
  "tags": [
    "People"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.read",
  "x-immich-state": "Stable"
}
```
