# Danh sách kiểm tra bảo mật (T-7.4)

Trạng thái: **done** = đã làm và có test/kiểm chứng; **accepted** = rủi ro chấp nhận có lý do; **manual** = cần người kiểm tra tay trước khi đưa vào dùng.

## 1. Bảng kiểm soát

| # | Kiểm soát | Trạng thái | Chứng cứ / ghi chú |
|---|-----------|-----------|--------------------|
| 1 | Header bảo mật toàn app: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` (camera/microphone/geolocation/payment bị cấm) | done | `next.config.ts` `headers()`; `tests/security/headers.test.ts`; `scripts/smoke-headers.sh` (máy chủ thật, mỗi header đúng 1 lần trên `/login`, `/api/health`, `/api/units`) |
| 2 | CSP trang: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` | done / accepted | `'unsafe-inline'` cho script là chấp nhận có chủ đích: Next 16 chèn script khởi động nội tuyến, nonce theo yêu cầu buộc mọi trang render động và phải đi qua proxy cho từng yêu cầu. Rủi ro XSS được giảm bởi React escape, không có `dangerouslySetInnerHTML`, `object-src 'none'`, `connect-src 'self'`. Nâng lên nonce là việc tương lai. |
| 3 | PDF gốc: CSP riêng `default-src 'none'; sandbox`, `nosniff`, `Cache-Control: private, no-store` | done | `src/app/api/documents/[id]/file/route.ts`; `next.config.ts` loại route này khỏi luật CSP chung (header chỉ xuất hiện một lần, smoke-headers kiểm chứng) |
| 4 | **Trình xem PDF inline** (Chromium có thể để trống trình xem tích hợp khi CSP có `sandbox`) | manual | Mở một văn bản, bấm "Mở PDF gốc" trên Chrome/Edge và Firefox: PDF phải hiển thị. Nếu trống, bỏ `sandbox` khỏi CSP của route (giữ `default-src 'none'`) hoặc chuyển sang `Content-Disposition: attachment`. |
| 5 | HSTS | done (cấu hình sẵn, tắt) | Chỉ trong `Caddyfile`, dạng comment, bật khi site chạy HTTPS bằng tên miền. App không tự đặt HSTS (test khẳng định). |
| 6 | Cookie phiên: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` + tiền tố `__Secure-` ở production | done | `src/auth/cookie-options.ts` (test trong `tests/security/headers.test.ts`); `smoke-headers.sh` đọc `Set-Cookie` thật. Triển khai HTTP thuần (Caddy `:80`) phải đặt `AUTH_URL=http://...` để tắt `Secure`, nếu không trình duyệt bỏ cookie. Phiên JWT 12 giờ. |
| 7 | Xác thực và vai trò mọi route API | done | Mục 2; `tests/security/route-guards.test.ts` làm CI đỏ nếu thêm route không có `requireUser()`/`requireAdmin()` (ngoài allow-list auth, health). Route `admin/*` bắt buộc `requireAdmin()`. Trang `/admin` có `page-guard`. Tài khoản bị khóa → 401. |
| 8 | Mật khẩu: argon2id, tối thiểu 8, **tối đa 256 ký tự** (createUser, resetPassword, đăng nhập: vượt trần coi là sai thông tin, không gọi argon2) | done | `tests/admin/users.test.ts`, `tests/auth/authorize.test.ts` |
| 9 | Rate limit đăng nhập 5 lần/phút/IP, **trong bộ nhớ tiến trình** | accepted | **Không bao giờ chạy quá 1 instance `web`** (hạn mức bị nhân lên theo số instance, và SSE/subscribe cũng theo tiến trình). Scale ngang đòi hỏi kho dùng chung (Postgres/Redis). |
| 10 | Tải lên: chỉ `.pdf`, ≤50 MB/tệp, ≤10 tệp, ≤200 MiB/yêu cầu (Caddy 210 MB), kiểm tra magic `%PDF-` trên 5 byte đầu, tên tệp lưu trên đĩa do máy chủ sinh (UUID), tên gốc được làm sạch (điều khiển C0/C1, bidi override, `..`, `/`, `\`, cắt 255 ký tự không tách surrogate) | done | `tests/upload/upload.test.ts` |
| 11 | Đường dẫn tệp: `isInsideDataDir` dùng `realpath` (chống symlink thoát), `deletePdf` chỉ trong `${DATA_DIR}/pdf`, đọc markdown/PDF cũng kiểm tra realpath | done | `tests/upload/storage-paths.test.ts` |
| 12 | Bí mật: `APP_SECRET` (≥32 ký tự) mã hóa API key Dify bằng AES-256-GCM; `AUTH_SECRET` ký JWT; `.env` bị gitignore, repo chỉ có `.env.example` | done | Quét repo (`BEGIN PRIVATE`, `AKIA…`, `password=`, khóa dạng thật): không có bí mật; các dòng `password=` trong `scripts/smoke-*.sh` là biến môi trường. Xem mục 3 về hệ quả khi đổi bí mật. |
| 13 | API key Dify: không bao giờ trả ra ngoài; che (`maskKey`: chỉ 4 ký tự cuối khi phần sau `app-` ≥12 ký tự, ngược lại `****`); giải mã lỗi → `keyStatus: 'unreadable'`, bắt nhập lại key khi lưu | done | `tests/admin/integrations.test.ts` |
| 14 | Nhật ký (log): không ghi key, mật khẩu, nội dung văn bản; chỉ id văn bản + tên lớp lỗi | done | Rà `console.*` trong `src/`: chỉ thông điệp cố định và `err.name`/`constructor.name` (đã ép `/^\w{1,64}$/` ở disambiguate). Giữ quy tắc này cho code mới. |
| 15 | SSE `/api/events`: cần đăng nhập, kiểm tra lại phiên định kỳ (đóng khi khóa tài khoản/hết phiên), giới hạn số người nghe, không phát lại sự kiện cũ; `SSE_REVALIDATE_MS` ≥1000 ms và bị bỏ qua ở production; kết nối LISTEN bật keepAlive, truy vấn bổ sung có timeout 10 giây; client dừng thử lại và về `/login` khi bị 401 | done | `tests/events/*`, `tests/ui/use-document-events.test.tsx`, `scripts/smoke-sse.sh` (chạy server với `NODE_ENV=test` để dùng được `SSE_REVALIDATE_MS`) |
| 16b | So khớp: `disambiguate` không ném từ `catch` (tên lớp lỗi chỉ nhận `^\w{1,64}$`); bí danh chuẩn hóa thành rỗng bị từ chối (400) và bị bỏ qua trong bộ so khớp | done | `tests/matching/*`, `tests/admin/aliases.test.ts` |
| 16 | Toàn vẹn dữ liệu: không tắt đơn vị đang được quy tắc hoạt động tham chiếu (409) | done | `tests/admin/units.test.ts` |
| 17 | Hàng đợi/worker: cấu hình queue áp dụng cả cho queue đã tồn tại (`updateQueue`), dead-letter, quét văn bản kẹt >6 giờ (`ocr_processing`/`rule_checking` không còn job → failed "Công việc OCR bị kẹt, vui lòng chạy lại"), hàng chết thử lại 10 lần | done | `tests/worker/queue-upgrade.test.ts`, `tests/worker/reconcile.test.ts` |
| 18 | Phụ thuộc: `npm audit --omit=dev` | done | 0 lỗ hổng (2026-11-05). Toàn bộ `npm audit`: 12 mức *moderate*, 0 high/critical, đều thuộc công cụ dev (`drizzle-kit` → `@esbuild-kit` → esbuild dev-server; `eslint-config-next` → `@typescript-eslint` → minimatch), không nằm trong image chạy thật (`npm ci` build stage, runtime chỉ copy `.next/standalone` + `dist`). Cách sửa của npm là hạ cấp breaking (drizzle-kit 0.18, eslint-config-next 15) nên **chấp nhận** đến khi upstream phát hành bản vá. |
| 19 | Sao lưu / khôi phục | manual | Script do T-7.3 viết (`pg_dump` + volume `appdata`). Kiểm tra: khôi phục thử vào môi trường trống; nhớ sao lưu cả `APP_SECRET` (không có nó thì API key đã lưu không giải mã được). |
| 20 | Caddy: giới hạn body 210 MB, `-Server`; Postgres không publish cổng ra host (mạng `internal`) | done | `Caddyfile`, `docker-compose.yml` |

## 2. Route API và guard (sinh từ `src/app/api/**/route.ts`)

| Route | Phương thức | Guard |
|-------|-------------|-------|
| `/api/admin/aliases` | GET, POST | requireAdmin |
| `/api/admin/aliases/[id]` | DELETE | requireAdmin |
| `/api/admin/integrations` | GET | requireAdmin |
| `/api/admin/integrations/[key]` | PUT | requireAdmin |
| `/api/admin/integrations/[key]/test` | POST | requireAdmin |
| `/api/admin/rules` | GET, POST | requireAdmin |
| `/api/admin/rules/[id]` | PATCH, DELETE | requireAdmin |
| `/api/admin/rules/audit` | GET | requireAdmin |
| `/api/admin/units` | GET, POST | requireAdmin |
| `/api/admin/units/[id]` | PATCH | requireAdmin |
| `/api/admin/users` | GET, POST | requireAdmin |
| `/api/admin/users/[id]` | PATCH | requireAdmin |
| `/api/documents` | GET, POST | requireUser (route bị loại khỏi `proxy.ts` để không cắt body upload) |
| `/api/documents/[id]` | GET | requireUser |
| `/api/documents/[id]/classify` | POST | requireUser |
| `/api/documents/[id]/file` | GET | requireUser |
| `/api/documents/[id]/retry` | POST | requireUser |
| `/api/documents/[id]/status` | PATCH | requireUser |
| `/api/events` | GET | requireUser |
| `/api/units` | GET | requireUser |
| `/api/auth/[...nextauth]` | GET, POST | **công khai có chủ đích**: đăng nhập NextAuth, POST callback credentials có rate limit 5/phút/IP |
| `/api/health` | GET | **công khai có chủ đích**: health check của Docker, chỉ trả `{ok:true}` |

Ngoài guard trong route, `src/proxy.ts` chặn mọi yêu cầu chưa đăng nhập (trừ `/login`, `/api/auth`, `/api/health`).

## 3. Bí mật và hệ quả khi xoay vòng

- `APP_SECRET`: đổi → API key Dify đã lưu **không giải mã được**. Trang cấu hình hiển thị cảnh báo "không đọc được", "Kiểm tra kết nối" báo lỗi rõ ràng, và lần lưu kế tiếp **bắt buộc nhập lại key**. Worker báo lỗi cấu hình cho tới khi nhập lại.
- `AUTH_SECRET`: đổi → mọi phiên đăng nhập hiện tại mất hiệu lực (đăng nhập lại), không mất dữ liệu.
- Mật khẩu Postgres (`POSTGRES_PASSWORD`) đổi cùng lúc ở `.env` (`DATABASE_URL` tự ghép theo) và trong Postgres; phải URL-safe (`openssl rand -hex 24`).

## 4. Rủi ro đã biết và chấp nhận

- CSP `script-src 'unsafe-inline'` (mục 1.2).
- Rate limit trong bộ nhớ, một instance web (mục 1.9).
- Cookie phiên là JWT không có danh sách thu hồi; khóa tài khoản có hiệu lực ngay vì phiên được kiểm tra lại với DB ở mỗi yêu cầu (`buildSessionUser`).
- Phụ thuộc dev có 12 cảnh báo moderate (mục 1.18).
- Chưa kiểm thử xâm nhập; chưa có Caddy trong sandbox nên cú pháp `Caddyfile` mới (khối `header`) chưa chạy thử: kiểm tra bằng `caddy validate` khi triển khai.

## 5. Triển khai

Quy trình triển khai, cấu hình `AUTH_URL` (cờ Secure của cookie phiên), nối mạng Dify, HTTPS và xử lý sự cố: xem `docs/deploy.md`; kiểm tra sau triển khai: `scripts/post-deploy-check.sh`; sao lưu: `docs/backup.md`.
