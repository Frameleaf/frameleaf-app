#!/usr/bin/env bash
# FL-1453: GitHub runners stopped resolving *.ubuntu.com (archive, security, azure.archive) on
# 2026-11-11. Route the runner's own apt through full Ubuntu mirrors off ubuntu.com; apt still
# checks Ubuntu's signatures. FL-1477: mirrors.edge.kernel.org then went unreachable from runners
# for days, so the first mirror that answers is used, and apt keeps to IPv4 (the runners' IPv6
# route is the one reported unreachable). The chosen mirror is exported as UBUNTU_MIRROR for
# later steps (the machine-learning image build).
set -euo pipefail

if [[ "$(dpkg --print-architecture)" == amd64 ]]; then
  mirrors=(
    http://mirrors.edge.kernel.org/ubuntu/
    http://mirrors.ocf.berkeley.edu/ubuntu/
    http://mirror.math.princeton.edu/pub/ubuntu/
    http://mirrors.mit.edu/ubuntu/
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

codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
mirror=
for candidate in "${mirrors[@]}"; do
  if curl -4 -fsS --max-time 15 -o /dev/null "${candidate}dists/${codename}/Release"; then
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

if grep -E -h -s "$pattern" "${files[@]}"; then
  echo "Ubuntu apt sources still point at ubuntu.com" >&2
  exit 1
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "UBUNTU_MIRROR=${mirror}" >>"$GITHUB_ENV"
fi
