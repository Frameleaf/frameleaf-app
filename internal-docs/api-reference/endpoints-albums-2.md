# Server API — Albums 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## createClassificationRule

`POST /api/classification/rules`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/classification.controller.ts#L63).

Create a classification rule

Permission: `album.create`. Admin only: `false`.

Models: [ClassificationRuleCreateDto](models-08.md#classificationrulecreatedto), [ClassificationRuleResponseDto](models-08.md#classificationruleresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Post('rules')
@Authenticated({ permission: Permission.AlbumCreate })
@Endpoint({
    summary: 'Create a classification rule',
    description:
      'Create a smart album and the rule that fills it. Nothing is matched until the rule is applied. Archiving matches requires `archiveConsent`.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a smart album and the rule that fills it. Nothing is matched until the rule is applied. Archiving matches requires `archiveConsent`.",
  "operationId": "createClassificationRule",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ClassificationRuleCreateDto"
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
            "$ref": "#/components/schemas/ClassificationRuleResponseDto"
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
  "summary": "Create a classification rule",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.create",
  "x-immich-state": "Alpha"
}
```

## deleteClassificationRule

`DELETE /api/classification/rules/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/classification.controller.ts#L124).

Delete a classification rule

Permission: `album.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Delete('rules/:id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.AlbumUpdate })
@Endpoint({
    summary: 'Delete a classification rule',
    description: 'Stop the rule. Its album stays as an ordinary album with everything in it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Stop the rule. Its album stays as an ordinary album with everything in it.",
  "operationId": "deleteClassificationRule",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
  "summary": "Delete a classification rule",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.update",
  "x-immich-state": "Alpha"
}
```

## getClassificationRule

`GET /api/classification/rules/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/classification.controller.ts#L94).

Retrieve a classification rule

Permission: `album.read`. Admin only: `false`.

Models: [ClassificationRuleResponseDto](models-08.md#classificationruleresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Get('rules/:id')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'Retrieve a classification rule',
    description: 'One of your smart album rules and its counts.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "One of your smart album rules and its counts.",
  "operationId": "getClassificationRule",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ClassificationRuleResponseDto"
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
  "summary": "Retrieve a classification rule",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.read",
  "x-immich-state": "Alpha"
}
```

## updateClassificationRule

`PATCH /api/classification/rules/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/classification.controller.ts#L108).

Update a classification rule

Permission: `album.update`. Admin only: `false`.

Models: [ClassificationRuleResponseDto](models-08.md#classificationruleresponsedto), [ClassificationRuleUpdateDto](models-08.md#classificationruleupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Patch('rules/:id')
@Authenticated({ permission: Permission.AlbumUpdate })
@Endpoint({
    summary: 'Update a classification rule',
    description:
      'Change what the rule matches, what it does, or turn it off. A rule that is off keeps what it applied. Turning archiving on requires `archiveConsent`.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Change what the rule matches, what it does, or turn it off. A rule that is off keeps what it applied. Turning archiving on requires `archiveConsent`.",
  "operationId": "updateClassificationRule",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ClassificationRuleUpdateDto"
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
            "$ref": "#/components/schemas/ClassificationRuleResponseDto"
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
  "summary": "Update a classification rule",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.update",
  "x-immich-state": "Alpha"
}
```

## applyClassificationRule

`POST /api/classification/rules/{id}/apply`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/classification.controller.ts#L152).

Apply a classification rule

Permission: `album.update`. Admin only: `false`.

Models: [ClassificationApplyDto](models-07.md#classificationapplydto), [ClassificationApplyResponseDto](models-07.md#classificationapplyresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Post('rules/:id/apply')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AlbumUpdate })
@Endpoint({
    summary: 'Apply a classification rule',
    description:
      'Apply the rule to up to 500 items from its plan. Larger plans run as an `apply-classification-rule` bulk media operation.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Apply the rule to up to 500 items from its plan. Larger plans run as an `apply-classification-rule` bulk media operation.",
  "operationId": "applyClassificationRule",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ClassificationApplyDto"
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
            "$ref": "#/components/schemas/ClassificationApplyResponseDto"
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
  "summary": "Apply a classification rule",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.update",
  "x-immich-state": "Alpha"
}
```

## decideClassificationRuleMatches

`POST /api/classification/rules/{id}/decisions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/classification.controller.ts#L184).

Review classification rule matches

Permission: `album.update`. Admin only: `false`.

Models: [ClassificationDecisionDto](models-07.md#classificationdecisiondto), [ClassificationDecisionResponseDto](models-07.md#classificationdecisionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Post('rules/:id/decisions')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AlbumUpdate })
@Endpoint({
    summary: 'Review classification rule matches',
    description:
      'Accept matches (they stay whatever later processing finds) or reject them (what the rule applied is taken back and never applied again).',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Accept matches (they stay whatever later processing finds) or reject them (what the rule applied is taken back and never applied again).",
  "operationId": "decideClassificationRuleMatches",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ClassificationDecisionDto"
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
            "$ref": "#/components/schemas/ClassificationDecisionResponseDto"
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
  "summary": "Review classification rule matches",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.update",
  "x-immich-state": "Alpha"
}
```

## getClassificationRuleMatches

`GET /api/classification/rules/{id}/matches`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/classification.controller.ts#L169).

List classification rule matches

Permission: `album.read`. Admin only: `false`.

Models: [ClassificationMatchDecision](models-07.md#classificationmatchdecision), [ClassificationMatchPageDto](models-07.md#classificationmatchpagedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Get('rules/:id/matches')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'List classification rule matches',
    description: 'The rule’s matches with one decision, suggestions to review by default.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The rule’s matches with one decision, suggestions to review by default.",
  "operationId": "getClassificationRuleMatches",
  "parameters": [
    {
      "name": "decision",
      "required": false,
      "in": "query",
      "schema": {
        "default": "suggested",
        "$ref": "#/components/schemas/ClassificationMatchDecision"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "page",
      "required": false,
      "in": "query",
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
            "$ref": "#/components/schemas/ClassificationMatchPageDto"
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
  "summary": "List classification rule matches",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.read",
  "x-immich-state": "Alpha"
}
```

## planClassificationRule

`POST /api/classification/rules/{id}/plan`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/classification.controller.ts#L136).

Plan a classification rule re-evaluation

Permission: `album.read`. Admin only: `false`.

Models: [ClassificationPlanResponseDto](models-07.md#classificationplanresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Post('rules/:id/plan')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'Plan a classification rule re-evaluation',
    description:
      'What applying the rule now would add, suggest and take back, without writing anything. Manual decisions are never part of it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "What applying the rule now would add, suggest and take back, without writing anything. Manual decisions are never part of it.",
  "operationId": "planClassificationRule",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ClassificationPlanResponseDto"
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
  "summary": "Plan a classification rule re-evaluation",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.read",
  "x-immich-state": "Alpha"
}
```

## getClassificationSettings

`GET /api/classification/settings`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/classification.controller.ts#L38).

Retrieve classification rule settings

Permission: `album.read`. Admin only: `false`.

Models: [ClassificationSettingsDto](models-08.md#classificationsettingsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Get('settings')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'Retrieve classification rule settings',
    description: 'Whether rules may use visual categories, whether those can be compared now, and the default action.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether rules may use visual categories, whether those can be compared now, and the default action.",
  "operationId": "getClassificationSettings",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ClassificationSettingsDto"
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
  "summary": "Retrieve classification rule settings",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.read",
  "x-immich-state": "Alpha"
}
```
