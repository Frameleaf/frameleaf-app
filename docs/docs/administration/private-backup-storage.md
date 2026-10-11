# Private backup storage

Keep the complete Frameleaf identity directory, Buddy vault/recovery material and deployment credentials on persistent private storage outside exported media shares. Give access only to the server's effective UID and the operators responsible for recovery. Host root, Docker administrators and an unlocked server process can still read these files; file permissions do not protect against those principals.

Stored Cloud Backup keys must be regular files, owned by the server UID, with no group or other access (normally `0600`). Their directory must be a real directory owned by that UID with no group or other access (normally `0700`). Protect its parent directories against replacement too. Reads reject links, nonregular files, oversized files and changes during capture. A failed write leaves an existing key intact. Downloaded recovery kits and separately configured Buddy recovery directories need the same protection.

The repository checks reported ownership and permission bits. A successful `chmod`, or NAS-synthesized `0600`, does **not** prove effective ACL enforcement. Qualify the actual mount with an unrelated UID before storing keys. Never send key contents or deployment environment files in a support bundle.

## Docker Compose

The server receives `.env`; ML receives only the optional `.env.ml` in the same stack directory. Move existing ML-specific settings (for example `MACHINE_LEARNING_WORKERS`, cache settings, model endpoints and the ML worker's own authentication token) to `.env.ml` before upgrading. Keep the server-side copy of settings that the server also needs. Do not copy database, backup, cloud provisioning or Manager credentials into `.env.ml`. Protect both files with `0600`. Compose's optional environment file requires [Compose 2.24 or later](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/).

For a new installation, create a private host directory for identity storage, owned by the server UID with mode `0700`. For an existing installation, complete the migration below first. Save this override beside the release Compose file as `compose.private-secrets.yml`:

```yaml
services:
  frameleaf-server:
    environment:
      FRAMELEAF_IDENTITY_DIR: /run/frameleaf/identity
    volumes:
      - type: bind
        source: ${FRAMELEAF_PRIVATE_IDENTITY_LOCATION:?Set the migrated private identity path}
        target: /run/frameleaf/identity
        bind:
          create_host_path: false
```

Set `FRAMELEAF_PRIVATE_IDENTITY_LOCATION` in `.env` to the private host directory. Start the stack with both files, and keep using both for upgrades, restarts and recovery:

```bash
docker compose -f docker-compose.yml -f compose.private-secrets.yml up -d
```

The standard rootless server uses UID/GID `1000:1000`; match the effective UID/GID when you customize it. Keep media mounts on the server only. Additional external-library mounts can be read-only; the main media location needs writes for uploads and generated files. ML needs its model cache and request bytes, not host media, backup roots, identity files or the Docker socket. Give other worker/plugin containers only their declared inputs, with read-only mounts when possible. Do not mount the server's whole stack or appdata parent into them.

## NAS mounts and packages

- Prefer a local private dataset, private Docker volume or unexported appdata directory for secrets, even when media is on SMB/CIFS/NFS/FUSE. Do not apply a media share's inherited ACL to the identity directory.
- For CIFS, use a **separate private share** restricted at the NAS to the Frameleaf service account. Mount it for the server UID/GID with `file_mode=0600,dir_mode=0700` and client permission checks enabled. `noperm`, a shared mount credential, or mode display alone cannot establish isolation. A FUSE mount with `allow_other` similarly needs enforced owner-only access and an actual denied-access test. If ownership/modes or denial cannot be verified, move secrets to local private storage; media can remain on the supported network mount.
- With the direct Unraid Server template, add the private host path at `/run/frameleaf/identity` and set `FRAMELEAF_IDENTITY_DIR` to that path **after migration**. Do not add either mount to the ML template. Keep the appdata identity folder out of SMB exports and prevent inherited user access.
- With the direct TrueNAS app, add a dedicated private dataset at `/run/frameleaf/identity` under additional storage and set `FRAMELEAF_IDENTITY_DIR` in **Server Environment Variables**. Match the configured run-as UID/GID (default `568:568`). The dataset ACL must grant that service UID only; test an unrelated UID on the rendered mount. Put ML-specific customization in **Machine Learning Environment Variables**; server custom variables are no longer forwarded to ML. Export only separate media datasets, not the private appdata parent.
- Manager already renders a server-only Manager token/settings mount and a cache-only ML container, without passing the server environment to ML. Keep its state and the server identity directory on unexported private storage. Manager regenerates its Compose file: do not hand-edit it to add the override above. For a Manager installation whose identity is currently on an exported media volume, keep that volume private and use separate read-only external-library mounts for shared media until a managed identity relocation is available. Manager has Docker socket access and is a trusted administrator, not an isolated plugin.

General workflow plugins execute in the WASI sandbox without preopened host directories. Preserve that boundary when adding host functions: plugin inputs, host-function results and outbound requests must not include deployment credentials or backup keys. A native extension running under the server UID has the server's access and requires a separate process/container identity to isolate it.

## Migrate without changing keys

1. Record the current `FRAMELEAF_IDENTITY_DIR`. When unset, the directory is `<media>/frameleaf/identity`. Record any custom Buddy vault/recovery roots and keep a verified encrypted/offline recovery copy of all keys and state.
2. Stop every API/job/maintenance writer that uses this identity. Keep the database and matching media recovery point. Do not start a second server against the same database during migration.
3. Copy the **complete** identity directory into an empty private destination, including identity rotation files, stored Cloud Backup keys and the default `buddy` directory. Do not generate new keys or merge two identity directories. Compare the relative file list, sizes and SHA-256 hashes before changing configuration. Preserve the original copy for rollback with the same private permissions. For a separately configured Buddy root, migrate and update its configured path together.
4. Set the destination owner to the server's effective UID/GID. Remove inherited ACL entries granting other users access, set directories to `0700` and files to `0600`, and qualify the actual mount below. If the NAS cannot provide that access model, use a private local volume instead.
5. Apply the server-only mount and identity setting together, then restart. Confirm the existing instance identity/fingerprint and backup-key fingerprints are unchanged; verify stored-key backup, restore, escrow where enabled and Buddy capture/recovery. Restart another worker and repeat restore. Retain the matched database, old private identity copy and configuration until recovery succeeds; an empty destination will create a new server identity.

## Verify effective access

Test with a synthetic file before placing secrets on the mount. Create `.frameleaf-access-probe` in the private identity directory as the server UID, mode `0600`, containing only `synthetic`. Then run a separate unprivileged container against that exact directory with no network, no capabilities and no shared environment. For example, replace `/absolute/private/identity` with the actual approved secret path:

```bash
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user 65534:65534 --mount type=bind,src=/absolute/private/identity,dst=/probe,readonly \
  alpine:3.22 sh -c 'test -d /probe && ! ls /probe >/dev/null 2>&1 && ! cat /probe/.frameleaf-access-probe >/dev/null 2>&1'
```

Success requires denied enumeration **and** denied file reads. Confirm the server UID can read the same probe; otherwise the denial could merely reflect a broken mount. Repeat with a UID from an ordinary NAS user/group and the ML UID when different. Check ACLs for other named users and default/inherited entries as well. Remove only the synthetic probe afterwards. On root-squashed or user-namespaced mounts, use the actual mapped host identities; do not treat a denial from the wrong mapping as proof.

Inspect rendered Compose/installed container mounts and environments locally: ML and general plugins must have no secret mounts, parent mounts that cover secrets, inherited server environment, privileged mode or Docker socket. Do not paste `docker inspect` environment output into reports. Recheck after package upgrades, ACL changes, failover and mount-option changes.

Record the exact Frameleaf package/image digest, OS/NAS version, server and unrelated UIDs, filesystem type, mount options, ACL policy, positive/negative probe outcomes and restart/restore results. Local Linux container fixtures qualify only that synthetic filesystem/mount. Template inspection and unit tests do not establish physical Unraid, TrueNAS or DSM acceptance; DSM package qualification belongs to its private package project.
