#!/bin/sh
# Usage: sh launch.sh VERIFIED_MANAGER_DIGEST HOST_STATE_FOLDER HOST_MEDIA_FOLDER HOST_BACKUP_FOLDER HTTPS_ORIGIN [APPDATA_FOLDER|auto] [LAN_ADDRESS]
set -eu
umask 077
test "$#" -ge 5 || { echo 'Expected image digest, state folder, media folder, backup folder and HTTPS origin' >&2; exit 2; }
image=$1 state=$2 media=$3 backups=$4 origin=$5 appdata=${6:-auto} bind=${7:-127.0.0.1}
platform=linux
if test -f /boot/config/docker.cfg; then platform=unraid; fi
if test "$appdata" = auto; then
  appdata=${DOCKER_APP_CONFIG_PATH:-}
  if test -z "$appdata" && test "$platform" = unraid; then
    # Read exactly one setting as data. Never source docker.cfg or eval its contents.
    appdata=$(awk '
      /^[[:space:]]*DOCKER_APP_CONFIG_PATH[[:space:]]*=/ {
        count++; value=$0; sub(/^[^=]*=[[:space:]]*/, "", value); sub(/[[:space:]]*$/, "", value);
        if (value ~ /^".*"$/) value=substr(value,2,length(value)-2);
        found=value;
      }
      END { if (count > 1) exit 2; print found }
    ' /boot/config/docker.cfg) || { echo 'Ambiguous Unraid appdata setting' >&2; exit 2; }
    appdata=${appdata:-/mnt/user/appdata}
  fi
  test -n "$appdata" || { echo 'Specify an appdata folder on the host disk; no Unraid default was found' >&2; exit 2; }
fi
appdata=${appdata%/}
case "$appdata" in /*) ;; *) echo 'Appdata must be an absolute host folder' >&2; exit 2;; esac
if printf '%s' "$appdata" | LC_ALL=C grep '[[:cntrl:]:,"$`\\]' >/dev/null; then echo 'Unsupported characters in appdata path' >&2; exit 2; fi
test -d "$appdata" || { echo 'Create the selected appdata folder on the host disk before launching Manager' >&2; exit 2; }
# An Unraid exclusive share can resolve to a pool. Bind its real location, never guess a pool name.
appdata=$(realpath "$appdata")
case "$image" in ghcr.io/frameleaf/frameleaf-manager@sha256:*) ;; *) echo 'A verified Manager image digest is required' >&2; exit 2;; esac
digest=${image##*@sha256:}
test "${#digest}" = 64 && ! printf '%s' "$digest" | LC_ALL=C tr -d 'a-f0-9' | grep . >/dev/null || exit 2
for path in "$state" "$media" "$backups" "$appdata"; do
  case "$path" in /*) ;; *) echo 'Use absolute existing host folders' >&2; exit 2;; esac
  test -d "$path" || { echo 'A required host folder is missing' >&2; exit 2; }
  test "$(realpath "$path")" = "$path" || { echo 'Use canonical paths, not symlinks' >&2; exit 2; }
done
docker_root=$(docker info --format '{{.DockerRootDir}}')
case "$docker_root" in /*) ;; *) echo 'Cannot verify the Docker storage location' >&2; exit 2;; esac
docker_root=$(realpath "$docker_root")
case "$appdata/" in "$docker_root/"*) echo 'PostgreSQL must be outside Docker storage' >&2; exit 2;; esac
case "$docker_root/" in "$appdata/"*) echo 'Choose an appdata folder separate from Docker storage' >&2; exit 2;; esac
filesystem=$(findmnt --noheadings --target "$appdata" --output FSTYPE)
device=$(findmnt --noheadings --target "$appdata" --output SOURCE)
case "$device" in /dev/loop*|/dev/ram*|/dev/zram*) echo 'PostgreSQL cannot use a virtual disk image or RAM disk' >&2; exit 2;; esac
case "$filesystem" in
  ext4|xfs|btrfs|zfs) ;;
  fuse.shfs|fuse.unraid) test "$platform" = unraid || exit 2 ;;
  *) echo 'Choose disk-backed appdata storage, outside the container filesystem' >&2; exit 2;;
esac
command -v cosign >/dev/null || { echo 'Install Cosign to verify the Manager image before launch' >&2; exit 2; }
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cosign verify --key "$script_dir/cosign.pub" "$image" >/dev/null
docker pull "$image"
set --
if test "$platform" = unraid; then
  set -- --mount type=bind,source=/boot/config/docker.cfg,target=/run/frameleaf-host/docker.cfg,readonly
  if test -f "$docker_root/unraid-autostart"; then
    set -- "$@" --mount "type=bind,source=$docker_root/unraid-autostart,target=/run/frameleaf-host/unraid-autostart" \
      --env MANAGER_UNRAID_AUTOSTART=/run/frameleaf-host/unraid-autostart
  fi
fi
docker run --detach --name frameleaf-manager --restart unless-stopped \
  --label app.frameleaf.manager.role=controller \
  --security-opt no-new-privileges --cap-drop ALL \
  --publish "$bind:9443:9443" \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount type=bind,source=/proc/1/mountinfo,target=/run/frameleaf-host/mountinfo,readonly \
  --mount "type=bind,source=$state,target=$state" \
  --mount "type=bind,source=$media,target=$media" \
  --mount "type=bind,source=$backups,target=$backups" \
  --mount "type=bind,source=$appdata,target=$appdata" \
  --env "MANAGER_DATA=$state" --env "MANAGER_STORAGE_ROOTS=$media" \
  --env "MANAGER_APPDATA_ROOT=$appdata" --env "MANAGER_DATABASE_ROOTS=$appdata" --env "MANAGER_PLATFORM=$platform" \
  --env "DOCKER_APP_CONFIG_PATH=${DOCKER_APP_CONFIG_PATH:-}" \
  --env "MANAGER_BACKUP_ROOT=$backups" --env "MANAGER_ORIGIN=$origin" --env "MANAGER_BIND_ADDRESS=$bind" "$@" "$image"
printf 'Manager: %s\nRead the claim key from %s/claim-key on this host.\n' "$origin" "$state"
