#!/usr/bin/env bash
# Shared helpers for scripts/smoke-*.sh (source this file; do not execute it).
# Provides: smoke_init, smoke_cleanup (register with `trap smoke_cleanup EXIT`), smoke_prepare_db,
# smoke_start_server, smoke_wait_health, smoke_login.
# The server is started with `setsid`, so it is a process-group leader: killing the group
# takes down npx and its next-server child (killing only the npx PID orphans next-server).

SERVER_PID=""
CURL_PIDS=""

# smoke_init <db-name-prefix>: needs ADMIN_DATABASE_URL; sets BASE_URL DB TMP PORT DBURL URL JAR.
smoke_init() {
  BASE_URL="${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL}"
  DB="$1_$$"
  TMP="$(mktemp -d)"
  PORT="${PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1])')}"
  DBURL="$(python3 - "$BASE_URL" "$DB" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1]); print(p._replace(path="/" + sys.argv[2]).geturl())
PY
)"
  URL="http://127.0.0.1:$PORT"
  JAR="$TMP/jar"
}

smoke_cleanup() {
  local p
  for p in $CURL_PIDS; do kill "$p" 2>/dev/null || true; done
  [ -n "$SERVER_PID" ] && kill -- "-$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  psql "$BASE_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}

# smoke_prepare_db: create the throwaway database, export the app env, migrate and seed.
# Extra env (e.g. SSE_REVALIDATE_MS) may be exported by the caller afterwards.
smoke_prepare_db() {
  psql "$BASE_URL" -qc "CREATE DATABASE $DB"
  export DATABASE_URL="$DBURL" AUTH_SECRET=dummy-smoke-secret APP_SECRET=0123456789abcdef0123456789abcdef \
    AUTH_TRUST_HOST=true DATA_DIR="$TMP/data" ADMIN_USERNAME=smoke ADMIN_PASSWORD=smoke-pass-123 PORT="$PORT"
  npm run -s db:migrate
  npm run -s db:seed
}

# smoke_start_server: start `next start` in its own process group (prefix env with NODE_ENV=... if needed).
smoke_start_server() {
  setsid npx next start -p "$PORT" >"$TMP/server.log" 2>&1 &
  SERVER_PID=$!
}

smoke_wait_health() {
  local _
  for _ in $(seq 60); do curl -fs "$URL/api/health" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "FAIL: server did not become healthy"; tail -20 "$TMP/server.log"; return 1
}

# smoke_login: credentials login, cookie stored in $JAR.
smoke_login() {
  local csrf
  csrf="$(curl -s -c "$JAR" "$URL/api/auth/csrf" | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])')"
  curl -s -b "$JAR" -c "$JAR" -o /dev/null -X POST "$URL/api/auth/callback/credentials" \
    --data-urlencode "csrfToken=$csrf" --data-urlencode "username=$ADMIN_USERNAME" \
    --data-urlencode "password=$ADMIN_PASSWORD" --data-urlencode "redirect=false"
}
