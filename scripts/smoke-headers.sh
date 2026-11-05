#!/usr/bin/env bash
# Real-server smoke test for security headers and session cookie flags (needs `npm run build` done).
# Usage: ADMIN_DATABASE_URL=postgres://vtp:vtp@localhost:5432/vtp_test scripts/smoke-headers.sh
# Proves: each security header is present exactly once on /login, /api/health and an authenticated API route;
# the PDF route keeps its own stricter CSP (single value); the login Set-Cookie is HttpOnly + SameSite=Lax + Path=/.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_URL="${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL}"
DB="vtp_smoke_hdr_$$"
TMP="$(mktemp -d)"
PORT="${PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1])')}"
DBURL="$(python3 - "$BASE_URL" "$DB" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1]); print(p._replace(path="/" + sys.argv[2]).geturl())
PY
)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill -- "-$SERVER_PID" 2>/dev/null || true
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
setsid npx next start -p "$PORT" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 60); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
URL="http://127.0.0.1:$PORT"; JAR="$TMP/jar"

# once <file> <header-name> [expected-substring]: header present exactly once (case-insensitive).
once() {
  local n; n="$(grep -ci "^$2:" "$1" || true)"
  [ "$n" = "1" ] || { echo "FAIL: $2 appears $n times in $1"; cat "$1"; exit 1; }
  if [ -n "${3:-}" ]; then grep -i "^$2:" "$1" | grep -qiF -- "$3" || { echo "FAIL: $2 lacks '$3'"; exit 1; }; fi
}
check_common() {
  once "$1" x-content-type-options nosniff
  once "$1" referrer-policy same-origin
  once "$1" x-frame-options DENY
  once "$1" permissions-policy "camera=()"
}
check_page() {
  check_common "$1"
  once "$1" content-security-policy "frame-ancestors 'none'"
  if grep -qi '^strict-transport-security' "$1"; then echo "FAIL: HSTS must not be set by the app"; exit 1; fi
}

echo "--- /login"
curl -s -D "$TMP/login.h" -o /dev/null "$URL/login"; check_page "$TMP/login.h"; echo ok
echo "--- /api/health"
curl -s -D "$TMP/health.h" -o /dev/null "$URL/api/health"; check_page "$TMP/health.h"; echo ok

echo "--- login Set-Cookie flags"
CSRF="$(curl -s -c "$JAR" "$URL/api/auth/csrf" | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])')"
curl -s -b "$JAR" -c "$JAR" -D "$TMP/cb.h" -o /dev/null -X POST "$URL/api/auth/callback/credentials" \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "username=$ADMIN_USERNAME" \
  --data-urlencode "password=$ADMIN_PASSWORD" --data-urlencode "redirect=false"
SC="$(grep -i '^set-cookie: .*session-token' "$TMP/cb.h" | head -1 || true)"
echo "$SC" | sed 's/=[^;]*;/=<redacted>;/'
[ -n "$SC" ] || { echo "FAIL: no session cookie set"; cat "$TMP/cb.h"; exit 1; }
for f in "HttpOnly" "SameSite=Lax" "Path=/"; do echo "$SC" | grep -qi "$f" || { echo "FAIL: cookie lacks $f"; exit 1; }; done
echo "$SC" | grep -qi "; Secure" && echo "(Secure present: NODE_ENV=production over this server; browsers drop it on plain http)" || echo "NOTE: no Secure flag"

echo "--- authenticated API route (/api/units)"
curl -s -b "$JAR" -D "$TMP/units.h" -o /dev/null "$URL/api/units"; head -1 "$TMP/units.h"; check_page "$TMP/units.h"; echo ok

echo "--- PDF route keeps its own CSP (single value)"
UID_="$(psql "$DBURL" -Atqc "select id from users limit 1")"
mkdir -p "$TMP/data/pdf"; printf '%%PDF-1.4\n%%%%EOF\n' >"$TMP/data/pdf/x.pdf"
DOC="$(psql "$DBURL" -Atqc "insert into documents(filename,pdf_path,status,uploaded_by) values ('a.pdf','$TMP/data/pdf/x.pdf','failed',$UID_) returning id")"
curl -s -b "$JAR" -D "$TMP/pdf.h" -o /dev/null "$URL/api/documents/$DOC/file"; head -1 "$TMP/pdf.h"
once "$TMP/pdf.h" content-security-policy "default-src 'none'; sandbox"
once "$TMP/pdf.h" x-content-type-options nosniff
check_common "$TMP/pdf.h"; echo ok
echo "SMOKE OK"
