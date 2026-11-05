#!/usr/bin/env bash
# Shared helpers for scripts/backup.sh and scripts/restore.sh (source this file; do not execute it).
# Never prints connection strings or passwords: database credentials are handed to libpq/psql
# through PG* environment variables (direct mode) or read from the container's own env (compose mode).

log() { printf '%s\n' "$*" >&2; }
die() { local code=$1; shift; log "ERROR: $*"; exit "$code"; }

# urldecode_into <var> <string>: percent-decode (only %XX; '+' is left alone, as in URI userinfo).
urldecode_into() {
  local s=${2//\\/\\\\}
  printf -v "$1" '%b' "${s//%/\\x}"
}

# parse_pg_url <url>: export PGUSER/PGPASSWORD/PGHOST/PGPORT/PGDATABASE/PGSSLMODE from a postgres:// URL.
# Returns 1 (without echoing the URL) when it cannot be parsed.
parse_pg_url() {
  local url=$1
  local re='^postgres(ql)?://(([^:@/]*)(:([^@]*))?@)?([^:/?]*)(:([0-9]+))?(/([^?]*))?(\?(.*))?$'
  [[ $url =~ $re ]] || return 1
  local user=${BASH_REMATCH[3]} pass=${BASH_REMATCH[5]} host=${BASH_REMATCH[6]}
  local port=${BASH_REMATCH[8]} db=${BASH_REMATCH[10]} query=${BASH_REMATCH[12]}
  [ -n "$db" ] || return 1
  unset PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE PGSSLMODE PGSERVICE PGPASSFILE
  local v
  if [ -n "$user" ]; then urldecode_into v "$user"; export PGUSER=$v; fi
  if [ -n "$pass" ]; then urldecode_into v "$pass"; export PGPASSWORD=$v; fi
  if [ -n "$host" ]; then urldecode_into v "$host"; export PGHOST=$v; fi
  if [ -n "$port" ]; then export PGPORT=$port; fi
  urldecode_into v "$db"; export PGDATABASE=$v
  local pair
  local -a pairs=()
  IFS='&' read -r -a pairs <<<"$query"
  for pair in "${pairs[@]}"; do
    case $pair in
      sslmode=*) urldecode_into v "${pair#sslmode=}"; export PGSSLMODE=$v ;;
      host=*) urldecode_into v "${pair#host=}"; export PGHOST=$v ;;
      *) ;;
    esac
  done
  return 0
}

# need_cmd <cmd>...: exit 2 when a required tool is missing.
need_cmd() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die 2 "required command not found: $c"; done
}

# --- docker compose (compose mode) -------------------------------------------------------------
# dc <args...>: docker compose [-f $COMPOSE_FILE] [--project-directory $COMPOSE_PROJECT_DIR] <args...>
dc() {
  local -a base=(docker compose)
  if [ -n "${COMPOSE_FILE:-}" ]; then base+=(-f "$COMPOSE_FILE"); fi
  if [ -n "${COMPOSE_PROJECT_DIR:-}" ]; then base+=(--project-directory "$COMPOSE_PROJECT_DIR"); fi
  "${base[@]}" "$@"
}

# Commands run inside the postgres container. Credentials come from the container's own environment
# (POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB); nothing secret appears on any command line.
# The single-quoted strings are intentionally expanded by the container's shell, not ours.
# shellcheck disable=SC2016
PG_ENV_PREFIX='PGPASSWORD="$POSTGRES_PASSWORD" exec'
# shellcheck disable=SC2016
PG_ENV_ARGS='-U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# db_psql: run SQL read from stdin against the application database; prints tuples only (-At).
db_psql() {
  if [ "$MODE" = compose ]; then
    dc exec -T postgres sh -c "$PG_ENV_PREFIX psql -X -qAt -v ON_ERROR_STOP=1 $PG_ENV_ARGS"
  else
    psql -X -qAt -v ON_ERROR_STOP=1
  fi
}

# list_dump <file>: succeeds if pg_restore can read the custom-format dump's table of contents.
list_dump() {
  if [ "$MODE" = compose ]; then
    # The container's pg_restore matches the server version; the host may have none (or another major).
    dc exec -T postgres pg_restore --list <"$1" >/dev/null
  else
    pg_restore --list "$1" >/dev/null
  fi
}

# unsafe_dir_reason <path>: prints why a directory is not acceptable as backup/data root; empty when fine.
# Rejects empty paths, '..' components, newlines and system directories (after resolving symlinks).
unsafe_dir_reason() {
  local p=$1 resolved
  if [ -z "$p" ]; then echo "empty path"; return; fi
  case $p in *$'\n'*) echo "newline in path"; return ;; esac
  case "/$p/" in */../*) echo "'..' component"; return ;; esac
  resolved=$(realpath -m -- "$p" 2>/dev/null) || { echo "cannot resolve path"; return; }
  case $resolved in
    / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /opt | /proc | /root | /run | /sbin | /srv | /sys | /usr | /var | /tmp)
      echo "system directory ($resolved)"; return ;;
  esac
  if [ -e "$p" ] && [ ! -d "$p" ]; then echo "exists and is not a directory"; fi
}
