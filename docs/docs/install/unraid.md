---
sidebar_position: 40
---

# Unraid

:::warning Match the published release

This guide describes the upcoming release. Before installing, read the [release availability notice](/install/docker-compose). Use the published release's matching deployment files; its current `:latest` images must not be combined with the PostgreSQL 19 layout described here.

:::

[Frameleaf Manager](/install/manager) is the primary setup path on an Unraid Docker host. It detects **Settings → Docker → Default appdata storage location**, honors a custom share or pool, and shows the selected database location before setup. It creates a new database directory outside Docker's virtual disk.

## Prepare storage

Create separate persistent folders for Manager state, the library and database backups. Use your configured appdata location for PostgreSQL, or select another supported mounted disk folder. Do not point it at another application's database. Choose storage with enough free space and include the library in your independent media backup plan.

Follow the [Manager launcher and setup steps](/install/manager). Pass `auto` for its appdata argument to use Unraid's configured default. Manager needs its reviewed folders mounted at the same absolute host paths; it does not need access to every share on the server.

For imports, disable any additional scheduler that could recreate or restart the source containers. Review Manager's source mounts and recovery plan before confirming cutover. See [Import an existing library](/administration/import-library).

## Manual Compose alternative

If you already use Unraid's Compose Manager plugin, you can manage a manual Frameleaf stack:

1. Create a new stack and paste `docker-compose.yml` from one verified [Frameleaf release](https://github.com/Frameleaf/frameleaf-app/releases).
2. Paste that release's `example.env` into the stack's environment editor.
3. Set `UPLOAD_LOCATION` and `DB_DATA_LOCATION` to absolute persistent host paths. Use a fresh database directory and a private random `DB_PASSWORD`; set `FRAMELEAF_VERSION=latest` for the current application images.
4. Keep matching acceleration files with the stack if you enable them. Check the [manual Compose instructions](/install/docker-compose) before changing service definitions.
5. Start the stack, review container health and logs, then open `http://YOUR-UNRAID-HOST:2283` for [first setup](/install/post-install).

Use one management method for a stack. An installation created by Frameleaf Manager should be updated through Manager. For manual stacks, review the [upgrade guide](/install/upgrading), preserve the stack name and storage paths, and update all matching release files together.
