#!/bin/sh
# Usage: sh launch.sh ghcr.io/frameleaf/frameleaf-manager:latest MANAGER_ORIGIN [FOLDER_ROOT] [LAN_ADDRESS]
#   Folders are chosen and created in Manager, inside FOLDER_ROOT (default /srv/frameleaf).
#   More drives: MANAGER_EXTRA_FOLDERS=/media/ssd/frameleaf:/media/disk2/frameleaf (colon separated, each existing and two levels deep).
# Or name each folder yourself:
#   sh launch.sh ghcr.io/frameleaf/frameleaf-manager:latest HOST_STATE_FOLDER HOST_MEDIA_FOLDER HOST_BACKUP_FOLDER MANAGER_ORIGIN [APPDATA_FOLDER|auto] [LAN_ADDRESS]
# Another installation on the same host: run again with MANAGER_NAME, MANAGER_PORT and its own FOLDER_ROOT, or its own state, media and backup folders.
set -eu
umask 077
test "$#" -ge 2 || { echo 'Expected Manager image and HTTP or HTTPS origin' >&2; exit 2; }
root=
if test "$#" -le 4; then
  image=$1 origin=$2 root=${3:-/srv/frameleaf} bind=${4:-127.0.0.1}
  root=${root%/}
  case "$origin" in http://*|https://*) ;; *) echo 'Expected Manager image and HTTP or HTTPS origin, then optionally a parent folder and LAN address' >&2; exit 2;; esac
  # Two levels, so a chosen folder inside it is never directly under /.
  case "$root" in /[!/]*/[!/]*) ;; *) echo 'Use an absolute folder at least two levels deep, such as /srv/frameleaf' >&2; exit 2;; esac
  # The checks below treat it as every location: Manager puts each chosen folder inside it.
  state=$root/manager media=$root backups=$root appdata=$root
else
  image=$1 state=$2 media=$3 backups=$4 origin=$5 appdata=${6:-auto} bind=${7:-127.0.0.1}
  test -z "${MANAGER_EXTRA_FOLDERS:-}" || { echo 'MANAGER_EXTRA_FOLDERS needs the short form: image, origin and one parent folder' >&2; exit 2; }
fi
# Every folder Manager may choose in: FOLDER_ROOT first, then each extra drive. Colon separated, as MANAGER_FOLDER_ROOT.
roots=$root extras=
if test -n "$root" && test -n "${MANAGER_EXTRA_FOLDERS:-}"; then
  old_ifs=$IFS
  IFS=:
  set -f
  for extra in $MANAGER_EXTRA_FOLDERS; do
    extra=${extra%/}
    case "$extra" in /[!/]*/[!/]*) ;; *) echo "Use absolute extra folders at least two levels deep, such as /media/disk2/frameleaf: ${extra:-empty}" >&2; exit 2;; esac
    for other in $roots; do
      case "$extra/" in "$other/"*) echo "$extra is already inside $other; leave it out" >&2; exit 2;; esac
      case "$other/" in "$extra/"*) echo "$other is inside $extra; give each drive's own folder once" >&2; exit 2;; esac
    done
    roots=$roots:$extra extras=${extras:+$extras:}$extra
  done
  set +f
  IFS=$old_ifs
fi
name=${MANAGER_NAME:-frameleaf-manager} port=${MANAGER_PORT:-2282}
printf '%s' "$name" | LC_ALL=C grep -Eqx '[a-zA-Z0-9][a-zA-Z0-9_.-]*' || { echo 'MANAGER_NAME must be a valid container name' >&2; exit 2; }
case "$port" in ''|*[!0-9]*) echo 'MANAGER_PORT must be a port number' >&2; exit 2;; esac
test "$port" -ge 1 && test "$port" -le 65535 || { echo 'MANAGER_PORT must be a port number' >&2; exit 2; }
platform=linux
if test -f /boot/config/docker.cfg; then platform=unraid; fi
if test -n "$root"; then
  test "$platform" != unraid || { echo 'On Unraid, install from the Community Applications template' >&2; exit 2; }
  mkdir -p "$state"
fi
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
# Never pin a release (owner 2026-10-18): Manager always follows :latest.
test "$image" = ghcr.io/frameleaf/frameleaf-manager:latest || { echo 'Use ghcr.io/frameleaf/frameleaf-manager:latest' >&2; exit 2; }
# Split only on the colons that join the extra drives; the paths themselves are never globbed.
old_ifs=$IFS
IFS=:
set -f
# shellcheck disable=SC2086
for path in "$state" "$media" "$backups" "$appdata" $extras; do
  case "$path" in /*) ;; *) echo 'Use absolute existing host folders' >&2; exit 2;; esac
  test -d "$path" || { echo 'A required host folder is missing' >&2; exit 2; }
  test "$(realpath "$path")" = "$path" || { echo 'Use canonical paths, not symlinks' >&2; exit 2; }
  # Each folder becomes a `--mount` CSV value below: a comma or colon would split it (MANAGER_STORAGE_ROOTS
  # is colon separated too); quotes, `$` and control characters never belong in a Docker argument here.
  if printf '%s' "$path" | LC_ALL=C grep '[[:cntrl:]:,"$`\\]' >/dev/null; then
    echo "Unsupported characters in folder path: $path (commas, colons, quotes and control characters cannot be passed to Docker --mount; rename the folder)" >&2
    exit 2
  fi
done
set +f
IFS=$old_ifs
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
# Each installation owns its state and its Restic backup repository; two Managers must never share either.
shared=$(docker ps -aq | xargs -r docker inspect --format '{{range .Mounts}}{{$.Name}}{{"\t"}}{{.Source}}{{"\n"}}{{end}}' |
  awk -F '\t' -v self="/$name" -v state="$state" -v backups="$backups" \
    '$1 != self && ($2 == state || $2 == backups) { print substr($1, 2) }' | sort -u | tr '\n' ' ')
test -z "$shared" || { echo "State or backup folder is already used by: $shared- choose separate folders for this installation" >&2; exit 2; }
command -v cosign >/dev/null || { echo 'Install Cosign to verify the Manager image before launch' >&2; exit 2; }
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
docker pull "$image"
# Verify the exact bytes just pulled, then run those bytes, so the tag cannot move in between.
image=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image")
cosign verify --key "$script_dir/cosign.pub" "$image" >/dev/null
set --
if test "$platform" = unraid; then
  set -- --mount type=bind,source=/boot/config/docker.cfg,target=/run/frameleaf-host/docker.cfg,readonly
  set -- "$@" --mount type=bind,source=/boot/config/plugins/dockerMan/templates-user,target=/run/frameleaf-host/templates-user \
    --label net.unraid.docker.managed=dockerman \
    --label net.unraid.docker.icon=https://raw.githubusercontent.com/Frameleaf/frameleaf-app/main/design/frameleaf/mark.png \
    --label 'net.unraid.docker.webui=https://[IP]:[PORT:9443]'
  if test -f "$docker_root/unraid-autostart"; then
    set -- "$@" --mount "type=bind,source=$docker_root/unraid-autostart,target=/run/frameleaf-host/unraid-autostart" \
      --env MANAGER_UNRAID_AUTOSTART=/run/frameleaf-host/unraid-autostart
  fi
fi
if test -n "$root"; then
  # ponytail: no propagation, so a drive mounted inside FOLDER_ROOT later needs a Manager restart. rslave would refuse hosts with private mounts.
  # Each extra drive is mapped at its own path. Never created here: a drive that isn't mounted is refused above.
  set -- "$@" --mount "type=bind,source=$root,target=$root" --env "MANAGER_FOLDER_ROOT=$roots"
  IFS=:
  set -f
  # shellcheck disable=SC2086
  for path in $extras; do set -- "$@" --mount "type=bind,source=$path,target=$path"; done
  set +f
  IFS=$old_ifs
else
  set -- "$@" --mount "type=bind,source=$state,target=$state" \
    --mount "type=bind,source=$media,target=$media" \
    --mount "type=bind,source=$backups,target=$backups" \
    --mount "type=bind,source=$appdata,target=$appdata" \
    --env "MANAGER_STORAGE_ROOTS=$media" --env "MANAGER_APPDATA_ROOT=$appdata" --env "MANAGER_DATABASE_ROOTS=$appdata" \
    --env "DOCKER_APP_CONFIG_PATH=${DOCKER_APP_CONFIG_PATH:-}" --env "MANAGER_BACKUP_ROOT=$backups"
fi
docker run --detach --name "$name" --restart unless-stopped \
  --label app.frameleaf.manager.role=controller \
  --security-opt no-new-privileges --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --publish "$bind:$port:9443" \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount type=bind,source=/proc/1/mountinfo,target=/run/frameleaf-host/mountinfo,readonly \
  --env "MANAGER_DATA=$state" --env "MANAGER_PLATFORM=$platform" \
  --env "MANAGER_ORIGIN=$origin" --env "MANAGER_BIND_ADDRESS=$bind" "$@" "$image"
printf 'Manager: %s\nOpen it from your home network to create the administrator.\n' "$origin"
