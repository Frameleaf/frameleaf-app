#!/usr/bin/env bash
# Prefer Ubuntu's signed archive over mirrors that have timed out in CI. Probe both the runner
# suite and the pinned CUDA image's Jammy suite before exporting the mirror for Docker builds.
set -euo pipefail

if [[ "$(dpkg --print-architecture)" == amd64 ]]; then
  mirrors=(
    https://archive.ubuntu.com/ubuntu/
    http://mirrors.ocf.berkeley.edu/ubuntu/
    http://mirror.math.princeton.edu/pub/ubuntu/
    http://mirrors.mit.edu/ubuntu/
    http://mirrors.edge.kernel.org/ubuntu/
  )
  pattern='mirror\+file:/etc/apt/apt-mirrors\.txt|https?://[a-z.]*\.ubuntu\.com/ubuntu/?'
else
  mirrors=( # kernel.org carries no ports
    http://mirrors.ocf.berkeley.edu/ubuntu-ports/
    http://mirror.csclub.uwaterloo.ca/ubuntu-ports/
    http://mirrors.ustc.edu.cn/ubuntu-ports/
  )
  pattern='mirror\+file:/etc/apt/apt-mirrors\.txt|https?://ports\.ubuntu\.com/ubuntu-ports/?'
fi

codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release)
mirror=
for candidate in "${mirrors[@]}"; do
  if curl -4 -fsS --retry 1 --connect-timeout 5 --max-time 15 -o /dev/null "${candidate}dists/${codename}/InRelease" &&
    { [[ "$(dpkg --print-architecture)" != amd64 ]] || curl -4 -fsS --retry 1 --connect-timeout 5 --max-time 15 -o /dev/null "${candidate}dists/jammy/InRelease"; }; then
    mirror=$candidate
    break
  fi
  echo "Ubuntu mirror ${candidate} did not answer; trying the next" >&2
done
if [[ -z "$mirror" ]]; then
  echo "No Ubuntu mirror answered: ${mirrors[*]}" >&2
  exit 1
fi
echo "Using Ubuntu mirror ${mirror}"

echo 'Acquire::ForceIPv4 "true";' | sudo tee /etc/apt/apt.conf.d/99frameleaf-ipv4 >/dev/null

shopt -s nullglob
files=(/etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources)
for file in "${files[@]}"; do
  [[ -f "$file" ]] && sudo sed -i -E "s#(${pattern})#${mirror}#g" "$file"
done

if grep -E -h -s "$pattern" "${files[@]}" | grep -v -F "$mirror"; then
  echo "Ubuntu apt sources still point at an unselected archive" >&2
  exit 1
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "UBUNTU_MIRROR=${mirror}" >>"$GITHUB_ENV"
fi
