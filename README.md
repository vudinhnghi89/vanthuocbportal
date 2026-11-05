# Van Thu Portal

Cổng web cho đơn vị văn thư: tải lên công văn PDF (bản scan), hệ thống tự OCR qua **Dify**, tra business rule rồi **gợi ý đơn vị xử lý chính và đơn vị nhận thông tin**. Văn bản không khớp rule nào được chuyển cho **Ban thư ký**.

## Quy trình sử dụng

1. Văn thư đăng nhập và tải lên một hoặc nhiều PDF (tối đa 50 MB mỗi tệp).
2. Worker gửi PDF cho workflow OCR của Dify, nhận markdown và thông tin trích xuất (cơ quan ban hành, loại công văn, tiêu đề, tóm tắt).
3. Hệ thống chuẩn hóa tên cơ quan (bí danh), lọc rule đang hoạt động; khi có nhiều ứng viên thì hỏi agent của Dify để chọn một rule.
4. Văn thư xem kết quả, mở PDF gốc, chuyển trạng thái xử lý. Chỉ văn bản bị đánh dấu cần phân loại thủ công (không khớp rule nào) mới được văn thư chọn đơn vị bằng tay; văn bản đã khớp rule thì đơn vị do rule quyết định. Thông báo thời gian thực qua SSE.
5. Quản trị viên quản lý đơn vị, rule (có lịch sử), bí danh cơ quan, người dùng và cấu hình tích hợp Dify.

## Giới hạn đã biết

- Người dùng không thuộc đơn vị nào: mọi người đăng nhập đều nhận mọi thông báo (bảng văn bản có bộ lọc theo đơn vị).
- Một rule cần khớp chính xác cả **Cơ quan ban hành** lẫn **Loại công văn** (không có rule "mọi loại").
- Chỉ **admin** tạo/sửa được rule: nhân sự Ban thư ký phụ trách rule cần vai trò admin.
- Văn bản bị khớp rule sai tự động không đổi hướng được trên giao diện (cách xử lý: admin sửa rule rồi tải lên lại).
- Dify mặc định giới hạn tải lên 15 MB trong khi portal nhận tới 50 MB: phải chỉnh Dify trước khi dùng thật (`docs/deploy.md` mục 8.1).

## Kiến trúc

Next.js 16 (App Router, TypeScript) + Auth.js (đăng nhập tên/mật khẩu) + Drizzle ORM + PostgreSQL 16 + hàng đợi pg-boss. Triển khai bằng Docker Compose: `caddy` (cổng 8080/8443) -> `web`; `worker` (OCR, tra rule) và `migrate` (migration + seed, chạy một lần) dùng chung image với `web`; `postgres`. Dify chạy riêng trên cùng máy chủ. Sơ đồ chi tiết: `docs/deploy.md` mục 0.

## Tài liệu

| Tài liệu | Nội dung |
| --- | --- |
| `docs/deploy.md` | **Hướng dẫn triển khai chung máy chủ với Dify**, hợp đồng Dify, HTTPS, vận hành, xử lý sự cố |
| `docs/backup.md` | Sao lưu và phục hồi |
| `docs/security-checklist.md` | Bảng kiểm soát bảo mật, route và guard |
| `docs/superpowers/specs/2026-11-04-van-thu-portal-design.md` | Thiết kế |
| `docs/superpowers/plans/2026-11-04-van-thu-portal.md` | Kế hoạch triển khai |
| `docs/tickets.md` | Danh mục ticket |

## Triển khai nhanh (dành cho agent triển khai)

Trên Ubuntu Server đã có Docker và Dify; đọc `docs/deploy.md` trước khi chạy:

```bash
git clone https://github.com/vudinhnghi89/vanthuocbportal && cd vanthuocbportal && git checkout claude/serene-bohr-4c8y7s
cp .env.example .env && chmod 600 .env   # rồi điền bí mật (POSTGRES_PASSWORD là hex URL-safe, DATABASE_URL tự ghép), AUTH_URL, DIFY_NETWORK theo docs/deploy.md mục 4-5
docker compose up -d --build && scripts/post-deploy-check.sh
```

## Phát triển

Yêu cầu Node.js 22+ và PostgreSQL 16 cục bộ.

```bash
npm ci
# tạo role/database thử nghiệm, ví dụ: role vtp (CREATEDB), database vtp_test
export DATABASE_URL=postgres://vtp:vtp@localhost:5432/vtp_test
export APP_SECRET=0123456789abcdef0123456789abcdef0123   # >= 32 ký tự
export AUTH_SECRET=dev-secret
export ADMIN_USERNAME=admin ADMIN_PASSWORD=dev-password-1
npm run db:migrate && npm run db:seed
npm run dev                  # web tại http://localhost:3000
npm run worker               # tiến trình worker (terminal khác)
npm test                     # vitest (test DB tự tạo database tạm)
npm run lint && npm run typecheck && npm run build
npm run e2e                  # Playwright; đặt PW_CHROMIUM_PATH nếu không có trình duyệt tải sẵn
```

Đổi schema: sửa `src/db/schema.ts` rồi `npm run db:generate` (không sửa migration cũ).

## Cấu trúc thư mục

| Đường dẫn | Nội dung |
| --- | --- |
| `src/app` | Trang và route API (Next.js App Router): đăng nhập, văn bản, quản trị |
| `src/auth`, `src/proxy.ts` | Đăng nhập, guard `requireUser`/`requireAdmin`, bảo vệ route |
| `src/db` | Schema Drizzle, kết nối, `migrate`, `seed`, điểm vào container migrate |
| `src/matching` | Chuẩn hóa, trích xuất trường, khớp rule |
| `src/integrations/dify` | Client Dify (OCR, chọn rule) |
| `src/server`, `src/lib`, `src/components` | Logic nghiệp vụ, tiện ích, thành phần giao diện |
| `src/worker` | Worker pg-boss (OCR, reconcile, healthcheck) |
| `drizzle/` | Migration SQL (chỉ tiến) |
| `scripts/` | `backup.sh`, `restore.sh`, `post-deploy-check.sh`, script smoke |
| `tests/`, `e2e/` | Vitest và Playwright |
| `docker-compose.yml`, `docker-compose.dify.yml`, `Caddyfile`, `Dockerfile`, `.env.example` | Triển khai |

## Nhánh

Toàn bộ công việc hiện nằm trên nhánh `claude/serene-bohr-4c8y7s`. Nếu chủ sở hữu đã gộp vào `main`, dùng `main` (kiểm tra bằng `git branch -r`).
