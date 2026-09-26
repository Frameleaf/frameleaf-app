#!/usr/bin/env bash

set -eo pipefail

: "${DB_STORAGE_TYPE:=SSD}"

case "${DB_STORAGE_TYPE^^}" in
  SSD|HDD)
    echo "Using ${DB_STORAGE_TYPE^^} storage"
    cp -n --preserve=mode "/var/postgresql-conf-tpl/postgresql.${DB_STORAGE_TYPE,,}.conf" /etc/postgresql/postgresql.conf
    sed -i "s@##PGDATA@$PGDATA@" /etc/postgresql/postgresql.conf; \
    ;;
  *)
    echo "Error: DB_STORAGE_TYPE must be set to 'SSD' or 'HDD'" >&2
    exit 1
    ;;
esac

# set-env.sh is installed beside this script in the image (/usr/local/bin); CI lints without -x.
# shellcheck source=/dev/null
. /usr/local/bin/set-env.sh

exec /usr/local/bin/docker-entrypoint.sh "$@"
