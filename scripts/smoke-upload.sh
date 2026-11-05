#!/usr/bin/env bash
# Real-server smoke test for PDF upload (needs `npm run build` done and a Postgres role with CREATEDB).
# Usage: ADMIN_DATABASE_URL=postgres://vtp:vtp@localhost:5432/vtp_test scripts/smoke-upload.sh
# Proves a ~12 MiB upload passes through the Next proxy (10 MiB body-copy cap) and that no cookie -> 401.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib-smoke.sh
source "$(dirname "$0")/lib-smoke.sh"
smoke_init vtp_smoke
trap smoke_cleanup EXIT

smoke_prepare_db
smoke_start_server
smoke_wait_health
smoke_login

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
