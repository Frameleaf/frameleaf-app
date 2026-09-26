# Maintenance Mode

Maintenance mode is used to perform administrative tasks such as restoring backups to Frameleaf.

You can enter maintenance mode by either:

- Selecting "Switch to maintenance mode" in `Maintenance` tab in administration.
- Running the enable maintenance mode [administration command](./server-commands.md).

## Logging in during maintenance

Maintenance mode uses a separate login system which is handled automatically behind the scenes in most cases. Enabling maintenance mode in settings will automatically log you into maintenance mode when the server comes back up.

If you find that you've been logged out, you can:

- Open the server logs and look for the 🚧 maintenance mode message followed by a login address

The login address uses the server's external domain (**Administration → Settings → Server**) or, for a server linked to Frameleaf Cloud, its public URL. When the server has neither, it prints only the path (`/maintenance?token=…`); open that path on the address you normally use to reach Frameleaf.
- Run the enable maintenance mode [administration command](./server-commands.md) again, this will give you a new URL to login with.
- Run the disable maintenance mode [administration command](./server-commands.md) then re-enter through system settings.
