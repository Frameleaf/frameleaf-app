# Licensing and provenance

The plugin, tests and release script were written for Frameleaf against the public Frameleaf Connect HTTP contract and Obsidian's public plugin API (`obsidian.d.ts`, version 1.11.4 and later: `SecretStorage`, `requestUrl`, `Vault.createBinary`, `FileManager.getAvailablePathForAttachment` and `FileManager.generateMarkdownLink`). No Obsidian, Frameleaf Library or Immich source is included. This integration is licensed MIT; see [LICENSE](LICENSE).

The OAuth flow follows RFC 7636 (PKCE) and RFC 8252 (loopback redirect on `127.0.0.1` with a random port).
