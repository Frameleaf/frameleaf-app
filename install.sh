#!/usr/bin/env bash
set -o nounset
set -o pipefail

create_frameleaf_directory() {
  local -r Tgt='./frameleaf-app'
  echo "Creating Frameleaf directory..."
  if [[ -e $Tgt || -L $Tgt ]]; then
    echo "Fresh installation requires a new $Tgt directory; refusing the existing destination." >&2
    echo 'Existing configuration, media and PostgreSQL files have not been changed.' >&2
    echo 'For a fresh install, run this installer from a new parent directory. To recover a previous attempt, inspect its retained .env and Compose files; do not delete its media or database directories.' >&2
    return 1
  fi
  # mkdir also refuses a destination created after the check above.
  mkdir "$Tgt" || return 1
  cd "$Tgt" || return 1
}

download_docker_compose_file() {
  echo "Downloading docker-compose.yml..."
  "${Curl[@]}" "$RepoUrl"/docker-compose.yml -o ./docker-compose.yml
}

download_dot_env_file() {
  echo "Downloading .env file..."
  "${Curl[@]}" "$RepoUrl"/example.env -o ./.env
}

download_checksums() {
  echo "Downloading release checksums..."
  "${Curl[@]}" "$RepoUrl"/SHA256SUMS -o ./SHA256SUMS
}

# Every release publishes SHA256SUMS beside its files (the same list Frameleaf Manager verifies against the
# signed release manifest). A download that does not match it is not used.
verify_download() {
  local -r name=$1 file=$2
  local expected actual
  expected=$(awk -v name="$name" '$2 == name { print $1 }' ./SHA256SUMS)
  if [[ ! $expected =~ ^[a-f0-9]{64}$ ]]; then
    echo "SHA256SUMS has no checksum for $name" >&2
    return 1
  fi
  if command -v sha256sum >/dev/null; then
    actual=$(sha256sum "$file" | awk '{ print $1 }')
  elif command -v shasum >/dev/null; then
    actual=$(shasum -a 256 "$file" | awk '{ print $1 }')
  else
    echo 'no sha256sum or shasum binary found; install coreutils and try again' >&2
    return 1
  fi
  if [[ $actual != "$expected" ]]; then
    echo "$name does not match the release checksum; refusing to use it" >&2
    return 1
  fi
}

# FL-1770: SHA256SUMS comes from the same place as the files, so it only proves they arrived whole. With cosign
# installed, the release is authenticated: the server and machine-learning images must carry Frameleaf's
# signature, and the server image's signed release manifest must name these exact docker-compose.yml and
# example.env bytes (the Compose file pins the database image by digest, so that is covered too). Without
# cosign the install goes on as before, with a warning; FRAMELEAF_REQUIRE_SIGNATURES=1 refuses it instead.
# These are cosign.pub and cosign-previous.pub from the repository (a test keeps them the same).
readonly FrameleafKeys=(
  '-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtHidzi9+LvA3y0Vc0NfHinYnpcN4
5fFchdVhpmeAPrChQbEyvwbWKUkC9Zx9NsaFAspaxOmH5gFhp21bVuQmqA==
-----END PUBLIC KEY-----'
  '-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfQM9z7o1fdFMSA4eArsnHuwjsJaq
Oqnda37+gMnjoloOgHXKYJ6YSaJKqzzXjeDe4bWslM4LOqd2lbTXL84xAw==
-----END PUBLIC KEY-----'
)
readonly ReleaseAttestation='https://frameleaf.app/attestations/release-manifest/v3'

# The digest Docker pulled for an image reference, as repository@sha256:...
pulled_digest() {
  local -r image=$1
  local repository=${image%@*}
  [[ ${repository##*/} == *:* ]] && repository=${repository%:*}
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" 2>/dev/null |
    awk -v repo="$repository" 'index($0, repo "@sha256:") == 1 { print; exit }'
}

# Whether the signed release manifest of a server image names the downloaded files (the hashes they matched).
manifest_names_downloads() {
  local -r cosign=$1 key=$2 digest=$3
  local compose env payloads
  compose=$(awk '$2 == "docker-compose.yml" { print $1 }' ./SHA256SUMS)
  env=$(awk '$2 == "example.env" { print $1 }' ./SHA256SUMS)
  payloads=$("$cosign" verify-attestation --key "$key" --type "$ReleaseAttestation" "$digest" 2>/dev/null |
    sed -n 's/.*"payload":"\([^"]*\)".*/\1/p' |
    while IFS= read -r line; do
      printf '%s' "$line" | base64 -d 2>/dev/null
      echo
    done)
  grep -F "\"docker-compose.yml\":\"sha256:$compose\"" <<<"$payloads" | grep -qF "\"example.env\":\"sha256:$env\""
}

verify_signatures() {
  local -r cosign=${FRAMELEAF_COSIGN:-cosign}
  if ! command -v "$cosign" >/dev/null; then
    if [[ ${FRAMELEAF_REQUIRE_SIGNATURES:-} == 1 ]]; then
      echo 'FRAMELEAF_REQUIRE_SIGNATURES=1 needs cosign: https://docs.sigstore.dev/cosign/system_config/installation/' >&2
      return 1
    fi
    echo 'Warning: cosign is not installed, so the downloads were only checked against the release checksums' >&2
    echo 'and the images are not signature-checked. Install cosign and run the installer again to have them verified.' >&2
    return 0
  fi
  echo "Checking Frameleaf's signatures on the release..."
  local keys index=0 key
  keys=$(mktemp -d) || return 1
  for key in "${FrameleafKeys[@]}"; do
    printf '%s\n' "$key" >"$keys/$index.pub"
    index=$((index + 1))
  done
  if ! docker compose pull --quiet frameleaf-server frameleaf-machine-learning; then
    echo 'could not pull the Frameleaf images to check their signatures' >&2
    rm -rf "$keys"
    return 1
  fi
  local service image digest signed
  for service in frameleaf-server frameleaf-machine-learning; do
    image=$(docker compose config --images "$service" 2>/dev/null | head -n 1)
    digest=$(pulled_digest "$image")
    if [[ -z $image || ! $digest =~ @sha256:[a-f0-9]{64}$ ]]; then
      echo "could not find the pulled digest of $service" >&2
      rm -rf "$keys"
      return 1
    fi
    signed=0
    for key in "$keys"/*.pub; do
      "$cosign" verify --key "$key" "$digest" >/dev/null 2>&1 || continue
      if [[ $service == frameleaf-server ]] && ! manifest_names_downloads "$cosign" "$key" "$digest"; then
        echo "The signed release manifest of $digest does not name these docker-compose.yml and example.env files; refusing to start" >&2
        rm -rf "$keys"
        return 1
      fi
      signed=1
      break
    done
    if [[ $signed -ne 1 ]]; then
      echo "$digest does not carry Frameleaf's signature; refusing to start" >&2
      rm -rf "$keys"
      return 1
    fi
  done
  rm -rf "$keys"
  echo 'The release and its images are signed by Frameleaf.'
}

generate_random_password() {
  echo "Generate random password for .env file..."
  local rand_pass
  rand_pass=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24)
  if [[ ${#rand_pass} -ne 24 ]]; then
    echo 'could not read secure random bytes from /dev/urandom' >&2
    return 1
  fi
  # Shell builtins only: the password never appears in another process's arguments.
  local line found=0
  {
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line == 'DB_PASSWORD=postgres' ]]; then
        line="DB_PASSWORD=${rand_pass}"
        found=$((found + 1))
      fi
      printf '%s\n' "$line"
    done <./.env
  } >./.env.new || return 1
  if [[ $found -ne 1 ]]; then
    rm -f ./.env.new
    echo '.env has no single DB_PASSWORD=postgres placeholder to replace' >&2
    return 1
  fi
  mv ./.env.new ./.env || return 1
  found=0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == "DB_PASSWORD=${rand_pass}" ]] && found=1
  done <./.env
  if [[ $found -ne 1 ]]; then
    echo '.env does not contain the generated database password' >&2
    return 1
  fi
}

# A selected release runs its own images, not whatever latest is by then: the verified example.env pins
# FRAMELEAF_VERSION to the release tag (image tags are the release tags, frameleaf-vX.Y.Z).
pin_release_version() {
  [[ -n ${FRAMELEAF_RELEASE:-} ]] || return 0
  echo "Pinning FRAMELEAF_VERSION to ${FRAMELEAF_RELEASE} in .env..."
  local line found=0
  {
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line == 'FRAMELEAF_VERSION=latest' ]]; then
        line="FRAMELEAF_VERSION=${FRAMELEAF_RELEASE}"
        found=$((found + 1))
      fi
      printf '%s\n' "$line"
    done <./.env
  } >./.env.new || return 1
  if [[ $found -ne 1 ]]; then
    rm -f ./.env.new
    echo '.env has no single FRAMELEAF_VERSION=latest line to pin to the selected release' >&2
    return 1
  fi
  mv ./.env.new ./.env || return 1
  found=0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == "FRAMELEAF_VERSION=${FRAMELEAF_RELEASE}" ]] && found=1
  done <./.env
  if [[ $found -ne 1 ]]; then
    echo '.env does not pin the selected release' >&2
    return 1
  fi
}

start_docker_compose() {
  echo "Starting Frameleaf's docker containers"

  if ! docker compose >/dev/null 2>&1; then
    echo "failed to find 'docker compose'"
    return 1
  fi

  if ! docker compose up --remove-orphans -d; then
    echo "Could not start. Check for errors above."
    return 1
  fi
  show_friendly_message
}

show_friendly_message() {
  local ip_address
  ip_address=$(hostname -I | awk '{print $1}')
  # If length of ip_address is 0, then we are on a Mac
  if [ ${#ip_address} -eq 0 ]; then
    ip_address=$(ipconfig getifaddr en0)
  fi
  cat <<EOF
Frameleaf is running.
You can access the website or the mobile app at http://$ip_address:2283
---------------------------------------------------
To configure database settings or the backup and upload locations:

  1. First bring down the containers with the command 'docker compose down' in the frameleaf-app directory,

  2. Then change the information that fits your needs in the '.env' file,

  3. Finally, bring the containers back up with the command 'docker compose up --remove-orphans -d' in the frameleaf-app directory
EOF
}

# MAIN
main() {
  echo "Starting Frameleaf installation..."
  # FRAMELEAF_RELEASE pins one release tag (frameleaf-vX.Y.Z); otherwise the latest release is installed.
  local RepoUrl='https://github.com/Frameleaf/frameleaf-app/releases/latest/download'
  if [[ -n ${FRAMELEAF_RELEASE:-} ]]; then
    if [[ ! $FRAMELEAF_RELEASE =~ ^frameleaf-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
      echo "FRAMELEAF_RELEASE must be a release tag such as frameleaf-v1.2.3" >&2
      return 16
    fi
    RepoUrl="https://github.com/Frameleaf/frameleaf-app/releases/download/${FRAMELEAF_RELEASE}"
  fi
  readonly RepoUrl
  local -a Curl
  if command -v curl >/dev/null; then
    Curl=(curl -fsSL)
  else
    echo 'no curl binary found; install curl and try again'
    return 14
  fi

  # Keep the install directory and .env (database password) private to this user.
  umask 077
  create_frameleaf_directory || {
    echo 'error creating Frameleaf directory'
    return 10
  }
  download_docker_compose_file || {
    echo 'error downloading Docker Compose file'
    return 11
  }
  download_dot_env_file || {
    echo 'error downloading .env'
    return 12
  }
  download_checksums || {
    echo 'error downloading release checksums'
    return 17
  }
  verify_download docker-compose.yml ./docker-compose.yml || {
    echo 'error verifying the downloaded Docker Compose file'
    return 18
  }
  verify_download example.env ./.env || {
    echo 'error verifying the downloaded .env'
    return 18
  }
  pin_release_version || {
    echo 'error pinning the selected release in .env'
    return 19
  }
  generate_random_password || {
    echo 'error generating database password'
    return 15
  }
  verify_signatures || {
    echo "error checking Frameleaf's signatures"
    return 20
  }
  start_docker_compose || {
    echo 'error starting Docker'
    return 13
  }
  return 0
}

main
Exit=$?
[[ $Exit == 0 ]] || echo "There was an error installing Frameleaf. Exit code: $Exit. Include these logs when asking for help."
exit "$Exit"
