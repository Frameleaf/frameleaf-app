# Server API — Download

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## downloadArchive

`POST /api/download/archive`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/download.controller.ts#L29).

Download asset archive

Permission: `asset.download`. Admin only: `false`.

Models: [DownloadArchiveDto](models-10.md#downloadarchivedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Download)
@Controller('download')
@Post('archive')
@Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
@OriginalTransfer()
@FileResponse()
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Download asset archive',
    description:
      'Download a ZIP archive containing the specified assets. The assets must have been previously requested via the "getDownloadInfo" endpoint.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Download a ZIP archive containing the specified assets. The assets must have been previously requested via the \"getDownloadInfo\" endpoint.",
  "operationId": "downloadArchive",
  "parameters": [
    {
      "name": "key",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "slug",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/DownloadArchiveDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Download asset archive",
  "tags": [
    "Download"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Stable"
}
```

## getDownloadInfo

`POST /api/download/info`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/download.controller.ts#L17).

Retrieve download information

Permission: `asset.download`. Admin only: `false`.

Models: [DownloadInfoDto](models-11.md#downloadinfodto), [DownloadResponseDto](models-11.md#downloadresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Download)
@Controller('download')
@Post('info')
@Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
@Endpoint({
    summary: 'Retrieve download information',
    description:
      'Retrieve information about how to request a download for the specified assets or album. The response includes groups of assets that can be downloaded together.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve information about how to request a download for the specified assets or album. The response includes groups of assets that can be downloaded together.",
  "operationId": "getDownloadInfo",
  "parameters": [
    {
      "name": "key",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "slug",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/DownloadInfoDto"
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
            "$ref": "#/components/schemas/DownloadResponseDto"
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
  "summary": "Retrieve download information",
  "tags": [
    "Download"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Stable"
}
```
