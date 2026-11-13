# Frameleaf Assistant for Claude Desktop

The adapter bridges a local MCP stdio client to Frameleaf Library over HTTPS. For installation and sign-in, see [Connect a local AI assistant](../../docs/docs/features/ai-assistants.md).

Tool titles follow the computer's language and are returned by MCP `tools/list`. The MCPB 0.4 manifest schema permits only names and descriptions in its static tool metadata.

## Build the bundle

With Node.js 22.15 or later and npm 10 or later, run the following. The HTTPS test uses the OpenSSL command-line tool.

```sh
npm ci --ignore-scripts
npm test
npm run bundle
```

The installer is written to `.artifacts/frameleaf-assistant.mcpb`. The bundle includes native credential-store bindings for macOS and Windows on x64 and ARM64. Build inputs are locked in `package-lock.json`. The artifact keeps the license files distributed with its dependencies, including the keyring binaries’ Rust dependency notices. `KEYRING-LICENSE` comes from the [upstream source at the published keyring package’s commit](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/LICENSE).
