# API

Frameleaf uses the [OpenAPI](https://swagger.io/specification/) standard to generate API documentation.

## Generator

OpenAPI is used to generate the TypeScript client SDK with [oazapfts](https://github.com/oazapfts/oazapfts). The generated SDK is based on the `immich-openapi-specs.json` file, which is generated from the server's `@nestjs/swagger` decorators used or referenced by controller endpoints. See the [NestJS OpenAPI docs](https://docs.nestjs.com/openapi/types-and-parameters) for more info. The development server serves the live specification at `/api/spec.json` but never writes the tracked file. When you add a new endpoint or modify an existing one, build the server and run the command below to regenerate the specification and update the client SDK.

```bash
mise open-api
```

You can find the generated TypeScript SDK in `packages/sdk`.
