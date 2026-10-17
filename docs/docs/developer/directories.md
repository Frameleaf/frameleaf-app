---
title: Directories
---

# Repository Folder Structure

The [Frameleaf GitHub Repository](https://github.com/Frameleaf/frameleaf-app) is a [monorepo](https://en.wikipedia.org/wiki/Monorepo) and includes the following folders:

| Folder                                        | Description                                                           |
| :-------------------------------------------- | :-------------------------------------------------------------------- |
| `.devcontainer/`                              | Dev container configuration (see [Devcontainers](./devcontainers.md)) |
| `.github/`                                    | GitHub templates and action workflows                                 |
| `.vscode/`                                    | VSCode debug launch profiles                                          |
| `deployment/`                                 | Docs site infrastructure and iCloud sync deployment files             |
| `design/`                                     | Design references, brand kit and design tokens                        |
| `docker/`                                     | Docker compose resources for dev, test, production                    |
| `docs/`                                       | Source code for the documentation website                             |
| `e2e/`                                        | End-to-end tests and their compose fixtures                           |
| `i18n/`                                       | Translation files (`en.json` is the source)                           |
| `icloud-bridge/`                              | Source code for the iCloud bridge service                             |
| `licenses/`                                   | Third-party notices and licence texts                                 |
| `machine-learning/`                           | Source code for the `frameleaf-machine-learning` docker image         |
| `manager/`                                    | Source code for Frameleaf Manager                                     |
| `open-api/`                                   | Generated OpenAPI specification (`immich-openapi-specs.json`)         |
| `packages/cli`                                | Source code for the CLI                                               |
| `packages/sdk`                                | Source code for the generated OpenAPI SDK                             |
| `packages/sql-tools`                          | Vendored schema and migration tooling                                 |
| `packages/ui`                                 | Shared web UI components                                              |
| `packages/plugin-core`, `packages/plugin-sdk` | Plugin runtime and SDK                                                |
| `packages/scripts`                            | Scripts for version bumps and draft releases                          |
| `packaging/nas/`                              | NAS packages (Unraid, TrueNAS and Synology)                           |
| `scripts/`                                    | Repository maintenance and CI helper scripts                          |
| `server/`                                     | Source code for the `frameleaf-server` docker image                   |
| `studio/`                                     | Studio engine preservation contracts and isolated engine build        |
| `web/`                                        | Source code for the `web`                                             |
