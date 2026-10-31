# Maintenance Mode

Maintenance mode is used to perform administrative tasks such as restoring backups to Frameleaf.

You can enter maintenance mode by either:

- Selecting **Start maintenance** in **Settings → Maintenance → Maintenance mode**.
- Running the enable maintenance mode [administration command](./server-commands.md).

## Logging in during maintenance

Maintenance mode uses a separate login system which is handled automatically behind the scenes in most cases. Enabling maintenance mode in settings will automatically log you into maintenance mode when the server comes back up.

If you find that you've been logged out, you can:

- Open the server logs and look for the 🚧 maintenance mode message followed by a login address

The login address uses the server's Public server URL (**Settings → Frameleaf Cloud → Remote access**) or, on a server linked to Frameleaf Cloud, the address Frameleaf Cloud published for it. When the server has neither, it prints only the path (`/maintenance?token=…`); open that path on the address you normally use to reach Frameleaf.

- Run the enable maintenance mode [administration command](./server-commands.md) again, this will give you a new URL to login with.
- Run the disable maintenance mode [administration command](./server-commands.md) then re-enter through **Settings → Maintenance**.
