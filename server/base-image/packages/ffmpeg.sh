#!/usr/bin/env bash

set -e

export TARGETARCH=${TARGETARCH:=$(dpkg --print-architecture)}
# shellcheck source=/dev/null
. /etc/os-release
: "${FFMPEG_VERSION:=$(jq -cr '.version' ffmpeg.json)}"
: "${FFMPEG_SHA256:=$(jq -cr '.sha256[$ENV.TARGETARCH]' ffmpeg.json)}"
FFMPEG_PACKAGE="jellyfin-ffmpeg${FFMPEG_VERSION%%.*}_${FFMPEG_VERSION}-${VERSION_CODENAME}_${TARGETARCH}.deb"
echo "$FFMPEG_SHA256  $FFMPEG_PACKAGE" > ffmpeg.sha256

wget -nv "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${FFMPEG_VERSION}/$FFMPEG_PACKAGE"
sha256sum -c ffmpeg.sha256
apt-get -yqq -f install "./$FFMPEG_PACKAGE"
rm "$FFMPEG_PACKAGE"
rm ffmpeg.sha256
ldconfig /usr/lib/jellyfin-ffmpeg/lib

ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/bin
ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/bin
