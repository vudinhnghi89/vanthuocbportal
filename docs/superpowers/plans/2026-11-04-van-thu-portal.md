# Van Thu Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web app cho văn thư: upload PDF scan → OCR qua Dify → tra business rule → gợi ý đơn vị xử lý, kèm quản trị rule có audit.

**Architecture:** Next.js (UI+API+SSE) và worker Node cùng codebase, PostgreSQL lưu dữ liệu và hàng đợi pg-boss, file trên volume, Dify gọi qua HTTP nội bộ. Docker Compose + Caddy trên Ubuntu Server 26.04.

**Tech Stack:** Next.js, TypeScript, Drizzle ORM, PostgreSQL 16, pg-boss, Auth.js, argon2, Vitest, Playwright, Docker Compose, Caddy.

**Spec:** `docs/superpowers/specs/2026-11-04-van-thu-portal-design.md`

## Global Constraints

- Chỉ dùng phần mềm mã nguồn mở, không dịch vụ trả phí, không license phí.
- OCR chạy tuần tự: worker concurrency = 1.
- Thứ tự tra rule: lọc `issuer` trước, rồi `doc_type`; đúng 1 → chốt; >1 → agent Dify; 0 → "Ban thư ký" + `needs_manual=true`.
- Trạng thái văn bản: `queued, ocr_processing, rule_checking, classified, unit_processing, done` (+ `failed`). Nhãn UI: Hàng đợi, Đang xử lý OCR, Đang tra soát rule, Hoàn tất phân loại, Đơn vị đang xử lý, Xong.
- API key Dify lưu mã hóa AES-256-GCM, không trả về trình duyệt.
- Upload: PDF, tối đa 50 MB, kiểm tra magic bytes `%PDF`, tên lưu bằng uuid.
- Mọi thay đổi rule và cấu hình tích hợp ghi audit (actor, trước, sau, thời gian).
- Postgres của app tách khỏi Postgres của Dify; Caddy dùng cổng 8080/8443.

## Review Focus

- `issuer` viết khác dấu/hoa thường/khoảng trắng ("Bộ Y Tế" vs "bo y te ") phải vẫn khớp rule; test ở T-5.1.
- Agent Dify trả `rule_id` ngoài danh sách ứng viên, trả rỗng, hoặc lỗi → xử lý như không khớp, không crash; test ở T-5.3.
- File không phải PDF đổi đuôi `.pdf`, file rỗng, file > 50 MB bị từ chối; test ở T-3.1.
- Worker restart giữa lúc OCR không tạo văn bản trùng hay kẹt `ocr_processing`; test ở T-3.2.
- Hai Admin sửa cùng một rule: lần ghi sau không làm mất audit của lần trước; test ở T-1.3.

---

Mỗi task ứng với một GitHub Issue cùng mã (T-x.y). Quy ước mỗi task: viết test trước → chạy thấy fail → cài đặt tối thiểu → chạy pass → commit.

## Epic E0 — Nền tảng

### T-0.1: Scaffold dự án và Docker Compose
**Files:** Create `package.json`, `next.config.ts`, `tsconfig.json`, `src/app/`, `src/worker/index.ts`, `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.env.example`, `vitest.config.ts`
**Interfaces:** Produces: script `npm run dev|build|test|worker`; compose services `web, worker, postgres, caddy` có giới hạn CPU/RAM; `GET /api/health` → `{ok:true}`.
- [ ] Test `tests/health.test.ts`: `GET /api/health` trả 200 `{ok:true}`.
- [ ] Cài scaffold; `docker compose up` chạy được 4 service; Caddy ở 8080/8443.
- [ ] Commit `chore: scaffold project and compose stack`.

### T-0.2: Schema DB và migration
**Files:** Create `src/db/schema.ts`, `src/db/client.ts`, `drizzle/`, `src/db/seed.ts`
**Interfaces:** Produces: các bảng ở mục 5 spec; `export const db`; seed tạo đơn vị "Ban thư ký" (`is_secretariat=true`) và một admin từ `ADMIN_USERNAME/ADMIN_PASSWORD`.
- [ ] Test `tests/db/schema.test.ts` (Postgres test container): migrate sạch, seed idempotent (chạy 2 lần vẫn 1 Ban thư ký).
- [ ] Commit `feat(db): schema, migrations, seed`.

### T-0.3: Xác thực và phân quyền
**Files:** Create `src/auth/config.ts`, `src/auth/guards.ts`, `src/app/login/page.tsx`
**Interfaces:** Produces: `requireUser(): Promise<Session>`, `requireAdmin(): Promise<Session>` (ném 401/403); rate limit đăng nhập 5 lần/phút/IP.
- [ ] Test: sai mật khẩu → 401; user gọi API admin → 403; admin → 200; vượt rate limit → 429.
- [ ] Commit `feat(auth): credentials login and role guards`.

### T-0.4: CI GitHub Actions
**Files:** Create `.github/workflows/ci.yml`
- [ ] Workflow chạy lint, typecheck, `vitest`, build trên mỗi PR; có service Postgres.
- [ ] Commit `ci: add test workflow`.

## Epic E1 — Admin: Rule, Đơn vị, Người dùng

### T-1.1: Quản lý đơn vị
**Files:** Create `src/app/admin/units/`, `src/server/units.ts`
**Interfaces:** Produces: `listUnits(): Unit[]`, `createUnit(name)`, `updateUnit(id, patch)`; không xóa/tắt được đơn vị `is_secretariat`.
- [ ] Test: tạo/sửa đơn vị; thao tác tắt "Ban thư ký" bị từ chối.
- [ ] Commit `feat(admin): units management`.

### T-1.2: CRUD rule (API + UI)
**Files:** Create `src/server/rules.ts`, `src/app/admin/rules/`, `src/app/api/admin/rules/route.ts`
**Interfaces:** Produces: `createRule(input: RuleInput, actorId): Rule`, `updateRule(id, patch, actorId)`, `deleteRule(id, actorId)`, `toggleRule(id, active, actorId)`, `listRules(filter)`. `RuleInput = {issuer, docType, title, summary, mainUnitId, infoUnitId, priority}`.
- [ ] Test: tạo rule thiếu `issuer` hoặc `docType` → lỗi validate; sửa/xóa/bật tắt hoạt động; chỉ admin gọi được.
- [ ] Commit `feat(admin): rules CRUD`.

### T-1.3: Lưu vết chỉnh sửa rule
**Files:** Modify `src/server/rules.ts`; Create `src/app/admin/rules/history/`
**Interfaces:** Produces: mỗi thao tác ghi `rule_audit(action, actor_id, before, after)` trong cùng transaction; `listRuleAudit(ruleId?)`.
- [ ] Test: mỗi create/update/delete/toggle sinh đúng một bản audit với before/after đúng; hai update đồng thời → đủ 2 bản audit, bản ghi rule nhất quán (dùng `SELECT … FOR UPDATE`).
- [ ] Commit `feat(admin): rule audit trail`.

### T-1.4: Quản lý người dùng
**Files:** Create `src/app/admin/users/`, `src/server/users.ts`
**Interfaces:** Produces: `createUser(username, password, role)`, `setActive(id, bool)`, `resetPassword(id, newPassword)`.
- [ ] Test: tạo user; tắt user thì không đăng nhập được; không tự tắt admin cuối cùng.
- [ ] Commit `feat(admin): users management`.

## Epic E2 — Tích hợp Dify

### T-2.1: Dify client
**Files:** Create `src/integrations/dify/client.ts`, `tests/mocks/dify-server.ts`
**Interfaces:** Produces:
`runOcr(cfg: DifySettings, pdfPath: string): Promise<{markdown: string; json: unknown}>`,
`pickRule(cfg: DifySettings, markdown: string, candidates: {id:number;title:string;summary:string}[]): Promise<number | null>`.
Upload `POST {base}/files/upload` rồi `POST {base}/workflows/run` (`response_mode=blocking`, `user` cố định `van-thu-portal`); lấy output theo `output_var_md`/`output_var_json`; timeout và retry theo `cfg` (backoff).
- [ ] Test với mock server: OCR thành công; 500 hai lần rồi thành công (retry); timeout → ném `DifyTimeoutError`; thiếu biến output → `DifyOutputError`; `pickRule` trả id lạ → `null`.
- [ ] Commit `feat(dify): ocr and rule-picker client`.

### T-2.2: Trang cấu hình tích hợp Dify
**Files:** Create `src/server/settings.ts`, `src/lib/crypto.ts`, `src/app/admin/integrations/`
**Interfaces:** Produces: `encryptSecret(plain): string`, `decryptSecret(enc): string` (AES-256-GCM, khóa từ `APP_SECRET`); `getDifySettings(key): DifySettings`; `saveDifySettings(key, input, actorId)`; `testConnection(key): {ok:boolean; message:string}`. Giao diện chỉ nhận/hiển thị key dạng che.
- [ ] Test: mã hóa rồi giải mã khớp; ciphertext khác nhau mỗi lần; API đọc cấu hình không chứa key thô; lưu cấu hình ghi `settings_audit` với key đã che.
- [ ] Commit `feat(admin): dify integration settings`.

## Epic E3 — Upload, hàng đợi, trạng thái

### T-3.1: API upload và lưu trữ
**Files:** Create `src/app/api/documents/route.ts`, `src/server/storage.ts`, `src/server/documents.ts`
**Interfaces:** Produces: `POST /api/documents` (multipart, nhiều file) → `[{id, filename, status:'queued'}]`; `savePdf(buffer): string` (đường dẫn uuid).
- [ ] Test: PDF hợp lệ → 201 + tạo `documents(queued)` + enqueue; file giả PDF, file rỗng, >50 MB → 400/413; tên file chứa `../` không ảnh hưởng đường dẫn lưu.
- [ ] Commit `feat(upload): pdf upload and storage`.

### T-3.2: Hàng đợi pg-boss và worker tuần tự
**Files:** Create `src/worker/queue.ts`, `src/worker/index.ts`
**Interfaces:** Produces: `enqueueOcr(documentId): Promise<void>`; worker đăng ký job `ocr` với `teamSize=1, teamConcurrency=1`; job idempotent theo `documentId` (`singletonKey`).
- [ ] Test: enqueue 3 văn bản → xử lý lần lượt không chồng lặp; enqueue trùng `documentId` chỉ tạo 1 job; giả lập worker dừng giữa chừng → job được giao lại và văn bản không tạo bản sao.
- [ ] Commit `feat(queue): sequential ocr worker`.

### T-3.3: State machine trạng thái
**Files:** Create `src/server/status.ts`
**Interfaces:** Produces: `transition(documentId, to: Status, opts:{actorId?:number; note?:string}): Promise<void>` kiểm tra chuyển hợp lệ, ghi `document_events`, phát sự kiện nội bộ cho SSE. Chuyển sai → `InvalidTransitionError`.
- [ ] Test: bảng chuyển hợp lệ/không hợp lệ (vd `queued→done` bị từ chối); gọi lặp cùng đích là no-op; mỗi lần chuyển sinh đúng 1 event.
- [ ] Commit `feat(status): document state machine`.

## Epic E4 — Pipeline OCR

### T-4.1: Job OCR
**Files:** Create `src/worker/jobs/ocr.ts`
**Interfaces:** Consumes: `runOcr` (T-2.1), `transition` (T-3.3). Produces: `handleOcrJob(documentId): Promise<void>`: `ocr_processing` → lưu md + `extracted` → chuyển `rule_checking` và gọi `runRuleCheck` (T-5.4).
- [ ] Test (mock Dify): thành công lưu md/json đúng; trạng thái đi đúng thứ tự.
- [ ] Commit `feat(ocr): ocr job handler`.

### T-4.2: Lỗi, thử lại, chạy lại
**Files:** Modify `src/worker/jobs/ocr.ts`; Create `src/app/api/documents/[id]/retry/route.ts`
**Interfaces:** Produces: `POST /api/documents/:id/retry` đưa văn bản `failed` về `queued` và enqueue lại.
- [ ] Test: Dify lỗi hết số lần retry → `failed` + lưu `error`; retry endpoint chỉ cho `failed`; sau retry xử lý được.
- [ ] Commit `feat(ocr): failure handling and retry`.

## Epic E5 — Tra rule

### T-5.1: Chuẩn hóa văn bản và bí danh cơ quan
**Files:** Create `src/matching/normalize.ts`, `src/app/admin/aliases/`
**Interfaces:** Produces: `normalize(s: string): string` (NFD bỏ dấu, `đ→d`, hạ chữ thường, gộp khoảng trắng, bỏ dấu câu ngoài); `canonicalIssuer(s: string, aliases: Alias[]): string`.
- [ ] Test: `normalize("  Bộ Y Tế ")==="bo y te"`; `"BỘ Y TẾ"` và `"bo y te"` cùng kết quả; alias "BYT" → "bo y te".
- [ ] Commit `feat(matching): vietnamese normalization and aliases`.

### T-5.2: Bộ khớp rule (issuer → doc_type)
**Files:** Create `src/matching/match.ts`
**Interfaces:** Produces: `matchRules(extracted: {issuer?:string; docType?:string}, rules: Rule[], aliases: Alias[]): Rule[]` (chỉ rule `active`, lọc issuer rồi doc_type).
- [ ] Test: 0 / 1 / nhiều rule; rule `active=false` bị bỏ qua; thiếu `issuer` trong JSON → mảng rỗng; khớp issuer nhưng sai doc_type → rỗng.
- [ ] Commit `feat(matching): issuer then type matcher`.

### T-5.3: Agent chọn rule khi nhiều ứng viên
**Files:** Create `src/matching/disambiguate.ts`
**Interfaces:** Consumes: `pickRule` (T-2.1). Produces: `disambiguate(markdown: string, candidates: Rule[]): Promise<Rule | null>` (trả `null` nếu agent lỗi, rỗng hoặc id ngoài ứng viên).
- [ ] Test: agent trả id hợp lệ → rule đó; id lạ, `null`, lỗi mạng → `null`.
- [ ] Commit `feat(matching): agent disambiguation`.

### T-5.4: Điều phối tra rule và fallback Ban thư ký
**Files:** Create `src/matching/run.ts`
**Interfaces:** Produces: `runRuleCheck(documentId): Promise<void>`: gọi `matchRules`; 1 → `single`; >1 → `disambiguate` (`agent` hoặc `none`); `none` → `info_unit = Ban thư ký`, `needs_manual=true`; cuối cùng `transition(..., 'classified')`.
- [ ] Test: ba nhánh `single/agent/none` ghi đúng `match_method`, hai đơn vị và `needs_manual`; kết thúc ở `classified`.
- [ ] Commit `feat(matching): rule check orchestration`.

## Epic E6 — Giao diện User

### T-6.1: Vùng kéo thả upload
**Files:** Create `src/app/(user)/page.tsx`, `src/components/Dropzone.tsx`
- [ ] Test component: kéo thả và chọn file đều gọi upload; từ chối file không phải PDF ngay phía client; hiện tiến trình từng file.
- [ ] Commit `feat(ui): drag-drop upload zone`.

### T-6.2: Danh sách, lọc, tìm kiếm
**Files:** Create `src/components/DocumentTable.tsx`, `src/app/api/documents/route.ts` (GET)
**Interfaces:** Produces: `GET /api/documents?status=&unit=&from=&to=&q=&page=` → `{items, total}`.
- [ ] Test: lọc theo từng tham số và kết hợp; tìm theo tên file; phân trang.
- [ ] Commit `feat(ui): document list and filters`.

### T-6.3: Cập nhật trạng thái thủ công
**Files:** Create `src/app/api/documents/[id]/status/route.ts`
**Interfaces:** Consumes: `transition`. Produces: `PATCH /api/documents/:id/status {to}` chỉ cho `classified→unit_processing→done`.
- [ ] Test: chuyển hợp lệ ghi event có `actor_id`; chuyển sai → 409.
- [ ] Commit `feat(ui): manual status update`.

### T-6.4: Thông báo thời gian thực (SSE)
**Files:** Create `src/app/api/events/route.ts`, `src/components/Notifier.tsx`
**Interfaces:** Produces: `GET /api/events` (SSE) phát `{documentId, status, mainUnit, infoUnit}` khi đổi trạng thái.
- [ ] Test: đổi trạng thái → client nhận sự kiện trong 2 giây; chưa đăng nhập → 401; tự kết nối lại khi rớt.
- [ ] Commit `feat(ui): sse notifications`.

### T-6.5: Chi tiết văn bản, phân loại thủ công, tạo rule từ văn bản
**Files:** Create `src/app/(user)/documents/[id]/page.tsx`, `src/app/api/documents/[id]/classify/route.ts`
**Interfaces:** Produces: `POST /api/documents/:id/classify {mainUnitId, infoUnitId}` (xóa `needs_manual`); nút "Tạo rule từ văn bản này" mở form rule điền sẵn `issuer, docType, title, summary` từ `extracted`.
- [ ] Test: phân loại thủ công lưu đơn vị và ghi event; form rule được điền sẵn đúng từ JSON; Admin lưu được rule mới từ form.
- [ ] Commit `feat(ui): document detail and manual classification`.

## Epic E7 — Chất lượng và triển khai

### T-7.1: E2E Playwright
**Files:** Create `e2e/*.spec.ts`
- [ ] Ba kịch bản: (1) upload → khớp rule → `classified` → `done`; (2) Admin sửa rule → xuất hiện trong lịch sử; (3) không khớp → Ban thư ký → tạo rule từ văn bản → upload lại tự khớp. Dify dùng mock server.
- [ ] Commit `test(e2e): core flows`.

### T-7.2: Tài liệu triển khai chung server với Dify
**Files:** Create `docs/deploy.md`
- [ ] Hướng dẫn cài Docker trên Ubuntu 26.04, nối chung network với Dify, cấu hình cổng (Caddy 8080/8443), biến môi trường (`APP_SECRET`, `DATABASE_URL`, `ADMIN_*`), nâng cấp, yêu cầu phần cứng (≥ 8 GB RAM).
- [ ] Commit `docs: deployment guide`.

### T-7.3: Sao lưu và phục hồi
**Files:** Create `scripts/backup.sh`, `scripts/restore.sh`, `docs/backup.md`
- [ ] `pg_dump` + nén `/data` theo cron hằng ngày, giữ 14 bản; script phục hồi; test chạy backup rồi restore vào DB trống và đối chiếu số dòng.
- [ ] Commit `ops: backup and restore`.

### T-7.4: Rà soát bảo mật
**Files:** Modify theo kết quả rà soát; Create `docs/security-checklist.md`
- [ ] Kiểm tra: header bảo mật (CSP, HSTS qua Caddy), cookie cờ, không log key/nội dung văn bản, quyền theo vai trò ở mọi route, `npm audit` không có lỗ hổng cao.
- [ ] Commit `chore(security): hardening pass`.

---

## Thứ tự và phụ thuộc

E0 → (E1, E2, E3 song song) → E4 → E5 → E6 → E7. Milestones: **M1** E0+E1, **M2** E2+E3+E4, **M3** E5, **M4** E6, **M5** E7.

## Self-review

- Mọi yêu cầu spec đều có task: rule/audit (T-1.x), Dify + cấu hình (T-2.x), hàng đợi tuần tự (T-3.2), 6 trạng thái (T-3.3, T-6.3), tra rule 3 nhánh (T-5.x), Ban thư ký + tạo rule (T-5.4, T-6.5), thông báo (T-6.4), lọc (T-6.2), triển khai chung server, backup (T-7.x).
- Chữ ký nhất quán: `transition`, `runOcr`, `pickRule`, `matchRules`, `disambiguate`, `runRuleCheck` dùng cùng tên ở các task.
