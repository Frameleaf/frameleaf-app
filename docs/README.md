# Frameleaf documentation

This is the source of the Frameleaf documentation site (help.frameleaf.app), built with [Docusaurus](https://docusaurus.io/).

### Installation

```
$ pnpm install
```

### Local Development

```
$ pnpm run start
```

This command starts a local development server on port 3005 and opens up a browser window. Most changes are reflected live without having to restart the server.

### Build

```
$ pnpm run build
```

This command copies the OpenAPI specification into `static/openapi.json` and generates static content into the `build` directory, which can be served using any static contents hosting service.

### Checks

The **Docs build** workflow checks formatting (`pnpm format`) and builds the site on every pull request to `main`. Run `pnpm format:fix` to apply the formatting it expects.
