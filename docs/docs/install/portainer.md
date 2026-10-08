---
sidebar_position: 50
---

# Portainer

:::warning Match the published release

This guide describes the upcoming release. Before installing, read the [release availability notice](/install/docker-compose). Use the published release's matching deployment files; its current `:latest` images must not be combined with the PostgreSQL 19 layout described here.

:::

Install Frameleaf using Portainer's Stack feature.

1. Go to "**Stacks**" in the left sidebar.
2. Click on "**Add stack**".
3. Give the stack a name (for example, frameleaf), and select "**Web Editor**" as the build method.
4. Copy the content of the `docker-compose.yml` file from the [Frameleaf release](https://github.com/Frameleaf/frameleaf-app/releases/latest/download/docker-compose.yml).
5. In the web editor, find every `env_file:` entry and replace `.env` with `stack.env` for all containers that need to use environment variables.
6. Click on "**Advanced Mode**" in the **Environment Variables** section.

7. Copy the content of the `example.env` file from the [Frameleaf release](https://github.com/Frameleaf/frameleaf-app/releases/latest/download/example.env) and paste into the editor.
8. Switch back to "**Simple Mode**" and review the variables:

- Set `FRAMELEAF_VERSION=latest` for current application images.
- Change the default `DB_PASSWORD`, and add custom database connection information if necessary.
- Change `DB_DATA_LOCATION` to a folder (absolute path) where the database will be saved to disk.
- Change `UPLOAD_LOCATION` to a folder (absolute path) where media (uploaded and generated) will be stored.

9. Click on "**Deploy the stack**".

:::tip
For more information on how to use the application, see the [Post Installation](/install/post-install.mdx) guide.
:::
