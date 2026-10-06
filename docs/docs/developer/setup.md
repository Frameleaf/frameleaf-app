---
sidebar_position: 2
---

# Setup

:::warning
Make sure to read the [`CONTRIBUTING.md`](https://github.com/Frameleaf/frameleaf-app/blob/fork/main/CONTRIBUTING.md) before you dive into the code.
:::

:::note
If there's a feature you're planning to work on, just give us a heads up in [GitHub Discussions](https://github.com/Frameleaf/frameleaf-app/discussions) so we can:

1. Let you know if it's something we would accept into Frameleaf
2. Provide any guidance on how something like that would ideally be implemented
3. Ensure nobody is already working on that issue/feature so we don't duplicate effort

Thanks for being interested in contributing 😊
:::

## Environment

### Services

This environment includes the services below. Additional details are available in each service's README.

- Server - [`/server`](https://github.com/Frameleaf/frameleaf-app/tree/fork/main/server)
- Web app - [`/web`](https://github.com/Frameleaf/frameleaf-app/tree/fork/main/web)
- Machine learning - [`/machine-learning`](https://github.com/Frameleaf/frameleaf-app/tree/fork/main/machine-learning)
- PostgreSQL 19 with pgvector 0.8.7 and HNSW development database with exposed port `5432` so you can use any database client to access it

All the services are packaged to run with a single Docker Compose command.

:::tip mise
[mise](https://mise.jdx.dev) is used throughout the project to manage tool versions and run tasks. [Install mise](https://mise.jdx.dev/installing-mise.html), then from the repo root run `mise trust` and `mise install` to get all required tools. Tasks for each service can be run from the repo root using `mise //namespace:task` (e.g. `mise //server:lint`). To list all available tasks, run `mise tasks ls --all`.
:::

### Server and web apps

1. Clone the project repo.
2. Run `cp docker/example.env docker/.env`.
3. Edit `docker/.env` to provide values for the required variable `UPLOAD_LOCATION`.
4. Install dependencies - `mise x -- pnpm i`
5. From the root directory, run:

```bash title="Start development server"
mise dev
```

5. Access the dev instance in your browser at http://localhost:3000.

All the services will be started with hot-reloading enabled for a quick feedback loop.

You can access the web from `http://your-machine-ip:3000` or `http://localhost:3000` and point an API client at `http://your-machine-ip:3000`

**Notes:**

- The "web" development container runs with uid 1000. If that uid does not have read/write permissions on the mounted volumes, you may encounter errors

#### Connect web to a remote backend

If you only want to do web development connected to an existing, remote backend, run from the repo root:

```bash
FRAMELEAF_SERVER_URL=https://photos.example.com/ mise //web:start
```

This will install all dependencies (including the SDK) and start the dev server in one step. To connect to the hosted demo server specifically, use the shorthand:

```bash
mise //web:start-demo
```

If you're using PowerShell on Windows you may need to set the env var separately like so:

```powershell
$env:FRAMELEAF_SERVER_URL = "https://photos.example.com/"
mise //web:start
```

#### `@frameleaf/ui`

The UI lives in `packages/ui/dist/` as the local `@frameleaf/ui` workspace package. Edit its Svelte, JavaScript or CSS files directly and restart the web development server. No sibling checkout, npm download, alias or separate UI build is required. Preserve the included license and the Frameleaf accessibility fixes.

### Mobile apps

Frameleaf is building its own native iOS and Android apps. The inherited Flutter app has been removed from this repository, so there is no mobile app to build here yet. The server API is unchanged, so existing mobile clients can still connect to a development server at `http://your-machine-ip:3000`.

## IDE setup

### Lint / format extensions

Setting these in the IDE give a better developer experience, auto-formatting code on save, and providing instant feedback on lint issues.

### VSCode

Install the `Prettier`, `ESLint` and `Svelte` extensions. These extensions are listed in the `extensions.json` file under `.vscode/` and should appear as workspace recommendations.

Here are the settings we use, they should be active as workspace settings (`settings.json`):

```json title="settings.json"
{
  "[css]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.formatOnSave": true,
    "editor.tabSize": 2
  },
  "[javascript]": {
    "editor.codeActionsOnSave": {
      "source.organizeImports": "explicit",
      "source.removeUnusedImports": "explicit"
    },
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.formatOnSave": true,
    "editor.tabSize": 2
  },
  "[json]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.formatOnSave": true,
    "editor.tabSize": 2
  },
  "[jsonc]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.formatOnSave": true,
    "editor.tabSize": 2
  },
  "[svelte]": {
    "editor.codeActionsOnSave": {
      "source.organizeImports": "explicit",
      "source.removeUnusedImports": "explicit"
    },
    "editor.defaultFormatter": "svelte.svelte-vscode",
    "editor.formatOnSave": true,
    "editor.tabSize": 2
  },
  "[typescript]": {
    "editor.codeActionsOnSave": {
      "source.organizeImports": "explicit",
      "source.removeUnusedImports": "explicit"
    },
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.formatOnSave": true,
    "editor.tabSize": 2
  },
  "cSpell.words": ["immich"],
  "editor.formatOnSave": true,
  "eslint.validate": ["javascript", "svelte"],
  "explorer.fileNesting.enabled": true,
  "explorer.fileNesting.patterns": {
    "*.ts": "${capture}.spec.ts,${capture}.mock.ts"
  },
  "svelte.enable-ts-plugin": true,
  "typescript.preferences.importModuleSpecifier": "non-relative"
}
```
