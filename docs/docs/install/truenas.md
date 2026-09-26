---
sidebar_position: 80
---

# TrueNAS [Community]

:::note
This is a community contribution and not officially supported by Frameleaf, but included here for convenience.

Frameleaf is not in the TrueNAS apps catalog. The catalog's community app installs other software, not Frameleaf, so don't use it. Install Frameleaf from its Docker Compose file as a custom app instead.
:::

:::warning
This guide covers TrueNAS Community Edition 24.10.2.2 (Electric Eel) and later, which run apps with Docker. On an older version, upgrade first. Check the [TrueNAS Community Edition Release Notes](https://www.truenas.com/docs/softwarereleases/) for breaking changes and how to upgrade.
:::

## First steps

### Setting up Storage Datasets

Before beginning app installation, [create the datasets](https://www.truenas.com/docs/scale/scaletutorials/storage/datasets/datasetsscale/) that Frameleaf will store its data in.

In TrueNAS, the app requires 2 datasets for the application to function correctly: `data` and `pgData`. You can set the datasets to any names to match your naming conventions or preferences.
You can organize these as one parent with two child datasets, for example `/mnt/tank/frameleaf/data` and `/mnt/tank/frameleaf/pgData`.

:::info Datasets Permissions

The **pgData** dataset must be owned by the user `netdata` (UID 999) for Postgres to start.

The `data` dataset must have given the **_modify_** permission to the user who will run the app.

Since TrueNAS Community Edition 24.10.2.2 and later, the app can be run as any user and group, the default user being `apps` (UID 568) and the default group being `apps` (GID 568). This user, either `apps` or another user you choose, must have **_modify_** permissions on the **data** dataset.

For an easy setup:

- Create the parent dataset `frameleaf` keeping the default **Generic** preset.
- Select `Dataset Preset` **Apps** instead of **Generic** when creating the `data` dataset. This will automatically give the correct permissions to the dataset. If you want to use another user for the app, you can keep the **Generic** preset, but you will need to give the **_modify_** permission to that other user.
- For the `pgData` dataset, keep the default preset **Generic** and give ownership to the user `netdata` (UID 999).
  :::

:::tip
To improve performance, we recommend using SSDs for the database. If you have a pool made of SSDs, you can create the `pgData` dataset on that pool.

Thumbnails can also be stored on the SSDs for faster access. This is an advanced option and not required for the app to run.
:::

:::warning
If you just created the datasets using the **Apps** preset, you can skip this warning section.

If the **data** dataset uses ACL it must have [ACL mode](https://www.truenas.com/docs/scale/scaletutorials/datasets/permissionsscale/) set to `Passthrough` if you plan on using a [storage template](/administration/storage-template.mdx) and the dataset is configured for network sharing (its ACL type is set to `SMB/NFSv4`). When the template is applied and files need to be moved from **upload** to **library** (internal folder created by the server within the **data** dataset), the server performs `chmod` internally and must be allowed to execute the command.

To change or verify the ACL mode, go to the **Datasets** screen, select the **library** dataset, click on the **Edit** button next to **Dataset Details**, then click on the **Advanced Options** tab, scroll down to the **ACL Mode** section, and select `Passthrough` from the dropdown menu. Click **Save** to apply the changes. If the option is greyed out, set the **ACL Type** to `SMB/NFSv4` first, then you can change the **ACL Mode** to `Passthrough`.
:::

## Installing Frameleaf

1. Download [`docker-compose.yml`](https://github.com/Frameleaf/frameleaf-app/releases/latest/download/docker-compose.yml) and [`example.env`](https://github.com/Frameleaf/frameleaf-app/releases/latest/download/example.env) from the latest [Frameleaf release](https://github.com/Frameleaf/frameleaf-app/releases).
2. In `docker-compose.yml`, replace `${UPLOAD_LOCATION}` with the path of your `data` dataset (for example `/mnt/tank/frameleaf/data`) and `${DB_DATA_LOCATION}` with the path of your `pgData` dataset (for example `/mnt/tank/frameleaf/pgData`).
3. TrueNAS does not read a separate `.env` file. Remove the two `env_file` entries, then copy the values you need from `example.env` (at least `DB_PASSWORD`, `DB_USERNAME`, `DB_DATABASE_NAME` and `IMMICH_VERSION`) into an `environment` section of each service, and replace the matching `${...}` references in the file. Choose your own database password.
4. In TrueNAS, go to **Apps**, click **Discover Apps**, open the menu next to **Custom App** and choose **Install via YAML**.
5. Give the app a name (for example, `frameleaf`), paste the edited Compose file and click **Save**.
6. When the app is running, open `http://<truenas-ip>:2283` and follow the [post-install steps](/install/post-install.mdx).

To update, download the Compose file of the new release, make the same edits, and replace the app's YAML with it. Read the [upgrade notes](/install/upgrading.md) first.
