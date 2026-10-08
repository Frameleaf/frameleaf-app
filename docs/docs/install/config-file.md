---
sidebar_position: 100
---

# Configuration file

Most administrators should use **Settings** in the web application. A JSON or YAML configuration file is available for deployments that manage application settings as files.

Setting `FRAMELEAF_CONFIG_FILE` makes the file authoritative and disables editing the application configuration in the web UI. It is different from `.env`: environment variables configure deployment details such as database access, while the configuration file holds application settings.

## Prepare a configuration

Start from the current configuration shown in Settings for your installed release, or use a small file containing only the settings you intend to override. Unspecified settings use that release's defaults. This example sets database-backup retention:

```json
{
  "backup": {
    "database": {
      "enabled": true,
      "cronExpression": "0 2 * * *",
      "keepLastAmount": 14
    }
  }
}
```

Configuration copied or exported from the web UI redacts secrets. Restore required SMTP, OAuth and other configured secrets from your private deployment records; a copied settings view is not a complete secrets backup. Keep the finished file private.

## Mount the file

For a manual Compose installation, add a read-only mount to the server's existing `volumes` list:

```yaml
- ./frameleaf-config.json:/etc/frameleaf/config.json:ro
```

Set the container path in `.env`:

```dotenv
FRAMELEAF_CONFIG_FILE=/etc/frameleaf/config.json
```

Mount the same configuration in every API and job-worker container. Recreate the affected containers with `docker compose up -d`, then check startup logs and the displayed settings. Invalid configuration must be corrected before the server can start.

To return to UI-managed settings, remove `FRAMELEAF_CONFIG_FILE` and recreate the containers. Review the settings that then become effective before starting library-wide work.
