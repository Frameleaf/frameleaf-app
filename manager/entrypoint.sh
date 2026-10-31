#!/bin/sh
set -eu
umask 077
: "${MANAGER_DATA:?Mount a private host state folder at the same absolute path}"
mkdir -p "$MANAGER_DATA"
# A second Manager sharing this state directory cannot invalidate the live owner's journal.
exec flock --nonblock "$MANAGER_DATA/manager.lock" node /app/manager/build/main.js
