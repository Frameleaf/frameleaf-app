# External Library

import ComposeBuilder from '/docs/partials/_compose-builder.mdx';

This guide walks you through adding an [External Library](/features/libraries).
This guide assumes you are running Frameleaf in Docker and that the files you wish to access are stored
in a directory on the same machine.

# Mount the directory into the containers.

<ComposeBuilder query="storage.externalLibraries.0.path=&storage.externalLibraries.0.readOnly=true" />

Edit `docker-compose.yml` to add one or more new mount points in the section `immich-server:` under `volumes:`.
If you want Frameleaf to be able to delete the images in the external library or add metadata ([XMP sidecars](/features/xmp-sidecars)), remove `:ro` from the end of the mount point.

```diff
immich-server:
    volumes:
        - ${UPLOAD_LOCATION}:/data
+       - /home/user/photos1:/home/user/photos1:ro
+       - /mnt/photos2:/mnt/photos2:ro # you can delete this line if you only have one mount point, or you can add more lines if you have more than two
```

Restart Frameleaf by running `docker compose up -d`.

# Create the library

:::info
External library management requires administrator access and the steps below assume you are using an admin account.
:::

In the Frameleaf web UI:

1. Select **Settings** in the sidebar to open the Command Center, then open **Libraries**.
2. Select **Add external library**.
3. Enter a name for the library and choose its **Owner**. Ownership is fixed after the library is created.
4. Under **Import folders**, add **/home/user/photos1** as the folder to scan.
5. Select **Create library**. Saving the library does not start a scan.
6. Select the new library in the list, then select **Scan library**.

# Confirm stuff is happening

1. Select **Settings** in the sidebar to open the Command Center, then open **Compute & jobs**.
2. You should see active jobs for the library scan, thumbnail generation and metadata extraction.
