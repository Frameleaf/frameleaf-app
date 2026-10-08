# Buddy Backup

Buddy Backup stores an encrypted copy of your library on another Frameleaf server. Each server has its own backup key and independent storage allowance. Cloud Backup and Buddy Backup can run together.

Buddy Backup is solely a backup and restore destination. Hosting a buddy's vault never adds their photos, thumbnails, albums or people to your Frameleaf library, timeline or search. Your restore browser opens only your own server's backup; it cannot browse or restore the buddy's library. The hosting panel shows encrypted storage usage and transfer status.

Buddy Backup is initially disabled while beta qualification is completed. Enabling `FRAMELEAF_BUDDY_BACKUP=true` on a compatible server permits new backups when Cloud also enables the feature. Setting it back to `false` stops new backups and keeps recovery available. Only enable it for a release whose supported backup and recovery paths meet your needs. Keep an independent backup while the feature is disabled or unavailable.

## Set up a buddy

1. Link both servers to Frameleaf Cloud. Both need an active subscription or its existing grace period for new backups.
2. Open **Settings → Backup → Buddy controls**. The existing **Frameleaf Cloud → Backup** entry also opens the Backup Command Center. Check library mounts, configuration coverage and estimated initial size.
3. Choose a dedicated hosting directory outside photo libraries, external import paths and the server identity directory. Set a hard capacity for the storage you offer. Your buddy can offer a different amount.
4. Invite the buddy's Cloud account. Each owner confirms the account, server and reciprocal storage agreement.
5. Download and re-import your recovery kit to verify it. Keep it somewhere independent of the original server. Optional Cloud escrow contains only a package encrypted locally using your passphrase; Cloud does not receive the passphrase.
6. Run the encrypted connection check, then start the initial backup.

The default schedule is 02:00 in the source server's timezone. Sending and receiving each default to 20 Mbit/s, with two block transfers per direction. Configure transfer windows and limits under **Hosting & transfer settings**. Direct connections are preferred; the relay handles connections that cannot connect directly. Relay allowances still apply.

## Coverage and controls

Backups capture originals, videos, Live Photo components, sidecars, edited outputs, retained project dependencies, metadata and a verified database dump. Every snapshot includes Frameleaf settings, user preferences, environment settings and the configuration files declared during setup, including secrets contained in those inputs and the database. Mount external libraries and declared configuration files before capture; inaccessible or changed required files stop a complete restore point from being published. This is not a whole operating-system image.

Locally stored Cloud Backup recovery keys are included in the encrypted snapshot and imported during settings or server recovery. The server identity credentials and Buddy recovery kit remain excluded; recovery preserves the replacement server's identity. Keys held only in memory are not captured. Keep an independent copy of each backup system's recovery kit or key, including Cloud Backup when both destinations are used.

Only new or changed encrypted media objects are transferred after the initial backup. Metadata-only changes do not upload originals again. Received Buddy vaults, temporary transfer files and regenerable caches are excluded; thumbnails and transcoded media are optional.

**My backup** reports the latest complete restore point separately from the latest successful restore verification. **Hosting for my buddy** shows storage usage and reservations without exposing the buddy's filenames, albums or media. Overview and Analytics show these outgoing and incoming directions alongside Cloud Backup. Their server-wide operational snapshot is independent of library filters; refresh it to read the latest destination status.

The Backup Command Center separates **Status**, **Cloud Backup**, **Buddy controls**, **Recover**, and **How it works**. Recovery opens your source server's backup only. The comparison describes the distinct encryption models: Cloud Backup uses provider-side SSE-C, while Buddy encrypts before transmission.

- **Pause sending / receiving** keeps acknowledged progress. **Resume** continues it.
- **Restart backup** abandons an incomplete run, scans again and reuses verified objects at the destination.
- **Verify backup** checks stored content and restores a sample into an isolated temporary directory. Automatic checks rotate through content weekly.
- Quota exhaustion or low disk space pauses receiving. The reserve is the larger of 10 GiB or 10% of the volume. Protected restore points are not removed to make room.

Restore points are retained for at least 30 days, with 12 monthly points and the latest complete point preserved. An administrator with access to the buddy's operating system can still remove disk contents; keep additional independent copies of important data.

## Restore and recover

### Replacement server configuration

Recovered settings and secrets are staged privately. They do not automatically make a replacement server ready. Review the replacement host's storage mappings, database connection, identity and configured services before enabling it. Keep recovery configuration and keys private, and verify the restored library before allowing new writes. Full replacement recovery depends on the adapters available in the installed release.

Unlock with your PIN and choose a dated restore point. Owners can restore their own permitted images, videos and albums. Administrators can also restore the library, settings or a complete server. Preview the selection and conflicts before starting. The default fills missing items and preserves current changes; replacement keeps a rollback copy. Partial restoration does not reinstate historical sharing grants.

Full recovery stages and verifies the files before entering maintenance mode. Restore the original storage mounts, verify version compatibility, then apply the database and files. Recovery preserves the replacement server's Cloud identity and invalidates restored sessions and transient jobs. Maintenance remains active if recovery fails.

Snapshots include Buddy's schedule, timezone, transfer windows and limits, pause flags and derived-file policy. Settings and server recovery with **Keep** preserve current Buddy preferences. **Replace** restores the operational preferences while preserving the replacement server's hosting directory, quota, declared configuration allowlist, identity, pairing and recovery checks. During replacement, a direction remains paused if either server's saved settings pause it. The source storage paths and quota remain encrypted reference data; they do not authorize a new hosting location or storage agreement. Older snapshots without these preferences remain recoverable.

After subscription expiry, authenticated recovery remains available through restricted read-only Buddy routes. Ordinary remote access remains subject to its subscription policy. Ending a pairing normally leaves a 30-day recovery window; a security block revokes access immediately. Unlinking or Cloud failure does not silently erase a hosted vault.

For a replacement server, sign in to Cloud, explicitly rebind the server in the Buddy account page, and import the recovery kit or unlock the escrow package locally. Rebinding revokes the old server identity.

## Offline export and recovery

The host can export encrypted vault contents without a decryption key. The vault directory ends with its vault UUID. Run these commands in a Frameleaf environment with the relevant paths mounted:

```sh
frameleaf-admin buddy-backup export --vault /vault/VAULT_UUID --output /empty-export
frameleaf-admin buddy-backup recover --vault /empty-export/VAULT_UUID --kit /recovery-kit.json --output /empty-recovery
```

Use `--snapshot SNAPSHOT_UUID` to select a particular restore point. The output directory must be empty. Offline recovery needs no Cloud connection or original database. It writes verified plaintext objects and an encrypted-manifest-derived `manifest.json` mapping their original paths and metadata; `recovery-complete.json` identifies the database object. Keep decrypted recovery output private. No historical path is automatically used as a write destination by the offline command.
