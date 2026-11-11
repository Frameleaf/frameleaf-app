#!/usr/bin/env bash
# FL-1453: GitHub runners stopped resolving *.ubuntu.com (archive, security, azure.archive) on
# 2026-11-11. Route the runner's own apt through full Ubuntu mirrors off ubuntu.com; apt still
# checks Ubuntu's signatures. ponytail: fixed mirrors, make them an input if one goes too.
set -euo pipefail

if [[ "$(dpkg --print-architecture)" == amd64 ]]; then
  mirror=http://mirrors.edge.kernel.org/ubuntu/
  pattern='mirror\+file:/etc/apt/apt-mirrors\.txt|https?://[a-z.]*\.ubuntu\.com/ubuntu/?'
else
  mirror=http://mirrors.ocf.berkeley.edu/ubuntu-ports/ # kernel.org carries no ports
  pattern='mirror\+file:/etc/apt/apt-mirrors\.txt|https?://ports\.ubuntu\.com/ubuntu-ports/?'
fi

shopt -s nullglob
files=(/etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources)
for file in "${files[@]}"; do
  [[ -f "$file" ]] && sudo sed -i -E "s#(${pattern})#${mirror}#g" "$file"
done

if grep -E -h -s "$pattern" "${files[@]}"; then
  echo "Ubuntu apt sources still point at ubuntu.com" >&2
  exit 1
fi
