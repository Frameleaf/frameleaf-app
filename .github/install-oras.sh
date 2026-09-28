#!/usr/bin/env bash
# Install the checksum-pinned ORAS CLI for this runner's architecture into $RUNNER_TEMP/oras and add it
# to the job's PATH. Used to copy tested OCI archives byte for byte (FL-142).
set -euo pipefail
version=1.3.4
case "$(uname -m)" in
  x86_64) architecture=amd64 sum=f27adb935022d94df8dc77719c322dda592c78a0d57a6f7dcdd8d900b248c454 ;;
  aarch64) architecture=arm64 sum=15702c6e3a4a56a8bd8ac5c17efdbcab56d9bada661ccbcf017f5b10c1d89399 ;;
  *) echo "::error::Unsupported architecture $(uname -m)"; exit 1 ;;
esac
file="oras_${version}_linux_${architecture}.tar.gz"
curl -fsSLo "$RUNNER_TEMP/$file" "https://github.com/oras-project/oras/releases/download/v${version}/${file}"
echo "${sum}  $RUNNER_TEMP/$file" | sha256sum -c -
mkdir -p "$RUNNER_TEMP/oras"
tar -xzf "$RUNNER_TEMP/$file" -C "$RUNNER_TEMP/oras" oras
echo "$RUNNER_TEMP/oras" >> "$GITHUB_PATH"
