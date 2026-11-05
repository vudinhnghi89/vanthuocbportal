#!/usr/bin/env bash
# Van Thu Portal restore from a directory made by scripts/backup.sh.
#
#   scripts/restore.sh <backup-dir> [--yes] [--force] [--wipe-data]
#
# Order of work: verify SHA256SUMS -> inspect db.dump and data.tar.gz (no path traversal, no links) ->
# print the plan -> without --yes stop (exit 2) -> refuse a database that already has users unless --force ->
# restore the database (single transaction: all or nothing) -> extract the data files.
#
# Environment:
#   BACKUP_MODE          compose (default) | direct
#   compose mode:        COMPOSE_FILE / COMPOSE_PROJECT_DIR; restores into the postgres service's database and
#                        /data of the web service. web/worker may be running: the script only warns (it never stops
#                        services). Stop them first (docker compose stop web worker) for a clean restore.
#   direct mode:         RESTORE_DATABASE_URL (an existing, normally empty database; never defaults to DATABASE_URL)
#                        and DATA_DIR (created if missing).
# Options:
#   --yes         actually do it (without it the plan is printed and nothing changes)
#   --force       allow restoring over a database that already contains rows in `users`
#   --wipe-data   empty DATA_DIR (/data) before extracting (default: only add/overwrite files from the backup).
#                 Direct mode refuses (exit 2) when DATA_DIR is /, $HOME, a parent of $HOME, or holds anything
#                 besides pdf/ and md/ directories at its top level.
#
# Exit codes: 0 ok | 1 failure | 2 usage/configuration or --yes missing | 3 integrity check failed
#             4 target database already has users (use --force) | 5 data archive rejected as unsafe
set -Eeuo pipefail
umask 022

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib-backup.sh
. "$SCRIPT_DIR/lib-backup.sh"

MODE=${BACKUP_MODE:-compose}
YES=0 FORCE=0 WIPE=0
BACKUP=""

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; }

while [ $# -gt 0 ]; do
  case $1 in
    --yes) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --wipe-data) WIPE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) usage; die 2 "unknown option: $1" ;;
    *) [ -z "$BACKUP" ] || die 2 "only one backup directory may be given"; BACKUP=$1; shift ;;
  esac
done

[ -n "$BACKUP" ] || { usage; die 2 "missing <backup-dir>"; }
[ -d "$BACKUP" ] && [ ! -L "$BACKUP" ] || die 2 "not a directory (or a symlink): $BACKUP"
case $MODE in compose | direct) ;; *) die 2 "BACKUP_MODE must be compose or direct" ;; esac
need_cmd tar sha256sum gzip

if [ "$MODE" = compose ]; then
  need_cmd docker
else
  need_cmd pg_restore psql
  [ -n "${RESTORE_DATABASE_URL:-}" ] || die 2 "direct mode needs RESTORE_DATABASE_URL (the target database, given explicitly)"
  parse_pg_url "$RESTORE_DATABASE_URL" || die 2 "RESTORE_DATABASE_URL is not a valid postgres:// URL"
  unset RESTORE_DATABASE_URL DATABASE_URL
fi

# wipe_refusal_reason <dir>: lý do (tiếng Việt) không được xóa sạch thư mục này; rỗng nếu an toàn.
# Chặn /, $HOME, thư mục cha của $HOME, và thư mục có bất cứ thứ gì ngoài hai thư mục pdf/ và md/ ở cấp cao nhất.
wipe_refusal_reason() {
  local d resolved home entry name
  d=$1
  resolved=$(realpath -m -- "$d" 2>/dev/null) || { echo "không phân giải được đường dẫn"; return; }
  if [ "$resolved" = "/" ]; then echo "là thư mục gốc /"; return; fi
  home=$(realpath -m -- "${HOME:-/nonexistent}" 2>/dev/null || true)
  if [ -n "$home" ]; then
    if [ "$resolved" = "$home" ]; then echo "là thư mục HOME ($home)"; return; fi
    case "$home/" in "$resolved"/*) echo "là thư mục cha của HOME ($resolved)"; return ;; esac
  fi
  if [ -d "$resolved" ]; then
    while IFS= read -r -d '' entry; do
      name=${entry##*/}
      if [ -L "$entry" ] || [ ! -d "$entry" ] || { [ "$name" != pdf ] && [ "$name" != md ]; }; then
        echo "chứa '$name' (chỉ được có thư mục pdf/ và md/ ở cấp cao nhất)"
        return
      fi
    done < <(find "$resolved" -mindepth 1 -maxdepth 1 -print0)
  fi
}

# 1. Integrity ----------------------------------------------------------------------------------------
log "verifying checksums..."
for f in SHA256SUMS db.dump MANIFEST; do
  [ -f "$BACKUP/$f" ] && [ ! -L "$BACKUP/$f" ] || die 3 "backup is incomplete: $f missing"
done
HAS_DATA=0
if [ -e "$BACKUP/data.tar.gz" ] || [ -L "$BACKUP/data.tar.gz" ]; then
  [ -f "$BACKUP/data.tar.gz" ] && [ ! -L "$BACKUP/data.tar.gz" ] || die 3 "data.tar.gz is not a regular file"
  HAS_DATA=1
fi
listed=""
while IFS= read -r line || [ -n "$line" ]; do
  [[ $line =~ ^[0-9a-f]{64}\ \ (db\.dump|data\.tar\.gz|MANIFEST)$ ]] || die 3 "SHA256SUMS has an unexpected line"
  listed="$listed ${BASH_REMATCH[1]}"
done <"$BACKUP/SHA256SUMS"
case " $listed " in *" db.dump "*) ;; *) die 3 "SHA256SUMS does not cover db.dump" ;; esac
case " $listed " in *" MANIFEST "*) ;; *) die 3 "SHA256SUMS does not cover MANIFEST" ;; esac
if [ "$HAS_DATA" -eq 1 ]; then
  case " $listed " in *" data.tar.gz "*) ;; *) die 3 "SHA256SUMS does not cover data.tar.gz" ;; esac
fi
(cd "$BACKUP" && sha256sum -c --quiet SHA256SUMS) >/dev/null || die 3 "checksum mismatch: the backup is corrupt or was modified"
first=""
IFS= read -r first <"$BACKUP/MANIFEST" || true
[ "$first" = "vtp-backup-manifest 1" ] || die 3 "MANIFEST is not a Van Thu Portal backup manifest"
list_dump "$BACKUP/db.dump" || die 3 "db.dump is not a readable pg_dump custom archive"

# 2. Data archive inspection (before anything is touched) ---------------------------------------------
if [ "$HAS_DATA" -eq 1 ]; then
  tar -tzf "$BACKUP/data.tar.gz" >/dev/null 2>&1 || die 5 "data.tar.gz cannot be listed"
  while IFS= read -r entry; do
    case $entry in
      /*) die 5 "data.tar.gz contains an absolute path: rejected" ;;
    esac
    case "/$entry/" in
      */../*) die 5 "data.tar.gz contains a '..' path: rejected" ;;
    esac
  done < <(tar -tzf "$BACKUP/data.tar.gz")
  # Only regular files and directories are allowed (no symlinks, hardlinks, devices, fifos).
  while IFS= read -r kind; do
    case $kind in
      - | d) ;;
      *) die 5 "data.tar.gz contains a link or special file: rejected" ;;
    esac
  done < <(tar -tvzf "$BACKUP/data.tar.gz" | cut -c1)
elif [ "$WIPE" -eq 1 ]; then
  die 2 "--wipe-data given but this backup has no data archive"
fi

if [ "$MODE" = direct ] && [ "$HAS_DATA" -eq 1 ]; then
  [ -n "${DATA_DIR:-}" ] || die 2 "direct mode needs DATA_DIR to extract the data archive"
  if [ "$WIPE" -eq 1 ]; then
    reason=$(wipe_refusal_reason "$DATA_DIR")
    [ -z "$reason" ] || die 2 "Từ chối --wipe-data vì DATA_DIR không an toàn để xóa sạch: $reason"
  fi
  reason=$(unsafe_dir_reason "$DATA_DIR")
  [ -z "$reason" ] || die 2 "refusing unsafe DATA_DIR: $reason"
fi

# 3. Plan ---------------------------------------------------------------------------------------------
{
  echo "Restore plan (mode=$MODE):"
  echo "  backup:     $BACKUP"
  grep -E '^(created_at|git_commit|rows\.)' "$BACKUP/MANIFEST" | sed 's/^/    /' || true
  if [ "$MODE" = compose ]; then
    echo "  database:   the postgres service's database (pg_restore --clean --if-exists --no-owner, one transaction)"
    echo "  data:       $([ "$HAS_DATA" -eq 1 ] && echo "extract into /data of the web service" || echo "none in this backup")$([ "$WIPE" -eq 1 ] && echo ", emptied first")"
  else
    echo "  database:   ${PGDATABASE:-?} on ${PGHOST:-local socket} (pg_restore --clean --if-exists --no-owner, one transaction)"
    echo "  data:       $([ "$HAS_DATA" -eq 1 ] && echo "extract into $DATA_DIR" || echo "none in this backup")$([ "$WIPE" -eq 1 ] && echo ", emptied first")"
  fi
  echo "  existing data in the target database is replaced (the pgboss schema is dropped and recreated from the dump)."
} >&2

RUNNING=""
if [ "$MODE" = compose ]; then
  RUNNING=$(dc ps --status running --services 2>/dev/null || true)
  if printf '%s\n' "$RUNNING" | grep -Eqx 'web|worker'; then
    log "WARNING: web and/or worker are running. Stop them first (docker compose stop web worker);"
    log "         restoring under a live worker can race with job processing. This script never stops services itself."
  fi
fi

if [ "$YES" -ne 1 ]; then
  log "Nothing was changed. Re-run with --yes to perform the restore."
  exit 2
fi

# 4. Refuse to overwrite a populated database -----------------------------------------------------------
has_users=$(printf "select to_regclass('public.users') is not null;\n" | db_psql)
if [ "$has_users" = "t" ]; then
  n=$(printf 'select count(*) from public.users;\n' | db_psql)
  [[ $n =~ ^[0-9]+$ ]] || die 1 "could not count users in the target database"
  if [ "$n" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
    die 4 "the target database already has $n user(s); pass --force to overwrite it"
  fi
fi

STAGE=""
on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    case $STAGE in
      db)
        log "Phục hồi thất bại; CSDL đích không bị thay đổi (toàn bộ giao dịch, kể cả việc xóa schema pgboss, đã được rollback)."
        log "Dữ liệu /data chưa bị động tới. Xem lỗi ở trên, sửa nguyên nhân rồi chạy lại restore.sh." ;;
      data)
        log "Phục hồi thất bại ở bước giải nén /data: CSDL ĐÃ được phục hồi, còn /data có thể dở dang (bị xóa sạch nếu dùng --wipe-data)."
        log "Sửa nguyên nhân (quyền ghi, dung lượng) rồi chạy lại restore.sh với --yes --force để phục hồi lại từ đầu." ;;
    esac
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 5. Database -----------------------------------------------------------------------------------------
# One transaction for everything: drop of the pgboss schema (pg_restore --clean cannot drop pg-boss' partitioned
# tables, and pg-boss owns/migrates that schema anyway) + the whole restore. pg_restore writes SQL to a pipe;
# "commit" is appended only if pg_restore itself succeeded. If anything fails, psql ends without COMMIT and
# the server rolls everything back, so the target database is left exactly as it was.
STAGE=db
log "restoring database..."
if [ "$MODE" = compose ]; then
  pg_restore_sql() { dc exec -T postgres sh -c 'exec pg_restore --clean --if-exists --no-owner -f -' <"$BACKUP/db.dump"; }
else
  pg_restore_sql() { pg_restore --clean --if-exists --no-owner -f - "$BACKUP/db.dump"; }
fi
{
  printf 'begin;\ndrop schema if exists pgboss cascade;\n'
  pg_restore_sql
  printf 'commit;\n'
} | db_psql >/dev/null

# 6. Data ---------------------------------------------------------------------------------------------
STAGE=data
if [ "$HAS_DATA" -eq 1 ]; then
  log "restoring data files..."
  if [ "$MODE" = compose ]; then
    if [ "$WIPE" -eq 1 ]; then dc exec -T web sh -c 'find /data -mindepth 1 -delete'; fi
    dc exec -T web tar -C /data -xzof - <"$BACKUP/data.tar.gz"
  else
    mkdir -p -- "$DATA_DIR"
    if [ "$WIPE" -eq 1 ]; then find "$DATA_DIR" -mindepth 1 -delete; fi
    tar -C "$DATA_DIR" --no-same-owner --no-same-permissions -xzf "$BACKUP/data.tar.gz"
  fi
fi

STAGE=done
cat >&2 <<'MSG'

Restore finished. Next steps:
  1. Make sure .env has the SAME APP_SECRET as the original server. If it differs, the stored Dify API keys
     cannot be decrypted: re-enter them in Admin > Integrations.
  2. Start the services:  docker compose up -d web worker   (compose mode) or start your own processes.
  3. Check  /api/health  and open the document list; compare the counts with the MANIFEST above.
  4. The pg-boss job tables were restored as they were. The worker's reconciler re-queues documents whose
     jobs are missing and sweeps stuck ones; no manual action is needed, but watch the queue for a few minutes.
MSG
