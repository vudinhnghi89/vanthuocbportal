#!/usr/bin/env bash
# Real-server smoke test for GET /api/events (needs `npm run build` done and a Postgres role with CREATEDB).
# Usage: ADMIN_DATABASE_URL=postgres://vtp:vtp@localhost:5432/vtp_test scripts/smoke-sse.sh
# Proves: no cookie -> 401 JSON; an authenticated stream is not buffered by Next (a real transition()
# arrives as an enriched `data:` frame within ~2s); deactivating the user closes the stream.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_URL="${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL}"
DB="vtp_smoke_sse_$$"
TMP="$(mktemp -d)"
PORT="${PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1])')}"
DBURL="$(python3 - "$BASE_URL" "$DB" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1]); print(p._replace(path="/" + sys.argv[2]).geturl())
PY
)"
SERVER_PID=""
CURL_PIDS=""
cleanup() {
  for p in $CURL_PIDS; do kill "$p" 2>/dev/null || true; done
  # setsid: the server is a process group leader, so npx and its next-server child both die.
  [ -n "$SERVER_PID" ] && kill -- "-$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  psql "$BASE_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

psql "$BASE_URL" -qc "CREATE DATABASE $DB"
export DATABASE_URL="$DBURL" AUTH_SECRET=dummy-smoke-secret APP_SECRET=0123456789abcdef0123456789abcdef \
  AUTH_TRUST_HOST=true DATA_DIR="$TMP/data" ADMIN_USERNAME=smoke ADMIN_PASSWORD=smoke-pass-123 PORT="$PORT" \
  SSE_REVALIDATE_MS=3000
npm run -s db:migrate
npm run -s db:seed
setsid npx next start -p "$PORT" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 60); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done

JAR="$TMP/jar"; URL="http://127.0.0.1:$PORT"
echo "--- no cookie"
curl -s -i --max-time 5 "$URL/api/events" | tee "$TMP/anon.txt" | sed -n '1p;/^content-type/Ip;$p'
grep -q '^HTTP/1.1 401' "$TMP/anon.txt" || { echo "FAIL: expected 401"; exit 1; }
grep -qi '^content-type: application/json' "$TMP/anon.txt" || { echo "FAIL: expected JSON"; exit 1; }

CSRF="$(curl -s -c "$JAR" "$URL/api/auth/csrf" | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])')"
curl -s -b "$JAR" -c "$JAR" -o /dev/null -X POST "$URL/api/auth/callback/credentials" \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "username=$ADMIN_USERNAME" \
  --data-urlencode "password=$ADMIN_PASSWORD" --data-urlencode "redirect=false"

echo "--- open the stream"
curl -sN -i --max-time 20 -b "$JAR" "$URL/api/events" >"$TMP/stream.txt" 2>&1 &
CURL_PIDS="$!"
for _ in $(seq 40); do grep -q ': connected' "$TMP/stream.txt" 2>/dev/null && break; sleep 0.25; done
grep -q ': connected' "$TMP/stream.txt" || { echo "FAIL: no connected comment"; cat "$TMP/stream.txt"; exit 1; }
grep -qi '^content-type: text/event-stream' "$TMP/stream.txt" || { echo "FAIL: not event-stream"; exit 1; }
sleep 1 # let LISTEN settle

echo "--- real transition() rule_checking -> classified"
UNIT_A="$(psql "$DBURL" -Atqc "insert into units(name) values ('Phòng Smoke A') returning id")"
UNIT_B="$(psql "$DBURL" -Atqc "insert into units(name) values ('Phòng Smoke B') returning id")"
DOC="$(psql "$DBURL" -Atqc "insert into documents(filename,pdf_path,status,main_unit_id,info_unit_id,match_method) values ('smoke-01.pdf','/x.pdf','rule_checking',$UNIT_A,$UNIT_B,'single') returning id")"
T0=$(date +%s.%N)
npx tsx -e "
import { transition } from './src/server/status';
import { db } from './src/db/client';
transition('$DOC', 'classified').then(() => db.pool.end());
"
for _ in $(seq 40); do grep -q '^data: ' "$TMP/stream.txt" 2>/dev/null && break; sleep 0.1; done
T1=$(date +%s.%N)
grep -q '^data: ' "$TMP/stream.txt" || { echo "FAIL: no data frame"; cat "$TMP/stream.txt"; tail -20 "$TMP/server.log"; exit 1; }
grep -A3 '^id: ' "$TMP/stream.txt"
echo "frame seen $(python3 -c "print(round($T1-$T0,2))")s after starting the transition script (includes tsx startup)"
grep '^data: ' "$TMP/stream.txt" | grep -q 'Phòng Smoke A' || { echo "FAIL: units missing"; exit 1; }
grep '^data: ' "$TMP/stream.txt" | grep -q 'Phòng Smoke B' || { echo "FAIL: info unit missing"; exit 1; }
grep '^data: ' "$TMP/stream.txt" | grep -q '/x.pdf' && { echo "FAIL: pdf path leaked"; exit 1; }

echo "--- deactivate the user: stream must close at the next re-validation (3s here)"
psql "$DBURL" -qc "update users set active=false"
for _ in $(seq 100); do kill -0 "$CURL_PIDS" 2>/dev/null || break; sleep 0.1; done
kill -0 "$CURL_PIDS" 2>/dev/null && { echo "FAIL: stream still open after deactivation"; exit 1; }
echo "stream closed by server"
echo "SMOKE OK"
