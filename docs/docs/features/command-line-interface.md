# The Frameleaf CLI

Frameleaf has a command line interface (CLI) that allows you to perform certain actions from the command line.

## Features

- Upload photos and videos to Frameleaf
- Check server version

More features are planned for the future.

:::tip Google Photos Takeout
To import a Google Photos Takeout export, use [Import Google Photos](/features/google-photos-import) in Frameleaf.
:::

## Requirements

- Node.js 22 or above
- Npm

If you can't install node/npm, there is also a Docker version available below.

## Build from source

The CLI is the local `@frameleaf/cli` workspace package. From a Frameleaf repository checkout:

```bash
pnpm install --frozen-lockfile
pnpm --filter @frameleaf/sdk build
pnpm --filter @frameleaf/cli build
node packages/cli/bin/frameleaf --help
```

The `@frameleaf/cli` package provides the `frameleaf` command. The old command names (`immich`, and `immich-admin` and `immich-healthcheck` in the server image) still work as deprecated aliases of `frameleaf`, `frameleaf-admin` and `frameleaf-healthcheck`. They keep working for the whole of the current major version and stop working in the next major release of Frameleaf; no date is set for that release. The same rule applies to the [deprecated variable names](#deprecated-variable-names).

NOTE: if you previously installed the legacy CLI, you will need to uninstall it first:

```bash
npm uninstall -g immich
```

## Installation (Docker)

If npm is not available on your system you can try the Docker version

```bash
docker run -it -v "$(pwd)":/import:ro -e FRAMELEAF_INSTANCE_URL=https://your-frameleaf-server/api -e FRAMELEAF_API_KEY=your-api-key ghcr.io/frameleaf/frameleaf-cli:latest
```

Please modify the `FRAMELEAF_INSTANCE_URL` and `FRAMELEAF_API_KEY` environment variables as suitable. You can also use a Docker env file to store your sensitive API key.

This `docker run` command will directly run the command `frameleaf` inside the container. You can directly append the desired parameters (see under "usage") to the commandline like this:

```bash
docker run -it -v "$(pwd)":/import:ro -e FRAMELEAF_INSTANCE_URL=https://your-frameleaf-server/api -e FRAMELEAF_API_KEY=your-api-key ghcr.io/frameleaf/frameleaf-cli:latest upload -a -c 5 --recursive directory/
```

## Usage

<details>
<summary>Usage</summary>

```
$ frameleaf
Usage: frameleaf [options] [command]

Command line interface for Frameleaf

Options:
  -V, --version                       output the version number
  -d, --config-directory <directory>  Configuration directory where auth.yml will be stored (default: "~/.config/frameleaf/", env:
                                      FRAMELEAF_CONFIG_DIR)
  -u, --url [url]                     Frameleaf server URL (env: FRAMELEAF_INSTANCE_URL)
  -k, --key [key]                     Frameleaf API key (env: FRAMELEAF_API_KEY)
  -h, --help                          display help for command

Commands:
  login|login-key <url> <key>         Login using an API key
  logout                              Remove stored credentials
  server-info                         Display server information
  upload [options] [paths...]         Upload assets
  help [command]                      display help for command
```

</details>

## Commands

The upload command supports the following options:

<details>
<summary>Options</summary>

```
Usage: frameleaf upload [paths...] [options]

Upload assets

Arguments:
  paths                       One or more paths to assets to be uploaded

Options:
  -r, --recursive             Recursive (default: false, env: FRAMELEAF_RECURSIVE)
  -i, --ignore <pattern>      Pattern to ignore (env: FRAMELEAF_IGNORE_PATHS)
  -h, --skip-hash             Don't hash files before upload (default: false, env: FRAMELEAF_SKIP_HASH)
  -H, --include-hidden        Include hidden folders (default: false, env: FRAMELEAF_INCLUDE_HIDDEN)
  -a, --album                 Automatically create albums based on folder name (default: false, env: FRAMELEAF_AUTO_CREATE_ALBUM)
  -A, --album-name <name>     Add all assets to specified album (env: FRAMELEAF_ALBUM_NAME)
  --visibility <visibility>   Set the visibility of uploaded assets (choices: "archive", "timeline", "hidden", "locked", env: FRAMELEAF_VISIBILITY)
  -n, --dry-run               Don't perform any actions, just show what will be done (default: false, env: FRAMELEAF_DRY_RUN)
  -c, --concurrency <number>  Number of assets to upload at the same time (default: 4, env: FRAMELEAF_UPLOAD_CONCURRENCY)
  -j, --json-output           Output detailed information in json format (default: false, env: FRAMELEAF_JSON_OUTPUT)
  --delete                    Delete local assets after upload (env: FRAMELEAF_DELETE_ASSETS)
  --delete-duplicates         Delete local assets that are duplicates (already exist on server) (env: FRAMELEAF_DELETE_DUPLICATES)
  --no-progress               Hide progress bars (env: FRAMELEAF_PROGRESS_BAR)
  --watch                     Watch for changes and upload automatically (default: false, env: FRAMELEAF_WATCH_CHANGES)
  --help                      display help for command
```

</details>

Note that the above options can read from environment variables as well.

### Deprecated variable names

Each `FRAMELEAF_` variable the CLI reads also accepts its older `IMMICH_` name as a deprecated alias, so existing scripts keep working: `IMMICH_INSTANCE_URL`, `IMMICH_API_KEY`, `IMMICH_CONFIG_DIR`, `IMMICH_RECURSIVE`, `IMMICH_IGNORE_PATHS`, `IMMICH_SKIP_HASH`, `IMMICH_INCLUDE_HIDDEN`, `IMMICH_AUTO_CREATE_ALBUM`, `IMMICH_ALBUM_NAME`, `IMMICH_VISIBILITY`, `IMMICH_DRY_RUN`, `IMMICH_UPLOAD_CONCURRENCY`, `IMMICH_JSON_OUTPUT`, `IMMICH_DELETE_ASSETS`, `IMMICH_DELETE_DUPLICATES`, `IMMICH_PROGRESS_BAR`, `IMMICH_WATCH_CHANGES`, `IMMICH_FROM_URL`, `IMMICH_FROM_KEY`, `IMMICH_TO_URL`, `IMMICH_TO_KEY`, `IMMICH_MIGRATE_LEDGER`, `IMMICH_MIGRATE_CONCURRENCY` and `IMMICH_MIGRATE_PORT`. The new name is always `FRAMELEAF_` followed by the same suffix. If both names are set to different values, the CLI refuses to start and names the pair; an empty value counts as unset. See [Deprecated names](/install/environment-variables#deprecated-names) for the server variables.

## Quick Start

You begin by authenticating to your Frameleaf server. For instance:

```bash
# frameleaf login [url] [key]
frameleaf login http://192.168.1.216:2283/api HFEJ38DNSDUEG
```

This will store your credentials in a `auth.yml` file in the configuration directory which defaults to `~/.config/frameleaf/`. An existing `~/.config/immich/` directory is still used as long as `~/.config/frameleaf/` does not exist. The directory can be set with the `-d` option or the environment variable `FRAMELEAF_CONFIG_DIR`. Please keep the file secure, either by performing the logout command after you are done, or deleting it manually.

Once you are authenticated, you can upload assets to your Frameleaf server.

```bash
frameleaf upload file1.jpg file2.jpg
```

By default, subfolders are not included. To upload a directory including subfolder, use the --recursive option:

```bash
frameleaf upload --recursive directory/
```

If you are unsure what will happen, you can use the `--dry-run` option to see what would happen without actually performing any actions.

```bash
frameleaf upload --dry-run --recursive directory/
```

By default, the upload command will hash the files before uploading them. This is to avoid uploading the same file multiple times. If you are sure that the files are unique, you can skip this step by passing the `--skip-hash` option. Note that Frameleaf always performs its own deduplication through hashing, so this is merely a performance consideration. If you have good bandwidth it might be faster to skip hashing.

```bash
frameleaf upload --skip-hash --recursive directory/
```

You can automatically create albums based on the folder name by passing the `--album` option. This will automatically create albums for each uploaded asset based on the name of the folder they are in.

```bash
frameleaf upload --album --recursive directory/
```

You can also choose to upload all assets to a specific album with the `--album-name` option.

```bash
frameleaf upload --album-name "My summer holiday" --recursive directory/
```

It is possible to skip assets matching a glob pattern by passing the `--ignore` option. See [the library documentation](docs/features/libraries.md) on how to use glob patterns. You can add several exclusion patterns if needed.

```bash
frameleaf upload --ignore **/Raw/** --recursive directory/
```

```bash
frameleaf upload --ignore **/Raw/** **/*.tif --recursive directory/
```

By default, hidden files are skipped. If you want to include hidden files, use the `--include-hidden` option:

```bash
frameleaf upload --include-hidden --recursive directory/
```

You can set the visibility of uploaded assets to `archive`, `timeline`, `hidden`, or `locked` with the `--visibility` option:

```bash
frameleaf upload --visibility archive --recursive directory/
```

You can use the `--json-output` option to get a json printed which includes
three keys: `newFiles`, `duplicates` and `newAssets`. Due to some logging
output you will need to strip the first three lines of output to get the json.
For example to get a list of files that would be uploaded for further
processing:

```bash
frameleaf upload --dry-run --json-output . | tail -n +6 | jq .newFiles[]
```

### Obtain the API Key

The API key can be created in your account settings on the web interface. You can also specify permissions for the key to limit its access.

1. Select your avatar in the top right corner and choose **Account settings**.
2. In **Your preferences**, open **Account access**.
3. Under **API keys**, select **Create API key**.
4. Give the key a name and choose only the permissions the CLI needs, or full access.
5. Create the key and copy it. The key is shown only once.
