#!/bin/sh
# FL-408: what the bundled Studio render worker needs at run time, on every machine-learning base.
#
# - ffmpeg/ffprobe: check the encoded export, cut copied audio at the end of the picture, and write
#   every export format other than MP4/H.264 (FL-105: HEVC, VP8, VP9, AV1, ProRes, MOV/MKV/WebM,
#   MP3/AAC/WAV and caption tracks). The worker offers only the formats this ffmpeg really writes.
# - A Chromium-family browser with H.264/AAC (Studio's engine encodes through WebCodecs):
#   Debian bases (CPU, OpenVINO, ArmNN, RKNN) use Debian's chromium; the Ubuntu-based CUDA and ROCm
#   bases (amd64 only) use Google Chrome, whose builds carry the same codecs.
# - Generic fonts (DejaVu): without them fontconfig maps serif and monospace to the installed title
#   families, and the engine cannot tell whether a title's font was really applied.
# - Vulkan loader and Mesa drivers: WebGPU on the GPU the container is given, else software.
#
# /usr/local/bin/frameleaf-studio-browser names the browser. Without one the worker reports that
# it cannot run and Studio stays unavailable; the image itself never fails over it.
set -eu
# shellcheck source=/dev/null
. /etc/os-release
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core fonts-liberation libvulkan1 mesa-vulkan-drivers ca-certificates
test ! -e /etc/ssl/certs/emSign_ECC_Root_CA_-_G3.pem && test ! -e /etc/ssl/certs/Comodo_AAA_Services_root.pem
case "$ID" in
  debian)
    apt-get install -y --no-install-recommends chromium
    ln -sf /usr/bin/chromium /usr/local/bin/frameleaf-studio-browser
    ;;
  ubuntu)
    if [ "$(dpkg --print-architecture)" = amd64 ]; then
      apt-get install -y --no-install-recommends gnupg wget
      wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
      echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
        > /etc/apt/sources.list.d/google-chrome.list
      apt-get update
      apt-get install -y --no-install-recommends google-chrome-stable
      # Only gnupg goes: google-chrome-stable depends on wget, so removing wget removed the browser too.
      apt-get remove -y gnupg
      ln -sf /usr/bin/google-chrome-stable /usr/local/bin/frameleaf-studio-browser
    else
      echo "No Studio browser for $ID on $(dpkg --print-architecture); the Studio worker will not run" >&2
    fi
    ;;
  *)
    echo "No Studio browser for $ID; the Studio worker will not run" >&2
    ;;
esac
apt-get autoremove -yqq
apt-get clean
rm -rf /var/lib/apt/lists/*
# A browser link that points nowhere would leave the worker silently off on a base that should run it.
if [ -L /usr/local/bin/frameleaf-studio-browser ] && [ ! -x /usr/local/bin/frameleaf-studio-browser ]; then
  echo "The Studio browser $(readlink /usr/local/bin/frameleaf-studio-browser) is missing" >&2
  exit 1
fi
