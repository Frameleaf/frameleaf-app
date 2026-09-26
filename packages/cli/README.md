A command-line interface for the self-hosted Frameleaf photo library.

See the [CLI documentation](https://help.frameleaf.ai/features/command-line-interface).

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
****
