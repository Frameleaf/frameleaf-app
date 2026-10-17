# Errors

## Inconsistent Media Location

:::caution
This error is related to the location of media files _inside the container_. Never move files on the host system when you run into this error message.
:::

Frameleaf automatically tries to detect where your Frameleaf data is located. On start up, it compares the detected media location with the file paths in the database and throws an Inconsistent Media Location error when they do not match.

To fix this issue, verify that the `FRAMELEAF_MEDIA_LOCATION` environment variable and `UPLOAD_LOCATION` volume mount are in sync with the database paths.

If you would like to migrate from one media location to another, do the following steps:

1. Stop Frameleaf
2. Update `FRAMELEAF_MEDIA_LOCATION` to the new location
3. Update the right-hand side of the `UPLOAD_LOCATION` volume mount to the new location
4. Start up Frameleaf

Frameleaf detects when a media location has moved and automatically updates the database paths to keep them in sync.

## Schema drift

Schema drift is when the database schema is out of sync with the code. This could be the result of manual database tinkering, issues during a database restore, or something else. Schema drift can lead to data corruption, application bugs, and other unpredictable behavior. Please reconcile the differences as soon as possible. Specifically, missing `CONSTRAINT`s can result in duplicate assets being uploaded, since the server relies on a checksum `CONSTRAINT` to prevent duplicates.
