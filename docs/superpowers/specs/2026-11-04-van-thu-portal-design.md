# Van Thu Portal — Thiết kế hệ thống

Ngày: 2026-11-04 · Trạng thái: chờ chủ dự án duyệt bản viết

## 1. Mục tiêu

Web app nội bộ cho đơn vị văn thư: upload PDF scan → OCR tự động (qua Dify) → tra bộ business rule → gợi ý
**Đơn vị xử lý chính** và **Đơn vị nhận thông tin**. Văn bản không khớp rule thì chuyển **Ban thư ký** phân loại thủ công;
Admin cập nhật rule để lần sau tự chạy.

Tiêu chí thành công:
- Văn bản khớp rule được phân loại không cần thao tác tay.
- Mọi thay đổi rule và cấu hình đều có lịch sử (ai, khi nào, trước/sau).
- Chạy trọn trên một server Ubuntu Server 26.04 LTS, chung server với Dify, không phát sinh chi phí hay license.

## 2. Phạm vi và giả định

- Hai vai trò: **Admin** và **User**, đăng nhập tài khoản nội bộ (không SSO/LDAP ở giai đoạn này).
- Quy mô: vài trăm văn bản/ngày; OCR chạy tuần tự (concurrency = 1).
- Tiêu đề và Tóm tắt trong rule chỉ làm ngữ cảnh cho agent, không dùng để lọc cứng.
- Ngoài phạm vi: SSO, đa tenant, OCR tự viết (dùng Dify), gửi email/Zalo.

## 3. Công nghệ (toàn bộ mã nguồn mở, không phí)

| Lớp | Lựa chọn |
|---|---|
| Web + API | Next.js (App Router) + TypeScript |
| DB | PostgreSQL 16 (instance riêng, tách khỏi Postgres của Dify) |
| ORM / migration | Drizzle ORM |
| Hàng đợi | pg-boss (trong Postgres, không cần Redis) |
| Auth | Auth.js (credentials) + argon2 |
| Realtime | Server-Sent Events |
| Triển khai | Docker Compose + Caddy (reverse proxy) |
| Test | Vitest, Playwright |
| CI | GitHub Actions |

## 4. Kiến trúc

```
Browser ──HTTPS──> Caddy ──> web (Next.js: UI + API + SSE)
                               │
                               ├──> Postgres (app data, audit, pg-boss queue)
                               └──> volume /data (PDF, md)
worker (Node, cùng codebase, concurrency=1) ──> Postgres (nhận job)
        └──HTTP nội bộ──> Dify (OCR workflow, agent chọn rule)
```

- `web` và `worker` là hai container từ cùng một image; worker chạy `node dist/worker.js`.
- Worker nối chung Docker network với Dify, gọi `http://<dify-nginx>/v1`. Base URL chỉnh được trong Admin.
- Caddy dùng cổng khác (mặc định 8080/8443) để không tranh cổng 80/443 của nginx Dify.
- Mỗi container có giới hạn CPU/RAM trong compose. Khuyến nghị server ≥ 8 GB RAM (tốt nhất 16 GB) vì Dify nặng.

## 5. Mô hình dữ liệu

- `users(id, username, password_hash, role[admin|user], active, created_at)`
- `units(id, name, is_secretariat, active)` — seed "Ban thư ký" (`is_secretariat = true`).
- `rules(id, issuer, doc_type, title, summary, main_unit_id, info_unit_id, priority, active, updated_at)`
  - `issuer`, `doc_type` dùng để lọc; `title`, `summary` làm ngữ cảnh cho agent.
- `rule_audit(id, rule_id, action[create|update|delete|toggle], actor_id, before jsonb, after jsonb, at)`
- `issuer_aliases(id, alias, canonical_issuer)` — bí danh cơ quan ban hành, để chuẩn hóa tên.
- `documents(id, filename, pdf_path, md_path, extracted jsonb, status, matched_rule_id, match_method[single|agent|none], main_unit_id, info_unit_id, needs_manual, error, uploaded_by, created_at, updated_at)`
- `document_events(id, document_id, from_status, to_status, actor_id null, note, at)`
- `integration_settings(key[dify_ocr|dify_agent], base_url, api_key_enc, input_var, output_var_md, output_var_json, timeout_s, retries, updated_by, updated_at)`
- `settings_audit(id, key, actor_id, before_masked, after_masked, at)`

Trạng thái `documents.status` (thứ tự hợp lệ):
`queued → ocr_processing → rule_checking → classified → unit_processing → done`,
cộng `failed` (lỗi OCR/tra soát; chuyển lại `queued` khi chạy lại). Chuyển trạng thái chỉ qua một hàm duy nhất ghi `document_events`.

## 6. Luồng xử lý

1. **Upload**: nhận PDF (≤ 50 MB, kiểm tra magic bytes `%PDF`), lưu `/data/pdf/<uuid>.pdf`, tạo `documents(status=queued)`, đẩy job `ocr`.
2. **OCR** (`ocr_processing`): worker upload file lên Dify `POST {base}/files/upload`, rồi `POST {base}/workflows/run`
   với biến file `{type:"document", transfer_method:"local_file", upload_file_id}`. Lấy `outputs[output_var_md]` và `outputs[output_var_json]`;
   lưu md ra `/data/md/<uuid>.md`, json vào `extracted`. Timeout/lỗi mạng: thử lại theo cấu hình (mặc định 3 lần, backoff), hết thì `failed`.
3. **Tra rule** (`rule_checking`):
   1. Chuẩn hóa `extracted.issuer` (bỏ dấu, hạ chữ thường, gộp khoảng trắng, áp `issuer_aliases`); lọc rule `active` theo issuer.
   2. Lọc tiếp theo `doc_type` (chuẩn hóa tương tự).
   3. Còn đúng 1 rule → chốt, `match_method=single`.
   4. Còn > 1 rule → gọi agent Dify với md + danh sách rule ứng viên (id, title, summary). Agent trả `rule_id`;
      nếu id không thuộc ứng viên hoặc agent lỗi → coi như không khớp. Thành công → `match_method=agent`.
   5. 0 rule → `match_method=none`, `info_unit = Ban thư ký`, `needs_manual=true`.
4. **Hoàn tất**: điền hai đơn vị, `status=classified`, phát sự kiện SSE.
5. **Thủ công**: User đổi tiếp `unit_processing` → `done`. Với `needs_manual`, Ban thư ký chọn đơn vị ở trang chi tiết;
   có nút "Tạo rule từ văn bản này" mở form rule điền sẵn issuer/doc_type/title/summary để Admin lưu.

## 7. Giao diện

- **User**: vùng kéo thả/chọn file ở trên cùng; bảng văn bản bên dưới có lọc (trạng thái, đơn vị, ngày), tìm kiếm, đổi trạng thái tại dòng;
  toast/chuông cập nhật tức thời qua SSE; trang chi tiết (xem md, JSON, lịch sử trạng thái, phân loại thủ công).
- **Admin**: quản lý rule (thêm/sửa/xóa/bật tắt, có tìm kiếm), lịch sử chỉnh sửa rule, quản lý đơn vị, quản lý người dùng,
  trang **Cấu hình tích hợp Dify** (base URL, API key che dạng `app-****abcd`, tên biến vào/ra, timeout, retry, nút "Kiểm tra kết nối").

## 8. Bảo mật

- Mật khẩu băm argon2; phiên bằng cookie httpOnly, SameSite=Lax; kiểm tra vai trò ở server cho mọi API admin.
- API key Dify mã hóa AES-256-GCM, khóa gốc từ biến môi trường `APP_SECRET`; không bao giờ trả key về trình duyệt.
- Upload: giới hạn kích thước, kiểm tra magic bytes, tên file lưu bằng uuid (chống path traversal).
- Rate limit đăng nhập; không log nội dung văn bản hay key.

## 9. Xử lý lỗi và vận hành

- Dify không sẵn sàng: retry theo cấu hình, văn bản vẫn nằm trong hàng đợi/`failed`, User bấm "Chạy lại".
- Job bị gián đoạn khi worker restart: pg-boss tự giao lại; hàm chuyển trạng thái idempotent.
- Sao lưu định kỳ Postgres (pg_dump) và `/data`, có tài liệu phục hồi.
- Health endpoint `/api/health` cho Caddy/giám sát.

## 10. Kiểm thử

- Unit: chuẩn hóa tiếng Việt, bộ khớp rule (0/1/nhiều), state machine, mã hóa key.
- Integration: Dify giả lập (mock server) cho OCR và agent; hàng đợi tuần tự; audit log.
- E2E (Playwright): upload → hàng đợi → phân loại → đổi trạng thái; admin sửa rule → audit; không khớp → Ban thư ký → tạo rule từ văn bản.
