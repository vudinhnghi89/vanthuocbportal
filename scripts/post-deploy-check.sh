#!/usr/bin/env bash
# Kiểm tra SAU triển khai, chỉ đọc (không sửa gì, không in bí mật). Chạy trên máy chủ, trong thư mục repo:
#   scripts/post-deploy-check.sh [--port 8080] [--tls-port 8443]
# In bảng PASS/WARN/FAIL; mã thoát 1 nếu có FAIL, 0 nếu không (WARN không làm hỏng).
# Dùng `docker compose` theo COMPOSE_FILE (từ môi trường hoặc .env) nên tự nhận override docker-compose.dify.yml.
# Cần: docker (compose plugin), curl; tùy chọn: ss, df, free.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=8080
TLS_PORT=8443
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port cần giá trị}"; shift 2 ;;
    --tls-port) TLS_PORT="${2:?--tls-port cần giá trị}"; shift 2 ;;
    -h | --help) sed -n 2,6p "$0"; exit 0 ;;
    *) echo "Tham số không hợp lệ: $1" >&2; exit 2 ;;
  esac
done
BASE="http://127.0.0.1:${PORT}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0
WARNS=0

report() { # report <PASS|WARN|FAIL|INFO> <tên> <chi tiết>
  case "$1" in FAIL) FAILS=$((FAILS + 1)) ;; WARN) WARNS=$((WARNS + 1)) ;; esac
  printf '%-5s %-34s %s\n' "$1" "$2" "$3"
}
dc() { docker compose "$@"; }

printf '%-5s %-34s %s\n' "KQ" "Kiểm tra" "Chi tiết"
printf '%-5s %-34s %s\n' "-----" "----------------------------------" "-------------------------"

# 1. Trạng thái các service.
if ! PS="$(dc ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' 2>"$TMP/ps.err")"; then
  report FAIL "docker compose ps" "không chạy được (docker/compose chưa cài hoặc sai thư mục?)"
  PS=""
fi
svc_line() { printf '%s\n' "$PS" | grep -E "^$1\|" | head -n 1; }
for s in postgres web worker caddy; do
  line="$(svc_line "$s")"
  IFS='|' read -r _ state health _ <<<"$line"
  if [ -z "$line" ]; then
    report FAIL "service $s" "không có (chưa 'up'?)"
  elif [ "$state" != "running" ]; then
    report FAIL "service $s" "trạng thái: $state"
  elif [ -n "$health" ] && [ "$health" != "healthy" ]; then
    report FAIL "service $s" "sức khỏe: $health"
  else
    report PASS "service $s" "running${health:+, $health}"
  fi
done
line="$(svc_line migrate)"
IFS='|' read -r _ state _ code <<<"$line"
if [ -z "$line" ]; then
  report FAIL "service migrate" "không có"
elif [ "$state" = "exited" ] && [ "$code" = "0" ]; then
  report PASS "service migrate" "đã thoát mã 0"
else
  report FAIL "service migrate" "trạng thái: $state, mã thoát: ${code:-?} (xem: docker compose logs migrate)"
fi
if [ -n "$(svc_line dify-gateway)" ]; then
  IFS='|' read -r _ state _ _ <<<"$(svc_line dify-gateway)"
  if [ "$state" = "running" ]; then report PASS "service dify-gateway" "running"; else report FAIL "service dify-gateway" "trạng thái: $state"; fi
fi

# 2. HTTP qua Caddy.
http_code() {
  local c
  c="$(curl -sS -m 10 -o "$TMP/body" -w '%{http_code}' "$@" 2>/dev/null || true)"
  printf '%s' "${c:-000}"
}
code="$(http_code "$BASE/api/health")"
if [ "$code" = "200" ] && tr -d ' \n' <"$TMP/body" | grep -q '"ok":true'; then
  report PASS "GET /api/health" "200 {\"ok\":true}"
else
  report FAIL "GET /api/health" "mã $code (kỳ vọng 200 và {\"ok\":true})"
fi
code="$(http_code "$BASE/login")"
if [ "$code" = "200" ]; then report PASS "GET /login" "200"; else report FAIL "GET /login" "mã $code (kỳ vọng 200)"; fi
code="$(http_code "$BASE/api/documents")"
if [ "$code" = "401" ]; then
  report PASS "GET /api/documents (chưa đăng nhập)" "401"
else
  report FAIL "GET /api/documents (chưa đăng nhập)" "mã $code (kỳ vọng 401)"
fi

# 3. Header bảo mật xuất hiện đúng một lần.
curl -sS -m 10 -D "$TMP/headers" -o /dev/null "$BASE/login" 2>/dev/null || : >"$TMP/headers"
for h in x-content-type-options x-frame-options; do
  n="$(grep -ci "^$h:" "$TMP/headers" || true)"
  if [ "$n" = "1" ]; then report PASS "header $h" "đúng một lần"; else report FAIL "header $h" "xuất hiện $n lần (kỳ vọng 1)"; fi
done

# 4. Volume dữ liệu ghi được bởi người dùng của ứng dụng.
for s in web worker; do
  if dc exec -T "$s" sh -c 'touch /data/.w && rm /data/.w' >/dev/null 2>&1; then
    report PASS "/data ghi được ($s)" "ok"
  else
    report FAIL "/data ghi được ($s)" "không ghi được (quyền volume? xem docs/deploy.md mục 11)"
  fi
done

# 5. Schema pgboss do worker tạo khi khởi động.
pg="$(dc exec -T postgres sh -c "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U vanthu -d vanthu -qAt -c \"select 1 from information_schema.schemata where schema_name='pgboss'\"" 2>/dev/null | tr -d '[:space:]')"
if [ "$pg" = "1" ]; then
  report PASS "schema pgboss" "tồn tại"
else
  report FAIL "schema pgboss" "chưa có (worker chưa khởi động xong? xem: docker compose logs worker)"
fi

# 6. Postgres không công bố cổng ra máy chủ; caddy công bố đúng cổng.
pub="$(dc port postgres 5432 2>/dev/null | tr -d '[:space:]')"
if [ -z "$pub" ]; then report PASS "Postgres không công bố cổng" "ok"; else report FAIL "Postgres không công bố cổng" "đang công bố: $pub"; fi

if command -v ss >/dev/null 2>&1; then
  listen="$(ss -ltn 2>/dev/null || true)"
  for p in "$PORT" "$TLS_PORT"; do
    if printf '%s\n' "$listen" | grep -Eq "[:.]${p}[[:space:]]"; then
      report PASS "cổng $p đang lắng nghe" "ok"
    else
      report FAIL "cổng $p đang lắng nghe" "không thấy trong ss -ltn"
    fi
  done
else
  report WARN "cổng $PORT/$TLS_PORT" "không có lệnh ss, bỏ qua"
fi

# 7. Cấu hình .env (không in giá trị).
if [ -f .env ]; then
  mode="$(stat -c '%a' .env 2>/dev/null || echo "?")"
  if [ "$mode" = "600" ]; then report PASS ".env quyền truy cập" "600"; else report WARN ".env quyền truy cập" "là $mode, nên chmod 600 .env"; fi
  if grep -Eq '^(POSTGRES_PASSWORD|DATABASE_URL|APP_SECRET|AUTH_SECRET)=.*change-me' .env; then
    report FAIL ".env còn giá trị mẫu" "một bí mật vẫn là change-me"
  else
    report PASS ".env không còn giá trị mẫu" "ok"
  fi
  if grep -Eq '^AUTH_URL=https?://(localhost|127\.0\.0\.1)' .env; then
    report WARN "AUTH_URL" "đang trỏ localhost; người dùng khác sẽ không đăng nhập được nếu truy cập bằng địa chỉ khác"
  fi
else
  report WARN ".env" "không có file .env trong thư mục này (Compose có thể dùng biến môi trường)"
fi

# 8. Dify: không đọc bí mật; chỉ kiểm tra mạng nếu dùng dify-gateway.
if [ -n "$(svc_line dify-gateway)" ]; then
  if dc exec -T worker node -e "fetch('http://dify-gateway/').then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1; then
    report PASS "worker -> dify-gateway" "kết nối được"
  else
    report WARN "worker -> dify-gateway" "không kết nối được (DIFY_NETWORK/DIFY_UPSTREAM sai?)"
  fi
fi
report INFO "Kết nối Dify" "mở Quản trị > Tích hợp > 'Kiểm tra kết nối' cho cả OCR và Agent"

# 9. Tài nguyên máy chủ.
root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
[ -n "$root" ] && [ -d "$root" ] || root=/
used="$(df -P "$root" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
if [ -z "$used" ]; then
  report WARN "dung lượng đĩa" "không đọc được df"
elif [ "$used" -ge 90 ]; then
  report WARN "dung lượng đĩa ($root)" "đã dùng ${used}% (còn dưới 10%)"
else
  report PASS "dung lượng đĩa ($root)" "đã dùng ${used}%"
fi
if command -v free >/dev/null 2>&1; then
  mem="$(free -m | awk '/^Mem:/ {print $2 " MB tổng, " $7 " MB khả dụng"}')"
  total="$(free -m | awk '/^Mem:/ {print $2}')"
  if [ -n "$total" ] && [ "$total" -lt 7500 ]; then report WARN "RAM" "$mem (khuyến nghị >= 8 GB khi chạy chung Dify)"; else report INFO "RAM" "$mem"; fi
fi

echo
echo "Tổng: ${FAILS} FAIL, ${WARNS} WARN"
[ "$FAILS" -eq 0 ]
