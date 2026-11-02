#!/bin/sh
set -eu
umask 077
: "${MANAGER_DATA:?Mount a private host state folder at the same absolute path}"
mkdir -p "$MANAGER_DATA"
# A second Manager sharing this state directory cannot invalidate the live owner's journal.
set -- flock --nonblock "$MANAGER_DATA/manager.lock" node /app/manager/build/main.js
# HexOS and TrueNAS custom apps cannot drop capabilities or set no-new-privileges (FL-1111).
# While Manager still holds CAP_SETPCAP, keep only what the Unraid and TrueNAS installers grant.
caps=$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)
if [ $((0x$caps & 0x100)) -ne 0 ]; then
  set -- setpriv --bounding-set -all,+chown,+dac_override,+fowner --inh-caps -all --no-new-privs "$@"
fi
exec "$@"
