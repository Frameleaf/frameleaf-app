A command-line interface for the self-hosted Frameleaf photo library.

See the [CLI documentation](https://help.frameleaf.app/features/command-line-interface).

# For developers

Before building the CLI, you must build the server and the open-api client. You can use the following command:

    $ mise //:open-api

## Run from build

Go to the cli folder and build it:

    $ pnpm install
    $ pnpm run build
    $ node dist/index.js

## Run and Debug from source (VSCode)

With VS Code you can run and debug the CLI. Go to the launch.json file, find the CLI config and change this with the command you need to debug

`"args": ["upload", "--help"],`

replace that for the command of your choice.

## Install from build

You can also build and install the CLI using

    $ pnpm run build
    $ pnpm install -g .

## Recovering encrypted Locked files

`frameleaf locked decrypt --library /path/to/library --to /path/to/recovered [--user <name or ID>] [--all]` decrypts encrypted Locked files from a copy of the library. It runs offline and needs no login. It asks for your PIN, passphrase or recovery key without showing it. Exit code 0 means every file decrypted, 1 means some files were damaged and skipped, and 2 means a wrong secret, no key file or bad arguments.

A PIN set on a server that has the Locked pepper (every server since key file format 2) only opens the key file together with that pepper, so a copy of the library alone is not enough to try PINs offline. The server keeps it in its identity folder (`FRAMELEAF_IDENTITY_DIR`, by default `<media>/frameleaf/identity`) as `locked-pin-pepper.key`; keep that folder off the media volume and in your private backups. Pass it with `--pepper-file /path/to/locked-pin-pepper.key`, or put the file's contents in the `FRAMELEAF_LOCKED_PEPPER` environment variable. The recovery key and a passphrase never need it.
