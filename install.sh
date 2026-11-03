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
  local -r RepoUrl='https://github.com/Frameleaf/frameleaf-app/releases/latest/download'
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
  generate_random_password || {
    echo 'error generating database password'
    return 15
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
