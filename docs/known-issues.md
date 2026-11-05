# Tồn đọng và giới hạn đã biết

Tài liệu này tổng hợp những gì đã được review nhưng cố ý chưa làm, và những gì **chỉ kiểm chứng được trên server thật**.
Không có mục nào dưới đây là lỗi Critical hoặc Important; các lỗi loại đó đều đã sửa trước khi bàn giao.

## 1. Phải kiểm tra trên server thật (chưa chạy được trong môi trường phát triển vì không có Docker, Dify, trình duyệt)

1. Docker Engine cài được trên Ubuntu 26.04 chưa (nếu kho apt của Docker chưa hỗ trợ tên bản phát hành, dùng gói `docker.io` + `docker-compose-v2`, xem `docs/deploy.md`). `docker compose version` cần ≥ 2.20.
2. `docker compose up -d --build` chạy trọn: dịch vụ `migrate` kết thúc với mã 0, `web` và `worker` healthy, schema `pgboss` được tạo.
3. Tên mạng Docker của Dify và cổng nginx của Dify; "Kiểm tra kết nối" ở cả hai thẻ (OCR, agent) trong Quản trị > Tích hợp phải báo thành công.
4. Giới hạn của Dify: `UPLOAD_FILE_SIZE_LIMIT` (mặc định thấp hơn 50 MB của cổng thông tin), `NGINX_CLIENT_MAX_BODY_SIZE`, `GUNICORN_TIMEOUT` so với thời gian OCR file scan lớn.
5. Đăng nhập từ máy khác với `AUTH_URL=http://<IP>:8080` không bị đẩy về /login. Nếu nhiều người dùng chung một IP (NAT), giới hạn 5 lần đăng nhập/phút/IP dùng chung cho cả nhóm.
6. Thông báo thời gian thực qua Caddy (`encode gzip` + SSE): chuông thông báo cập nhật trong khoảng 1 giây. Nếu bị đệm, loại `text/event-stream` khỏi `encode`.
7. Xem file PDF gốc trong Chrome/Edge/Firefox (tiêu đề `Content-Security-Policy: sandbox` của route này có thể làm trình xem PDF tích hợp hiện trắng ở một số trình duyệt; nếu vậy bỏ `sandbox`, giữ `default-src 'none'`).
8. Một lần sao lưu và phục hồi thật bằng `scripts/backup.sh` / `scripts/restore.sh` ở chế độ compose (chế độ này mới chỉ được kiểm bằng `docker` giả lập).
9. Bộ nhớ khi build image (cần thêm khoảng 2 GB trong lúc Dify đang chạy).

## 2. Quyết định thiết kế cần chủ sở hữu xác nhận

- Người dùng không thuộc "đơn vị" nào: mọi người đăng nhập đều nhận mọi thông báo; bảng văn bản có bộ lọc theo đơn vị.
- Rule phải khớp đúng cả Cơ quan ban hành và Loại công văn (không có rule "mọi loại").
- Chỉ Admin tạo/sửa rule: nhân sự Ban thư ký cần quyền Admin để cập nhật rule.
- Chỉ văn bản không khớp rule (cần phân loại thủ công) mới sửa được đơn vị trong giao diện; khớp sai tự động thì admin sửa rule rồi upload lại.
- Mọi người dùng đăng nhập đều thấy mọi văn bản (hàng đợi làm việc chung theo spec).

## 3. Việc nhỏ chưa làm (không chặn triển khai)

Bảo mật/độ bền:
- Hộp công cụ `dify-gateway` (docker-compose.dify.yml) chạy bằng root với quyền mặc định; có thể thêm `cap_drop`, `no-new-privileges` sau khi thử trên server.
- `migrate`, `web`, `worker` cùng khai báo `build: .` với cùng tên image (nên chỉ build ở một service).
- Giới hạn tổng ngân sách thời gian của job OCR + agent chỉ được kiểm theo từng tích hợp, chưa theo cả job.
- `parseId` ở `src/server/rule-http.ts` và `api/admin/units/[id]` chưa chặn id lớn hơn int4 (admin-only, trả 500 thay vì 400).
- Worker đọc file không kiểm tra symlink (đường dẫn do chính server ghi).
- Không có đồng bộ thông báo khi upload mới (hàng mới hiện khi worker bắt đầu xử lý hoặc sau vòng làm mới 120 giây).
- Các race hiếm, chỉ-admin: bật lại rule đồng thời với tắt đơn vị; lần lưu cấu hình đầu tiên đồng thời.

Test/tài liệu:
- Vài test dùng chờ cố định ngắn hoặc phụ thuộc collation; test `globals-css` chỉ cấm tên thẻ trần.
- Mã thoát của `restore.sh` khi SQL lỗi là 3 (nên là 1); `pg_restore -f -` chưa dùng `--single-transaction` (ứng dụng không dùng large object).
- Regex cảnh báo `ADMIN_PASSWORD` không bắt giá trị có dấu nháy; `HTTP_PORT` trong `post-deploy-check.sh` không phải biến của Compose.
- Thông tin mặc định của Dify nêu trong tài liệu (giới hạn upload, timeout) lấy từ bản mô tả, chưa đối chiếu với bản Dify thực tế đang chạy.

## 4. Cách kiểm thử

- `npm test` (cần `DATABASE_URL` trỏ tới Postgres có quyền tạo database, `APP_SECRET` ≥ 32 ký tự).
- `npm run e2e` (Playwright, server thật + worker + Dify giả lập).
- `scripts/smoke-*.sh`: kiểm tra trên server `next start` thật (upload lớn, SSE, tiêu đề bảo mật).
