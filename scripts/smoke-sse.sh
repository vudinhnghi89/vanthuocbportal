#!/usr/bin/env bash
# Real-server smoke test for GET /api/events (needs `npm run build` done and a Postgres role with CREATEDB).
# Usage: ADMIN_DATABASE_URL=postgres://vtp:vtp@localhost:5432/vtp_test scripts/smoke-sse.sh
# Proves: no cookie -> 401 JSON; an authenticated stream is not buffered by Next (a real transition()
# arrives as an enriched `data:` frame within ~2s); deactivating the user closes the stream.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib-smoke.sh
source "$(dirname "$0")/lib-smoke.sh"
smoke_init vtp_smoke_sse
trap smoke_cleanup EXIT

smoke_prepare_db
export SSE_REVALIDATE_MS=3000
# SSE_REVALIDATE_MS is ignored when NODE_ENV=production, so run this smoke with NODE_ENV=test.
NODE_ENV=test smoke_start_server
smoke_wait_health

echo "--- no cookie"
curl -s -i --max-time 5 "$URL/api/events" | tee "$TMP/anon.txt" | sed -n '1p;/^content-type/Ip;$p'
grep -q '^HTTP/1.1 401' "$TMP/anon.txt" || { echo "FAIL: expected 401"; exit 1; }
grep -qi '^content-type: application/json' "$TMP/anon.txt" || { echo "FAIL: expected JSON"; exit 1; }

smoke_login

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
