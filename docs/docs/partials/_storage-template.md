Frameleaf allows the admin user to set the uploaded filename pattern at the directory and filename level as well as the [storage label for a user](/administration/user-management/#set-storage-label-for-user).

:::tip
Back up the database and matching media together before moving stored files. See [what to preserve](/administration/backup-and-restore#what-to-preserve).
:::

The admin user can set the template by using the template builder in **Settings → Storage & originals → Originals & folder structure**. Frameleaf provides a set of variables that you can use in constructing the template, along with additional custom text. If the template produces multiple files with the same filename, they won't be overwritten as a sequence number is appended to the filename.

Date and time variables in storage templates are rendered in the server's local timezone.

```bash title="Default template"
Year/Year-Month-Day/Filename.Extension
```

If you want to change the storage template during the initial setup:

1. In **Settings → Storage & originals → Originals & folder structure**, turn on **Enable storage template engine**. Leave hash verification on unless you are certain of the implications.
2. Choose a preset, or type your own template using the variables listed on the page. The preview shows the resulting path for a sample asset.
3. Select **Save changes**.

:::info
The **Storage organization** job can be run after enabling this feature or changing the template, in order to apply the changes to the existing library. Start it from **Settings → Computers & background work → Background work**.
:::

:::tip
If an asset is in multiple albums, `{{album}}` will be set to the name of the album which was most recently created. By default, special characters will be converted to an HTML entity (for example, `&` -> `&amp;`). To prevent this, wrap the variable in an extra set of braces (for example, `{{{album}}}`). You can learn more about this in the [Handlebars documentation](https://handlebarsjs.com/guide/expressions.html#html-escaping).
:::

Frameleaf also provides a mechanism to migrate between templates so that if the template you set now doesn't work in the future, you can always migrate all the existing files to the new template. The mechanism is run as the **Storage organization** job.

If you want to store assets in album folders, but you also have assets that do not belong to any album, you can use `{{#if album}}`, `{{else}}` and `{{/if}}` to create a conditional statement. For example, the following template will store assets in album folders if they belong to an album, and in a folder named "Other/Month" if they do not belong to an album:

```
{{y}}/{{#if album}}{{album}}{{else}}Other{{/if}}/{{MM}}/{{filename}}
```
