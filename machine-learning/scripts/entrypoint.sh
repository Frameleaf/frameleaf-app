#!/bin/sh
# The inference service and the bundled Studio worker (and the Chromium it drives) run as the
# unprivileged `frameleaf` user, never as root beside the model cache and the service's tokens.
#
# Started as root, the image's default, this makes the writable paths the user's own first: a model
# cache volume an earlier root-only release populated keeps working, as does a bind mount the host
# created. It then drops to the user with the container's supplementary groups kept, plus the groups
# that own the GPU devices it was given. FRAMELEAF_ML_UID / FRAMELEAF_ML_GID choose another identity.
#
# Started as any other user (`user:` in Compose, rootless engines), it only runs the command.
set -eu
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi
uid=${FRAMELEAF_ML_UID:-10001}
gid=${FRAMELEAF_ML_GID:-10001}
for dir in /cache /home/frameleaf; do
  if [ -d "$dir" ] && [ "$(stat -c %u "$dir")" != "$uid" ]; then
    chown -R "$uid:$gid" "$dir" 2>/dev/null \
      || echo "frameleaf-ml: could not make $dir writable for uid $uid; downloads there will fail" >&2
  fi
done
# Without CAP_SETUID/CAP_SETGID (cap_drop: ALL) the identity cannot change here: such a deployment
# sets `user:` itself, and a root with no capabilities is what it ran as before.
if ! setpriv --reuid="$uid" --regid="$gid" --clear-groups true 2>/dev/null; then
  echo "frameleaf-ml: cannot drop privileges (no CAP_SETUID); set user: ${uid}:${gid} on the container" >&2
  exec "$@"
fi
# GPU device nodes the container was given belong to host groups (render, video) whose ids differ on every
# host. Join them, so the unprivileged user can open the GPU without a group_add nobody can guess: without
# this, OpenVINO (and ROCm, ArmNN) lost the GPU the moment the service stopped running as root.
# 10001 stays whatever FRAMELEAF_ML_GID is: a root server shares the Studio worker's enrolment with it.
groups=$({ id -G | tr ' ' '\n'; echo 10001; stat -c %g /dev/dri/* /dev/kfd /dev/mali0 /dev/dxg 2>/dev/null || true; } | grep -vx 0 | sort -un | paste -sd, -)
if [ -n "$groups" ]; then
  exec setpriv --reuid="$uid" --regid="$gid" --groups="$groups" env HOME=/home/frameleaf "$@"
fi
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups env HOME=/home/frameleaf "$@"
