#!/usr/bin/env bash
# Van Thu Portal backup: pg_dump of the whole application database (including the pg-boss schema) plus
# the /data volume (pdf/ and md/), into an atomic, checksummed, timestamped directory.
#
#   scripts/backup.sh [--keep N] [--dir PATH] [--no-data]
#
# Environment:
#   BACKUP_MODE          compose (default) | direct
#   BACKUP_DIR           where backups go (default ./backups; set-but-empty is refused); --dir overrides
#   compose mode:        COMPOSE_FILE, COMPOSE_PROJECT_DIR select the project; services postgres and web must be up.
#                        Credentials are read by the container itself, nothing secret is on a command line.
#   direct mode:         DATABASE_URL (local pg_dump/psql) and DATA_DIR (tarred); for tests and hosts that run
#                        Postgres outside Docker.
#
# NOT backed up, on purpose: .env, APP_SECRET, AUTH_SECRET, ADMIN_PASSWORD. Backups hold document contents and
# password hashes; keeping secrets out of them means a stolen backup cannot decrypt the stored Dify API keys.
# Store APP_SECRET separately (password manager/vault). Without it the encrypted Dify keys in the restored
# database cannot be decrypted; they can simply be re-entered in Admin > Integrations.
#
# Exit codes: 0 ok | 1 failure (partial directory removed) | 2 usage/configuration/unsafe path
#             3 verification of the finished backup failed (partial removed) | 4 backup ok but retention failed
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib-backup.sh
. "$SCRIPT_DIR/lib-backup.sh"

MODE=${BACKUP_MODE:-compose}
KEEP=14
NO_DATA=0
ROOT_DIR=./backups
if [ "${BACKUP_DIR+set}" = set ]; then ROOT_DIR=$BACKUP_DIR; fi

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; }

while [ $# -gt 0 ]; do
  case $1 in
    --keep) [ $# -ge 2 ] || die 2 "--keep needs a number"; KEEP=$2; shift 2 ;;
    --dir) [ $# -ge 2 ] || die 2 "--dir needs a path"; ROOT_DIR=$2; shift 2 ;;
    --no-data) NO_DATA=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die 2 "unknown argument: $1" ;;
  esac
done

[[ $KEEP =~ ^[1-9][0-9]{0,5}$ ]] || die 2 "--keep must be a positive integer"
case $MODE in compose | direct) ;; *) die 2 "BACKUP_MODE must be compose or direct" ;; esac
reason=$(unsafe_dir_reason "$ROOT_DIR")
[ -z "$reason" ] || die 2 "refusing unsafe backup directory: $reason"
ROOT_DIR=$(realpath -m -s -- "$ROOT_DIR")

need_cmd tar sha256sum gzip realpath
if [ "$MODE" = compose ]; then
  need_cmd docker
else
  need_cmd pg_dump pg_restore psql
  [ -n "${DATABASE_URL:-}" ] || die 2 "direct mode needs DATABASE_URL"
  parse_pg_url "$DATABASE_URL" || die 2 "DATABASE_URL is not a valid postgres:// URL"
  if [ "$NO_DATA" -eq 0 ]; then
    [ -n "${DATA_DIR:-}" ] || die 2 "direct mode needs DATA_DIR (or --no-data)"
    [ -d "$DATA_DIR" ] || die 1 "DATA_DIR is not a directory: $DATA_DIR"
  fi
fi
# From here on the URL is not needed (libpq reads PG* variables); drop it so no child can echo it.
unset DATABASE_URL

mkdir -p -- "$ROOT_DIR"

PARTIAL=""
on_exit() {
  local rc=$?
  trap - EXIT
  if [ -n "$PARTIAL" ] && [ -d "$PARTIAL" ] && [ ! -L "$PARTIAL" ]; then
    rm -rf --one-file-system -- "$PARTIAL"
    log "backup failed (exit $rc): partial directory removed"
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Unique name; two runs inside the same second wait for the next one instead of colliding.
NAME="" FINAL=""
for _attempt in 1 2 3 4 5 6; do
  NAME="vtp-$(date -u +%Y%m%d-%H%M%S)"
  FINAL="$ROOT_DIR/$NAME"
  if [ ! -e "$FINAL" ] && [ ! -L "$FINAL" ] && mkdir -m 700 -- "$FINAL.partial" 2>/dev/null; then
    PARTIAL="$FINAL.partial"
    break
  fi
  sleep 1
done
[ -n "$PARTIAL" ] || die 1 "could not allocate a backup directory under $ROOT_DIR"
log "backup: $NAME (mode=$MODE)"

# 1. Database -----------------------------------------------------------------------------------------
log "dumping database (custom format, all schemas incl. pgboss)..."
if [ "$MODE" = compose ]; then
  dc exec -T postgres sh -c "$PG_ENV_PREFIX pg_dump $PG_ENV_ARGS -Fc --no-owner" >"$PARTIAL/db.dump"
else
  pg_dump -Fc --no-owner -f "$PARTIAL/db.dump"
fi
[ -s "$PARTIAL/db.dump" ] || die 1 "db.dump is empty"

# 2. Data volume --------------------------------------------------------------------------------------
if [ "$NO_DATA" -eq 0 ]; then
  log "archiving data volume (pdf/, md/)..."
  if [ "$MODE" = compose ]; then
    dc exec -T web tar -C /data -czf - . >"$PARTIAL/data.tar.gz"
  else
    tar -C "$DATA_DIR" -czf "$PARTIAL/data.tar.gz" .
  fi
fi

# 3. MANIFEST -----------------------------------------------------------------------------------------
log "writing MANIFEST..."
IFS='|' read -r n_users n_units n_rules n_docs n_events < <(db_psql <<'SQL'
select (select count(*) from users) || '|' || (select count(*) from units) || '|' || (select count(*) from rules)
  || '|' || (select count(*) from documents) || '|' || (select count(*) from document_events);
SQL
)
for v in "$n_users" "$n_units" "$n_rules" "$n_docs" "$n_events"; do
  [[ $v =~ ^[0-9]+$ ]] || die 1 "could not read row counts"
done
git_commit=$(git -C "$SCRIPT_DIR/.." rev-parse HEAD 2>/dev/null || true)
if [ "$MODE" = compose ]; then
  pg_dump_version=$(dc exec -T postgres pg_dump --version | head -n 1 || true)
  compose_version=$(docker compose version 2>/dev/null | head -n 1 || true)
else
  pg_dump_version=$(pg_dump --version | head -n 1 || true)
  compose_version=""
fi
{
  echo "vtp-backup-manifest 1"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "name=$NAME"
  echo "mode=$MODE"
  echo "git_commit=${git_commit:-unknown}"
  echo "rows.users=$n_users"
  echo "rows.units=$n_units"
  echo "rows.rules=$n_rules"
  echo "rows.documents=$n_docs"
  echo "rows.document_events=$n_events"
  echo "size.db_dump=$(stat -c %s "$PARTIAL/db.dump")"
  if [ "$NO_DATA" -eq 0 ]; then
    echo "size.data_tar_gz=$(stat -c %s "$PARTIAL/data.tar.gz")"
  else
    echo "data=none"
  fi
  echo "tool.pg_dump=${pg_dump_version:-unknown}"
  echo "tool.tar=$(tar --version 2>&1 | sed -n 1p)"
  echo "tool.bash=$BASH_VERSION"
  if [ -n "$compose_version" ]; then echo "tool.docker_compose=$compose_version"; fi
  echo "note=row counts are read separately from the dump; they can differ slightly if documents were written meanwhile"
} >"$PARTIAL/MANIFEST"

# 4. Checksums and verification -----------------------------------------------------------------------
log "checksumming and verifying..."
files=(db.dump)
if [ "$NO_DATA" -eq 0 ]; then files+=(data.tar.gz); fi
files+=(MANIFEST)
(cd "$PARTIAL" && sha256sum -- "${files[@]}" >SHA256SUMS)
(cd "$PARTIAL" && sha256sum -c --quiet SHA256SUMS) || exit 3
list_dump "$PARTIAL/db.dump" || { log "pg_restore --list failed on db.dump"; exit 3; }
if [ "$NO_DATA" -eq 0 ]; then
  tar -tzf "$PARTIAL/data.tar.gz" >/dev/null || { log "tar -tzf failed on data.tar.gz"; exit 3; }
fi
chmod 600 "$PARTIAL"/*

# 5. Publish atomically -------------------------------------------------------------------------------
mv -T -- "$PARTIAL" "$FINAL"
PARTIAL=""
log "backup complete: $FINAL"

# 6. Retention: only vtp-YYYYmmdd-HHMMSS real directories holding a valid MANIFEST are ever deleted ------
rc=0
n=0
while IFS= read -r -d '' d; do
  first=""
  if [ -f "$d/MANIFEST" ] && [ ! -L "$d/MANIFEST" ]; then IFS= read -r first <"$d/MANIFEST" || true; fi
  [ "$first" = "vtp-backup-manifest 1" ] || continue
  n=$((n + 1))
  if [ "$n" -gt "$KEEP" ]; then
    log "retention: removing $(basename "$d")"
    rm -rf --one-file-system -- "$d" || { log "WARNING: could not remove $d"; rc=4; }
  fi
done < <(find "$ROOT_DIR" -mindepth 1 -maxdepth 1 -type d -name 'vtp-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]' -print0 | sort -z -r)

printf 'BACKUP_PATH=%s\n' "$FINAL"
exit "$rc"
