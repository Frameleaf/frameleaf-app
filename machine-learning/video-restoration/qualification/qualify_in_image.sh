#!/usr/bin/env bash
# FL-933: run photo qualification inside the worker image, on any Linux host with an NVIDIA GPU,
# Docker and the NVIDIA Container Toolkit. Runs 8 scans, then all 200 only if those pass.
#
#   qualify_in_image.sh --image <built photo image> --scans-tar <restoration-scan-set-1.tar> --out <empty dir>
#
# The image must already be on this host and the scan package already copied here: this script
# uses no registry, provider or package credential. Weights come from their public upstream pins
# and are checked by sha256. The qualification containers have no network. It prints the driver
# branch and image revision, and writes the evidence under <out>/8 and <out>/200, with run.json.
# A record may list the revision only after this has really passed on real hardware.
set -euo pipefail

image="" scans_tar="" out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) image=$2; shift 2 ;;
    --scans-tar) scans_tar=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$image" ] && [ -f "$scans_tar" ] && [ -n "$out" ] || {
  echo "usage: $0 --image IMAGE --scans-tar FILE --out EMPTY_DIR" >&2
  exit 2
}
command -v nvidia-smi >/dev/null || { echo "no nvidia-smi on this host" >&2; exit 1; }
docker image inspect "$image" >/dev/null
mkdir -p "$out"
[ -z "$(ls -A "$out")" ] || { echo "$out must be empty" >&2; exit 1; }
out=$(cd "$out" && pwd)
scans_tar=$(cd "$(dirname "$scans_tar")" && pwd)/$(basename "$scans_tar")

gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1)
driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n 1)
memory=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -n 1)
echo "GPU: $gpu, $memory"
echo "DRIVER-VERSION: $driver"
echo "DRIVER-BRANCH: ${driver%%.*}"

qualification=/usr/src/video-restoration/qualification
python=/opt/restoration/photo/.venv/bin/python
user="$(id -u):$(id -g)"
mkdir -p "$out/weights" "$out/scans" "$out/tmp"

revision=$(docker run --rm --network none --user "$user" --entrypoint python "$image" \
  -m frameleaf_ml.video_restoration.image_revision verify /opt/restoration/image-revision.json --root /usr/src)
echo "IMAGE-REVISION: $revision"

echo "Fetching the pinned weights"
docker run --rm --user "$user" -v "$out/weights:/q/w" --entrypoint "$python" "$image" \
  -I "$qualification/fetch_inputs.py" weights "$qualification/upstream.json" /q/w

echo "Checking the scans against their pinned hashes"
docker run --rm --network none --user "$user" -v "$scans_tar:/q/set.tar:ro" -v "$out/scans:/q/s" \
  --entrypoint "$python" "$image" \
  -I "$qualification/fetch_inputs.py" scans "$qualification/scan-set.json" /q/s --from-tar /q/set.tar

qualify() { # <limit> <folder> <workload> <checkout>
  docker run --rm --gpus all --network none --user "$user" \
    -e HF_HUB_OFFLINE=1 -e DO_NOT_TRACK=1 -e PYTHONDONTWRITEBYTECODE=1 -e TORCH_HOME=/q/tmp -e TMPDIR=/q/tmp \
    -v "$out/weights:/q/w:ro" -v "$out/scans:/q/s:ro" -v "$out/tmp:/q/tmp" -v "$out/$2:/q/o" \
    --entrypoint "$python" "$image" -I "$qualification/qualify_photo.py" \
    --workload "$3" --runtime-root "/opt/restoration/$4" --weights /q/w \
    --upstream "$qualification/upstream.json" --scan-set "$qualification/scan-set.json" \
    --scans /q/s --out /q/o --vram-cap-gib 8 --limit "$1"
}

for pass in 8 200; do
  limit=$pass
  [ "$pass" = 200 ] && limit=0
  mkdir -p "$out/$pass"
  echo "Qualifying $pass scans"
  qualify "$limit" "$pass" photo-repair facexlib
  qualify "$limit" "$pass" colourise ddcolor
done

digest=$(docker image inspect "$image" --format '{{.Id}}')
docker run --rm --network none --user "$user" -v "$out:/q/out" \
  -e REVISION="$revision" -e DIGEST="$digest" -e GPU="$gpu" -e DRIVER="$driver" -e MEMORY="$memory" \
  --entrypoint python "$image" -I -c '
import json, os
json.dump(
    {
        "imageRevision": os.environ["REVISION"],
        "imageId": os.environ["DIGEST"],
        "gpu": os.environ["GPU"],
        "driverVersion": os.environ["DRIVER"],
        "driverBranch": os.environ["DRIVER"].split(".")[0],
        "memoryTotal": os.environ["MEMORY"],
        "evidence": ["8/photo-repair.json", "8/colourise.json", "200/photo-repair.json", "200/colourise.json"],
    },
    open("/q/out/run.json", "w"),
    indent=2,
)
'
rm -rf "$out/scans" "$out/weights" "$out/tmp"
echo "Evidence written to $out (the scans and weights were removed)"
