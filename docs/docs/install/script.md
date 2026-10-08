---
sidebar_position: 75
---

# Convenience install script

:::warning Match the published release

This guide describes the upcoming release. Before installing, read the [release availability notice](/install/docker-compose). Use the published release's matching deployment files; its current `:latest` images must not be combined with the PostgreSQL 19 layout described here.

:::

Use [Frameleaf Manager](/install/manager) for guided installation and recovery, or [Manual Docker Compose](/install/docker-compose) to choose storage and configuration explicitly.

The repository's `install.sh` is a convenience script for a **fresh** Compose installation. It requires Docker with Compose v2 and `curl`. Download and inspect the script from the same release or source revision you intend to use, then run it from an empty parent directory:

```sh
bash install.sh
```

It creates `./frameleaf-app`, downloads the latest release's Compose and example environment files, generates a database password, and starts the containers. It refuses to overwrite an existing `frameleaf-app` folder. The live library and PostgreSQL paths come from the downloaded `.env`; these are not media backups.

If installation fails, preserve the created files and inspect the error. Do not delete a retained library or database directory to make the script run again. Complete configuration using the [manual guide](/install/docker-compose).

After startup, open `http://YOUR-SERVER:2283` and follow [After installation](/install/post-install). This script does not install Frameleaf Manager.
