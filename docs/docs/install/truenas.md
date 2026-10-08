---
sidebar_position: 80
---

# TrueNAS [Community]

:::warning Match the published release

This guide describes the upcoming release. Before installing, read the [release availability notice](/install/docker-compose). Use the published release's matching deployment files; its current `:latest` images must not be combined with the PostgreSQL 19 layout described here.

:::

:::note
This is a community contribution and not officially supported by Frameleaf, but included here for convenience.

Frameleaf is not in the TrueNAS apps catalog. The catalog's community app installs other software, not Frameleaf, so don't use it. Install Frameleaf from its Docker Compose file as a custom app instead.
:::

Use a TrueNAS edition with Docker-based **Custom App → Install via YAML** support. Check your installed version's [TrueNAS application documentation](https://www.truenas.com/docs/scale/scaletutorials/apps/) before starting; older Kubernetes-based app instructions do not apply to this Compose deployment.

## First steps

### Setting up Storage Datasets

Before beginning app installation, [create the datasets](https://www.truenas.com/docs/scale/scaletutorials/storage/datasets/datasetsscale/) that Frameleaf will store its data in.

In TrueNAS, the app requires 2 datasets for the application to function correctly: `data` and `pgData`. You can set the datasets to any names to match your naming conventions or preferences.
You can organize these as one parent with two child datasets, for example `/mnt/tank/frameleaf/data` and `/mnt/tank/frameleaf/pgData`.

### Dataset permissions

The processes inside the supplied containers need access to these datasets. Grant the server write access to `data` and allow the bundled PostgreSQL image to initialize and write `pgData`. Use an empty database dataset for a fresh installation and retain the image's configured user and entrypoint.

TrueNAS account names and the identity used by a catalog application do not define the user inside a custom Compose container. Do not assume that the host's `apps` or `netdata` account is the correct owner, or force the server and database to run under the same UID. If startup reports a permission error, inspect the failing container's logs and the dataset's owner, group and ACL against the image supplied in that release.

:::tip
To improve performance, we recommend using SSDs for the database. If you have a pool made of SSDs, you can create the `pgData` dataset on that pool.

Thumbnails can also be stored on the SSDs for faster access. This is an advanced option and not required for the app to run.
:::

If you apply ACLs or share the media dataset over SMB/NFS, the server must still be able to create, move and update its files. Read [TrueNAS dataset permissions](https://www.truenas.com/docs/scale/scaletutorials/datasets/permissionsscale/) when configuring the ACL. Do not modify files in the managed upload tree through the network share. Use [external libraries](/features/libraries) for an existing folder managed outside Frameleaf.

## Installing Frameleaf

1. Download [`docker-compose.yml`](https://github.com/Frameleaf/frameleaf-app/releases/latest/download/docker-compose.yml) and [`example.env`](https://github.com/Frameleaf/frameleaf-app/releases/latest/download/example.env) from the latest [Frameleaf release](https://github.com/Frameleaf/frameleaf-app/releases).
2. In `docker-compose.yml`, replace `${UPLOAD_LOCATION}` with the path of your `data` dataset (for example `/mnt/tank/frameleaf/data`) and `${DB_DATA_LOCATION}` with the path of your `pgData` dataset (for example `/mnt/tank/frameleaf/pgData`).
3. TrueNAS does not read a separate `.env` file. Remove the two `env_file` entries, then copy the values you need from `example.env` (at least `DB_PASSWORD`, `DB_USERNAME`, `DB_DATABASE_NAME` and `FRAMELEAF_VERSION`) into an `environment` section of each service, and replace the matching `${...}` references in the file. Choose your own database password and set `FRAMELEAF_VERSION=latest` for current application images.
4. In TrueNAS, go to **Apps**, click **Discover Apps**, open the menu next to **Custom App** and choose **Install via YAML**.
5. Give the app a name (for example, `frameleaf`), paste the edited Compose file and click **Save**.
6. When the app is running, open `http://<truenas-ip>:2283` and follow the [post-install steps](/install/post-install.mdx).

To update, download the Compose file of the new release, make the same edits, and replace the app's YAML with it. Read the [upgrade notes](/install/upgrading.md) first.
