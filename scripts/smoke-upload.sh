#!/usr/bin/env bash
# Real-server smoke test for PDF upload (needs `npm run build` done and a Postgres role with CREATEDB).
# Usage: ADMIN_DATABASE_URL=postgres://vtp:vtp@localhost:5432/vtp_test scripts/smoke-upload.sh
# Proves a ~12 MiB upload passes through the Next proxy (10 MiB body-copy cap) and that no cookie -> 401.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_URL="${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL}"
DB="vtp_smoke_$$"
TMP="$(mktemp -d)"
PORT="${PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1])')}"
DBURL="$(python3 - "$BASE_URL" "$DB" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1]); print(p._replace(path="/" + sys.argv[2]).geturl())
PY
)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  psql "$BASE_URL" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

psql "$BASE_URL" -qc "CREATE DATABASE $DB"
export DATABASE_URL="$DBURL" AUTH_SECRET=dummy-smoke-secret APP_SECRET=0123456789abcdef0123456789abcdef \
  AUTH_TRUST_HOST=true DATA_DIR="$TMP/data" ADMIN_USERNAME=smoke ADMIN_PASSWORD=smoke-pass-123 PORT="$PORT"
npm run -s db:migrate
npm run -s db:seed
npx next start -p "$PORT" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 60); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done

JAR="$TMP/jar"; URL="http://127.0.0.1:$PORT"
CSRF="$(curl -s -c "$JAR" "$URL/api/auth/csrf" | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])')"
curl -s -b "$JAR" -c "$JAR" -o /dev/null -X POST "$URL/api/auth/callback/credentials" \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "username=$ADMIN_USERNAME" \
  --data-urlencode "password=$ADMIN_PASSWORD" --data-urlencode "redirect=false"

{ printf '%%PDF-1.4\n'; head -c $((12 * 1024 * 1024)) /dev/zero; } >"$TMP/big.pdf"
echo "--- authenticated 12 MiB upload"
OUT="$(curl -s -b "$JAR" -w '\nHTTP %{http_code}\n' -F "files=@$TMP/big.pdf;type=application/pdf" "$URL/api/documents")"
echo "$OUT"
echo "$OUT" | grep -q 'HTTP 201' || { echo "FAIL: expected 201"; tail -20 "$TMP/server.log"; exit 1; }
echo "$OUT" | grep -q '"status":"queued"' || { echo "FAIL: not queued"; exit 1; }
echo "--- stored files"; ls -l "$TMP/data/pdf"
echo "--- pg-boss jobs"; psql "$DBURL" -Atc "select name, state from pgboss.job"
echo "--- no cookie"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -F "files=@$TMP/big.pdf;type=application/pdf" "$URL/api/documents")"
echo "HTTP $CODE"
[ "$CODE" = 401 ] || { echo "FAIL: expected 401"; exit 1; }
echo "SMOKE OK"
