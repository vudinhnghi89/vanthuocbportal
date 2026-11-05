# Hướng dẫn triển khai (chung máy chủ với Dify)

Tài liệu cho **quản trị viên hoặc AI agent chỉ có đường dẫn repo** và một máy Ubuntu Server 26.04 LTS đã chạy Dify bằng Docker. Làm lần lượt từ mục 0 đến 12; mục 12 là danh sách lệnh tóm tắt để chạy và báo cáo lại cho chủ sở hữu.

Mọi lệnh dưới đây chạy trong thư mục repo (`vanthuocbportal`) trên máy chủ, trừ khi ghi khác. Không dán nội dung `.env` hay API key vào log/chat/báo cáo.

## 0. Tổng quan kiến trúc

```
 Trình duyệt người dùng
        |  http://<máy chủ>:8080   (hoặc https://<tên miền>:8443)
        v
 +--------------+        +---------------+        +----------------+
 |    caddy     | -----> |      web      | <----> |    postgres    |
 | 8080->80     |  :3000 | Next.js, API  |        | (không công bố |
 | 8443->443    |        | SSE, upload   |        |  cổng ra ngoài)|
 +--------------+        +-------+-------+        +--------^-------+
                                 | volume appdata (/data) |
                         +-------v-------+                |
                         |    worker     |----------------+   pg-boss (schema pgboss)
                         | OCR + tra rule|
                         +-------+-------+
                                 | HTTP (blocking)
                                 v
        +------ dify-gateway (tùy chọn) ------+      mạng Docker của Dify
        |  mạng "internal"  <->  mạng "dify"  | ---> nginx -> api (Dify)
        +-------------------------------------+
 migrate: container chạy một lần mỗi lần `up` (migration SQL + seed), web/worker chờ nó xong.
```

- Host `80/443` do nginx của Dify giữ; portal dùng **8080 (HTTP)** và **8443 (HTTPS)**.
- Một image duy nhất cho `web`, `worker`, `migrate`; Postgres, volume `appdata`, `pgdata` là dữ liệu cần sao lưu (`docs/backup.md`).

### Những điều phải quyết định / hỏi chủ sở hữu trước khi bắt đầu

| Câu hỏi | Ảnh hưởng |
| --- | --- |
| Truy cập bằng **IP máy chủ** hay **tên miền**? | `AUTH_URL` (mục 4). IP: `http://<IP>:8080`. Tên miền: xem mục 9. |
| Có bật **TLS (HTTPS)** không? | Mục 9. Mặc định triển khai chạy HTTP thuần ở cổng 8080 (đủ cho mạng nội bộ). |
| **Tên mạng Docker của Dify** là gì? | `DIFY_NETWORK` (mục 5). Tìm bằng `docker network ls`. |
| **Tên và mật khẩu admin** đầu tiên? | `ADMIN_USERNAME`, `ADMIN_PASSWORD` (mục 4). Không dùng mật khẩu mẫu. |
| Nơi đặt bản **sao lưu** và ai giữ `APP_SECRET`? | `docs/backup.md`. |
| Dify đã có sẵn workflow OCR và workflow Agent theo hợp đồng ở mục 8 chưa? | Nếu chưa, chủ sở hữu/ người quản Dify phải tạo; portal vẫn chạy nhưng chưa xử lý được văn bản. |

## 1. Yêu cầu

- CPU 4 nhân trở lên, **RAM tổng >= 8 GB** khi chạy cùng Dify (portal dùng tối đa khoảng 3,8 GB theo giới hạn trong compose: postgres 1 GB, web 1 GB, worker 1 GB, caddy 256 MB, migrate 512 MB chỉ lúc khởi động). Build image cần thêm khoảng 2 GB RAM tạm thời; nếu máy yếu hãy thêm swap.
- Đĩa trống **>= 20 GB** cho ảnh Docker, database và PDF (PDF tối đa 50 MB/tệp; cần theo dõi, xem mục 10).
- Cổng **8080 và 8443 trống** trên máy chủ: `ss -ltn | grep -E ':(8080|8443)\s'` phải không in gì. Nếu bị chiếm, đổi dòng `ports:` của `caddy` trong `docker-compose.yml` và cập nhật `AUTH_URL`.
- Truy cập Internet ra ngoài để build: Docker Hub (`node:22-alpine`, `postgres:16-alpine`, `caddy:2-alpine`) và npm registry.
- Tường lửa: nếu dùng `ufw`, mở cổng cho người dùng: `sudo ufw allow 8080/tcp` (và `8443/tcp` khi dùng HTTPS). Lưu ý: cổng do Docker công bố đi qua iptables của Docker và **có thể bỏ qua luật ufw**; vì vậy portal không công bố Postgres, web hay worker ra máy chủ, chỉ caddy.

## 2. Cài Docker Engine, compose plugin, git

Dify đang chạy bằng Docker nên Docker thường đã có. Kiểm tra trước:

```bash
docker --version
docker compose version     # cần Compose v2.20 trở lên (condition: service_completed_successfully)
git --version
```

Nếu thiếu, cài theo tài liệu chính thức cho Ubuntu (kho `apt` của Docker):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

**Cần xác minh trên máy thật:** kho của Docker có thể chưa có bản phát hành cho codename của Ubuntu 26.04. Nếu `apt-get update` báo lỗi 404 ở `download.docker.com`, hoặc `apt-cache policy docker-ce` rỗng, xóa file `/etc/apt/sources.list.d/docker.sources` và dùng gói của Ubuntu:

```bash
sudo apt-get install -y docker.io docker-compose-v2 git
```

Cho người dùng vận hành chạy được docker không cần `sudo` (đăng nhập lại sau lệnh): `sudo usermod -aG docker $USER`. Các lệnh bên dưới giả định đã làm bước này (nếu không, thêm `sudo`).

## 3. Lấy mã nguồn

```bash
git clone https://github.com/vudinhnghi89/vanthuocbportal
cd vanthuocbportal
git branch -r
git checkout claude/serene-bohr-4c8y7s
```

**Lưu ý nhánh:** hiện toàn bộ công việc nằm trên nhánh `claude/serene-bohr-4c8y7s`. Nếu chủ sở hữu đã gộp vào `main`, `git branch -r` sẽ cho thấy `origin/main` có chứa các file `docker-compose.dify.yml` và `docs/deploy.md` (kiểm tra: `git ls-tree origin/main --name-only | grep docker-compose.dify.yml`); khi đó dùng `git checkout main`. Ghi lại commit đang dùng: `git rev-parse --short HEAD`.

## 4. Cấu hình `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Sinh các bí mật (mỗi lệnh một giá trị, dán vào `.env`; **đừng in lại giá trị ra log**):

```bash
openssl rand -hex 24    # POSTGRES_PASSWORD
openssl rand -hex 32    # APP_SECRET (>= 32 ký tự)
openssl rand -hex 32    # AUTH_SECRET
```

Sửa `.env` (ví dụ bằng `nano .env`). Ý nghĩa từng biến có chú thích ngay trong `.env.example`; tóm tắt:

| Biến | Cách đặt |
| --- | --- |
| `POSTGRES_PASSWORD` | Chuỗi hex ở trên. |
| `DATABASE_URL` | `postgres://vanthu:<POSTGRES_PASSWORD>@postgres:5432/vanthu`. Host phải là `postgres`; mật khẩu phải **trùng** `POSTGRES_PASSWORD`. |
| `APP_SECRET` | Chuỗi hex 64 ký tự. Mất/đổi = API key Dify đã lưu không đọc được. **Lưu một bản ở nơi an toàn.** |
| `AUTH_SECRET` | Chuỗi hex 64 ký tự. |
| `AUTH_URL` | **Bắt buộc đúng.** Là URL người dùng gõ vào trình duyệt: `http://<IP-máy-chủ>:8080` (HTTP thuần) hoặc `https://<tên miền>:8443` (mục 9). Cookie phiên là `Secure` ở production trừ khi `AUTH_URL` bắt đầu bằng `http://`; đặt sai thì trình duyệt vứt cookie và đăng nhập quay về `/login` mãi mãi. Mặc định trong file mẫu là `http://localhost:8080`, chỉ đúng khi mở trình duyệt ngay trên máy chủ. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Tài khoản admin đầu tiên (tên 3-50 ký tự, mật khẩu 8-256 ký tự). Chỉ dùng ở lần seed đầu; sau đó không còn tác dụng với tài khoản đã tồn tại. |
| `DATA_DIR` | Giữ `/data`. |
| `DIFY_NETWORK`, `DIFY_UPSTREAM`, `COMPOSE_FILE` | Mục 5. |

Không cần `AUTH_TRUST_HOST`: mã nguồn đã bật `trustHost` để chạy sau Caddy (`src/auth/config.ts`). `SSE_REVALIDATE_MS` chỉ dành cho dev/test và bị bỏ qua ở production.

Kiểm tra nhanh mà không in bí mật:

```bash
stat -c '%a' .env                               # 600
grep -c 'change-me' .env                        # 0 (còn giá trị mẫu là chưa xong)
grep '^AUTH_URL=' .env                          # URL thật
docker compose config -q && echo "compose hợp lệ"
```

## 5. Nối mạng Dify

Worker (OCR, chọn rule) và web (nút "Kiểm tra kết nối") đều gọi API của Dify, nên các container này phải tới được Dify. Có ba cách; **cách A là mặc định khuyến nghị**.

### Cách A: `docker-compose.dify.yml` (cổng `dify-gateway` trong mạng Dify)

1. Tìm mạng Docker của Dify:
   ```bash
   docker network ls
   docker ps --format '{{.Names}}\t{{.Networks}}' | grep -i dify
   ```
   Với Dify cài theo hướng dẫn mặc định (thư mục `docker`, project `docker`) mạng thường là `docker_default`. Xác nhận bằng `docker network inspect <tên>` (phải thấy các container `nginx`, `api`, `web`... của Dify).
2. Xác nhận tên service nginx của Dify và cổng nội bộ (mặc định `nginx`, cổng 80): `docker network inspect <tên> --format '{{range .Containers}}{{.Name}} {{end}}'`. Tên container thường là `docker-nginx-1`, trong khi **alias DNS** trong mạng là tên service `nginx`; kiểm tra alias bằng `docker network inspect <tên> | grep -A3 Aliases`.
3. Ghi vào `.env`:
   ```
   DIFY_NETWORK=docker_default
   DIFY_UPSTREAM=nginx:80
   COMPOSE_FILE=docker-compose.yml:docker-compose.dify.yml
   ```
   (`COMPOSE_FILE` giúp mọi lệnh `docker compose` và cả `scripts/backup.sh`, `scripts/post-deploy-check.sh` tự dùng override; nếu không đặt, thêm `-f docker-compose.yml -f docker-compose.dify.yml` vào **mọi** lệnh compose.)
4. **Base URL nhập ở Quản trị > Cấu hình tích hợp: `http://dify-gateway/v1`.**

Tại sao không gắn thẳng `web`/`worker` vào mạng Dify: Docker thêm tên service làm alias DNS trên mọi mạng. Dify cũng có service `web` (cổng 3000) và `worker`; nếu service `web` của portal vào mạng Dify, nginx của Dify phân giải `web` ra cả container của portal và đôi lúc gửi người dùng Dify sang portal. `dify-gateway` có tên duy nhất nên an toàn. Nếu muốn gọi thẳng `http://api:5001/v1` hoặc `http://nginx/v1` từ web/worker, phải đổi tên service `web`/`worker` của portal trước; không khuyến nghị.

### Cách B: đi qua cổng Dify công bố trên máy chủ (không nối mạng)

Dùng khi không muốn/không thể nối mạng Docker của Dify. Tạo file override riêng (không commit), ví dụ `docker-compose.hostdify.yml`:

```yaml
services:
  web:
    extra_hosts: ["host.docker.internal:host-gateway"]
  worker:
    extra_hosts: ["host.docker.internal:host-gateway"]
```

Chạy với `-f docker-compose.yml -f docker-compose.hostdify.yml`. Base URL: `http://host.docker.internal:80/v1` (đổi `80` thành cổng nginx của Dify công bố trên máy chủ; xem bằng `docker ps`). Nếu ufw đang bật, cho phép container gọi vào máy chủ: `sudo ufw allow from 172.16.0.0/12 to any port 80 proto tcp`.

### Cách C: Dify ở máy khác

Dùng URL công khai/nội bộ của Dify (ví dụ `https://dify.example.vn/v1`) làm Base URL; không cần override. Container phải ra được địa chỉ đó.

Với mọi cách, **bạn phải tự xác minh trên máy thật** bằng nút "Kiểm tra kết nối" ở mục 7 (cần API key của Dify).

## 6. Build và khởi động

```bash
docker compose up -d --build
```

(Thêm `-f docker-compose.yml -f docker-compose.dify.yml` nếu không đặt `COMPOSE_FILE`.) Lần đầu mất khoảng 5-10 phút (kéo ảnh, `npm ci`, `next build`). Thứ tự khởi động:

1. `postgres` chạy và `healthy`.
2. `migrate` chạy một lần: áp dụng migration SQL từ `/app/drizzle`, rồi seed Ban thư ký và admin (nếu chưa có), thoát mã 0. Đầu ra mong đợi (không có bí mật):
   ```
   [migrate] áp dụng migration từ /app/drizzle
   [migrate] migration OK
   [migrate] seed OK (Ban thư ký + admin)
   ```
   Xem bằng `docker compose logs migrate`. Nếu lỗi (ví dụ `ADMIN_PASSWORD phải có từ 8 đến 256 ký tự`), `web` và `worker` sẽ **không** khởi động; sửa `.env` rồi chạy lại lệnh `up`.
3. `web` và `worker` khởi động sau khi `migrate` thành công. Lần đầu worker tạo schema `pgboss` của hàng đợi (pg-boss; cần quyền CREATE trên database, người dùng `vanthu` là chủ database nên đủ quyền).
4. `caddy` chạy khi `web` được tạo.

Kiểm tra: `docker compose ps -a` (mọi service `running`/`healthy`, `migrate` ở trạng thái `exited (0)`). Migration chỉ chạy tiến (forward-only); chạy lại `up` là an toàn (không làm gì thêm).

## 7. Kiểm tra sau triển khai

### 7.1 Tự động (chỉ đọc)

```bash
scripts/post-deploy-check.sh
```

In bảng PASS/WARN/FAIL (trạng thái service, `/api/health`, `/login`, `/api/documents` chưa đăng nhập trả 401, header bảo mật, `/data` ghi được, schema `pgboss`, Postgres không công bố cổng, cổng 8080/8443, đĩa/RAM, `.env`). Mã thoát khác 0 nếu có FAIL. Dùng `--port`/`--tls-port` nếu đã đổi cổng. Script không đọc bí mật và không kiểm tra được API key Dify.

### 7.2 Thủ công (bắt buộc, cần trình duyệt)

1. Mở `AUTH_URL` (ví dụ `http://<IP>:8080`), đăng nhập bằng `ADMIN_USERNAME`/`ADMIN_PASSWORD`. Nếu bị đưa về `/login` liên tục: xem mục 11 (`AUTH_URL`).
2. **Đổi mật khẩu admin ngay:** Quản trị > Người dùng > "Đặt lại mật khẩu" cho tài khoản admin.
3. Tạo dữ liệu nền: Quản trị > Đơn vị (các đơn vị xử lý), Quy tắc (rule theo cơ quan ban hành/loại công văn), Bí danh cơ quan, Người dùng (tài khoản văn thư).
4. Quản trị > Cấu hình tích hợp: điền **cả hai** thẻ (OCR workflow và Agent chọn rule) theo mục 8: Base URL (mục 5), API key `app-...`, tên biến. Bấm **"Kiểm tra kết nối"** ở từng thẻ; phải báo thành công.
5. Tải lên một PDF scan thử. Theo dõi trạng thái chuyển `Đang xử lý OCR` -> kết quả (thông báo SSE hiện ở chuông). Nếu kẹt: mục 11.
6. **Trình xem PDF inline:** mở văn bản đó, bấm "Xem file PDF gốc" trên Chrome/Edge **và** Firefox; PDF phải hiển thị. Nếu khung trống, bỏ `sandbox` khỏi CSP của route `/api/documents/[id]/file` (giữ `default-src 'none'`) theo mục 4 của `docs/security-checklist.md`.

## 8. Cấu hình Dify (hợp đồng)

Cả hai ứng dụng trong Dify là loại **Workflow** (không phải Chatflow), có **API truy cập** bật, dùng khóa ứng dụng dạng `app-...`. Portal gọi chế độ `blocking`, người dùng gọi cố định là `van-thu-portal`. Các endpoint dùng: `POST /files/upload`, `POST /workflows/run`, `GET /parameters` (nút kiểm tra kết nối).

### 8.1 OCR workflow (thẻ "OCR workflow")

- **Đầu vào:** một biến kiểu **tệp** (File, một tệp, cho phép tài liệu/PDF). Tên mặc định `file`, đổi được ở form tích hợp (phải khớp tên biến trong node Start của Dify). Portal tải PDF lên `/files/upload` rồi chạy workflow với `{"file": {"type":"document","transfer_method":"local_file","upload_file_id":"..."}}`.
- **Đầu ra** (node End/Output của workflow, tên đổi được ở form):
  - `markdown` (chuỗi): nội dung văn bản OCR. Bắt buộc là chuỗi (rỗng thì được).
  - `json` (đối tượng hoặc chuỗi JSON; được phép bọc trong hàng rào ```json ... ```): thông tin trích xuất.
- Các khóa JSON được nhận (không phân biệt dấu, hoa thường, khoảng trắng/gạch dưới; lấy giá trị chuỗi đầu tiên, hoặc phần tử chuỗi đầu của mảng; xem `src/matching/extract.ts`):

  | Trường | Khóa được chấp nhận |
  | --- | --- |
  | Cơ quan ban hành | `co_quan_ban_hanh`, `issuer`, `coquanbanhanh` |
  | Loại công văn | `loai_cong_van`, `doc_type`, `loai_van_ban` |
  | Tiêu đề | `tieu_de`, `title` |
  | Tóm tắt | `tom_tat`, `summary`, `trich_yeu` |

  Ví dụ đầu ra hợp lệ:
  ```json
  {
    "markdown": "# SỞ Y TẾ ...\nV/v triển khai ...",
    "json": "```json\n{\"co_quan_ban_hanh\": \"Sở Y tế\", \"loai_cong_van\": \"Công văn\", \"tieu_de\": \"V/v triển khai tiêm chủng\", \"tom_tat\": \"Đề nghị các đơn vị ...\"}\n```"
  }
  ```
  Hoặc `json` là đối tượng `{"co_quan_ban_hanh":"Sở Y tế","loai_cong_van":"Công văn","tieu_de":"...","tom_tat":"..."}`.
- Thiếu biến `markdown` hoặc `json`, hoặc `json` không phải JSON hợp lệ, là lỗi (văn bản chuyển `Lỗi`, dùng "Chạy lại" sau khi sửa workflow). Mặc định: thời gian chờ 300 giây, thử lại 3 lần (lỗi mạng, timeout, 429, 5xx).

### 8.2 Agent chọn rule (thẻ "Agent chọn rule")

Dùng để phân xử khi có các rule ứng viên (`candidates`) cần chọn một.

- **Đầu vào:**
  - biến văn bản (tên mặc định `markdown`, đổi được): nội dung markdown của văn bản, **cắt ở 30000 ký tự đầu** (`src/matching/disambiguate.ts`);
  - biến `candidates` (cố định tên này): **chuỗi JSON** của `[{"id": 12, "title": "...", "summary": "..."}, ...]`.
- **Đầu ra:** một biến (tên mặc định `rule_id`, đổi được ở ô "tên biến JSON đầu ra"), chứa id của rule được chọn dưới dạng: số `12`, chuỗi số `"12"`, hoặc `{"rule_id": 12}` (cũng chấp nhận dạng chuỗi JSON của hai kiểu sau, kể cả bọc trong ```). Ô "biến markdown đầu ra" không dùng nhưng vẫn phải điền (mặc định `markdown`).
- Trả về rỗng, rác, hoặc id không nằm trong danh sách ứng viên: coi như **không khớp** và văn bản chuyển cho **Ban thư ký**. Lỗi mạng/timeout (sau khi thử lại) cũng được coi là không khớp. Mặc định: chờ 120 giây, thử lại 2 lần.

Ví dụ đầu ra hợp lệ: `12`, `"12"`, `{"rule_id": 12}`. Ví dụ bị coi là không khớp: `""`, `"không rõ"`, `{"rule_id": null}`, `999` (không có trong ứng viên).

## 9. HTTPS (tùy chọn)

Mặc định `Caddyfile` phục vụ HTTP thuần (`:80` trong container, tức cổng 8080 trên máy chủ). Để bật HTTPS:

1. Sửa `Caddyfile`: đổi `:80 {` thành tên miền, ví dụ `portal.example.vn {`. Bỏ comment dòng `header Strict-Transport-Security ...` **chỉ khi chắc chắn** HTTPS ổn định. Nên thêm khối tùy chọn toàn cục ở đầu file: `{ auto_https disable_redirects }` (nếu không, Caddy chuyển hướng HTTP sang `https://<miền>` **không kèm `:8443`**, làm hỏng người dùng truy cập qua 8443).
2. Đặt `AUTH_URL=https://portal.example.vn:8443` trong `.env` (đổi sang `https://` bắt buộc khi đã có TLS; **bỏ `:8443` nếu đã đưa cổng 443 chuẩn như tùy chọn 3 bên dưới**).
3. `docker compose up -d` (nạp lại `.env` và `Caddyfile`); kiểm tra `docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile`.

Vì host 80/443 do Dify giữ, Caddy tự cấp chứng chỉ chỉ hoạt động nếu máy chủ được truy cập từ Internet **qua cổng 80/443 ngoài** (cần HTTP-01/TLS-ALPN-01). Các lựa chọn:

| Tùy chọn | Mô tả |
| --- | --- |
| 1. Chuyển cổng ở router/tường lửa | Cổng ngoài 80 chuyển tới 8080, 443 chuyển tới 8443 của máy chủ; Caddy cấp chứng chỉ Let's Encrypt như bình thường. Người dùng nội bộ vẫn truy cập `https://<miền>:8443` hoặc đi qua cổng 443 ngoài. |
| 2. Chứng chỉ có sẵn (mạng nội bộ, CA của cơ quan) | Mount thư mục chứa `fullchain.pem`/`privkey.pem` vào caddy (thêm vào `volumes` của `caddy`) và đặt `tls /certs/fullchain.pem /certs/privkey.pem` trong khối site. Hoặc `tls internal` (CA riêng của Caddy; phải cài chứng chỉ gốc vào máy người dùng, nếu không có cảnh báo trình duyệt). |
| 3. Một reverse proxy chung cho cả Dify và portal | Đưa nginx/Caddy/Traefik chung giữ 80/443 cho cả hai, chuyển `/` của miền Dify tới nginx Dify và miền portal tới `caddy:80` của portal (gỡ `ports:` của caddy hoặc giữ làm cổng nội bộ). Cần chỉnh cấu hình Dify, nên báo chủ sở hữu quyết định. Giữ `flush_interval -1` cho SSE và giới hạn body >= 210 MB (mục 11). |

## 10. Vận hành

- **Log:** `docker compose logs -f worker`, `docker compose logs -f web`, `docker compose logs --tail=200 migrate`.
- **Khởi động lại:** `docker compose restart worker` (hoặc `web`). Worker tắt êm trong tối đa 30 giây (`stop_grace_period: 45s`).
- **KHÔNG nhân bản worker** (`docker compose up --scale worker=2` hoặc chạy thêm một worker thủ công): mỗi tiến trình xử lý đúng một OCR một lúc (concurrency = 1) và thiết kế giả định chỉ một worker. **Chỉ một instance `web`**: giới hạn tần suất đăng nhập nằm trong bộ nhớ của tiến trình.
- **Cập nhật phiên bản:**
  ```bash
  scripts/backup.sh --dir /mnt/backup/vtp     # sao lưu trước (docs/backup.md)
  git pull
  docker compose up -d --build
  scripts/post-deploy-check.sh
  ```
  Migration chỉ tiến (forward-only). **Quay lui:** `git checkout <commit-trước>` và `docker compose up -d --build`; nếu migration mới đã chạy và không tương thích bản cũ thì phải phục hồi bản sao lưu trước đó bằng `scripts/restore.sh` (xem `docs/backup.md`), không có lệnh "down migration".
- **Sao lưu:** `scripts/backup.sh` (cron/systemd timer, sao chép ra ngoài máy chủ, diễn tập phục hồi): toàn bộ ở `docs/backup.md`. Việc cài cron là bước vận hành, không tự cài bởi `docker compose up`.
- **Người dùng:** Quản trị > Người dùng (tạo, khóa, đặt lại mật khẩu). Khóa có hiệu lực ngay.
- **Xoay vòng bí mật:** đổi `APP_SECRET` => phải nhập lại API key Dify ở Quản trị > Cấu hình tích hợp; đổi `AUTH_SECRET` => mọi người phải đăng nhập lại; đổi mật khẩu Postgres => đổi đồng thời `POSTGRES_PASSWORD` và mật khẩu trong database (`ALTER USER vanthu PASSWORD ...`) và `DATABASE_URL`. Sau khi sửa `.env`: `docker compose up -d`.
- **Dung lượng đĩa:** theo dõi `df -h` và `docker system df`; PDF nằm trong volume `appdata`, database trong `pgdata`. Dọn ảnh cũ sau cập nhật: `docker image prune -f`. **Không bao giờ** chạy `docker compose down -v` (xóa volume = mất dữ liệu).
- Dify được quản lý riêng; cập nhật Dify không ảnh hưởng portal trừ khi đổi tên mạng/service (cập nhật `DIFY_NETWORK`/`DIFY_UPSTREAM`).

## 11. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách xử lý |
| --- | --- | --- |
| Đăng nhập xong lại về `/login` (vòng lặp), hoặc không có cookie phiên | `AUTH_URL` sai: cookie `Secure` bị trình duyệt vứt khi truy cập bằng HTTP, hoặc host không khớp | Đặt `AUTH_URL` đúng URL đang dùng (`http://<IP>:8080`; chỉ `https://` khi đã bật TLS), `docker compose up -d`, xóa cookie trình duyệt và thử lại. |
| 502 Bad Gateway từ Caddy | `web` chưa chạy/chưa healthy (migrate lỗi, thiếu biến, hết RAM) | `docker compose ps -a`, `docker compose logs migrate web`; sửa `.env` rồi `docker compose up -d`. |
| Văn bản dừng ở "Đang xử lý OCR" | Worker không chạy, Dify chậm/không tới được, hoặc job bị kẹt | `docker compose ps worker`, `docker compose logs -f worker`; kiểm tra Dify (mục 5, 7.2). Bộ quét tự động đánh dấu `Lỗi` các văn bản kẹt quá khoảng 6 giờ; dùng nút **"Chạy lại"** cho văn bản `Lỗi`. |
| "Chưa cấu hình tích hợp Dify" | Chưa lưu Base URL/API key/tên biến cho OCR hoặc Agent | Quản trị > Cấu hình tích hợp, điền cả hai thẻ, "Kiểm tra kết nối". |
| "Không giải mã được API key" | `APP_SECRET` hiện tại khác lúc lưu key | Khôi phục đúng `APP_SECRET` cũ; nếu mất, nhập lại API key ở Quản trị > Cấu hình tích hợp. |
| Thông báo (chuông) không đến tức thời | Proxy đệm phản hồi SSE | Trong Caddyfile giữ `flush_interval -1` trong `reverse_proxy`; nếu có thêm proxy phía trước, tắt đệm (nginx: `proxy_buffering off`). |
| Tải lên lỗi: tệp > 10 MB, hoặc mã 411/413 | Proxy phía trước giới hạn body/thiếu `Content-Length` (portal yêu cầu `Content-Length`; trả 411 nếu thiếu và 413 nếu > 200 MiB) | Caddy đã đặt `request_body max_size 210MB`. Nếu có proxy khác (nginx: `client_max_body_size 210m`), nâng giới hạn và không dùng mã hóa chunked cho upload. |
| Postgres hết đĩa / container postgres thoát | Đĩa đầy | `df -h`, `docker system df`; giải phóng chỗ (`docker image prune -f`, xóa log, chuyển bản sao lưu đi), `docker compose up -d`. Kiểm tra lại với `scripts/post-deploy-check.sh`. |
| `permission denied` khi ghi `/data` | Volume `appdata` thuộc người dùng khác (ứng dụng chạy uid 1000 `node`) | `docker compose run --rm --user root --no-deps web chown -R 1000:1000 /data` rồi `docker compose up -d`. |
| "Kiểm tra kết nối" lỗi mạng / `ENOTFOUND` / `ECONNREFUSED` | Container không tới được Dify: sai `DIFY_NETWORK`, `DIFY_UPSTREAM`, Base URL | Kiểm tra mục 5: `docker network inspect <DIFY_NETWORK>`; Base URL đúng (`http://dify-gateway/v1`); `docker compose exec -T worker node -e "fetch('http://dify-gateway/').then(r=>console.log(r.status),e=>console.log(e.cause&&e.cause.code))"` (in mã HTTP hoặc mã lỗi). |
| `network ... declared as external, but could not be found` | `DIFY_NETWORK` sai, hoặc Dify chưa chạy | `docker network ls` rồi sửa `DIFY_NETWORK` trong `.env`. |
| Ngày giờ lệch, lọc theo ngày thiếu/dư | Múi giờ | Giao diện và bộ lọc ngày dùng múi giờ `Asia/Ho_Chi_Minh`; dữ liệu lưu UTC. Máy chủ để UTC là bình thường. |
| `migrate` thoát mã 1 | Biến `.env` sai (ví dụ `ADMIN_PASSWORD` quá ngắn, `DATABASE_URL` sai mật khẩu) | `docker compose logs migrate` (thông báo không chứa mật khẩu), sửa `.env`, `docker compose up -d`. |

## 12. Danh sách lệnh cho agent triển khai

Chạy lần lượt; mỗi bước có kết quả mong đợi. Dừng và báo cáo nếu có bước nào khác kỳ vọng.

1. `docker --version && docker compose version && git --version` : cả ba in phiên bản (Compose >= 2.20). Nếu thiếu: mục 2.
2. `ss -ltn | grep -E ':(8080|8443)\s' ; echo "rc=$?"` : không in dòng nào (`rc=1`).
3. `git clone https://github.com/vudinhnghi89/vanthuocbportal && cd vanthuocbportal` : thư mục repo.
4. `git branch -r && git checkout claude/serene-bohr-4c8y7s` (hoặc `git checkout main` nếu đã gộp, mục 3) : đã chuyển nhánh; `git rev-parse --short HEAD` in commit.
5. `cp .env.example .env && chmod 600 .env` : file tạo, quyền 600.
6. `openssl rand -hex 24; openssl rand -hex 32; openssl rand -hex 32` : ba chuỗi cho `POSTGRES_PASSWORD`, `APP_SECRET`, `AUTH_SECRET`; điền vào `.env` cùng `DATABASE_URL`, `AUTH_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` (mục 4).
7. `grep -c 'change-me' .env; grep '^AUTH_URL=' .env` : `0` và URL thật.
8. `docker network ls` và `docker ps --format '{{.Names}}\t{{.Networks}}'` : xác định `DIFY_NETWORK`, ghi vào `.env` cùng `DIFY_UPSTREAM` và `COMPOSE_FILE=docker-compose.yml:docker-compose.dify.yml` (mục 5).
9. `docker compose config -q && echo OK` : in `OK` (không báo thiếu biến).
10. `docker compose up -d --build` : build xong, không lỗi; mất 5-10 phút lần đầu.
11. `docker compose logs migrate` : thấy `migration OK` và `seed OK`.
12. `docker compose ps -a` : `postgres`, `web`, `worker` healthy; `caddy` running; `migrate` exited (0); `dify-gateway` running nếu dùng cách A.
13. `scripts/post-deploy-check.sh` : bảng không có FAIL, mã thoát 0. Lưu đầu ra để báo cáo.
14. Mở `AUTH_URL` trong trình duyệt, đăng nhập admin, đổi mật khẩu admin (Quản trị > Người dùng) : đăng nhập thành công, không bị đưa về `/login`.
15. Quản trị > Cấu hình tích hợp: điền hai thẻ theo mục 8, bấm "Kiểm tra kết nối" ở cả hai : cả hai báo thành công.
16. Tạo đơn vị, rule, bí danh cơ quan (mục 7.2), tải lên PDF thử : văn bản đi hết luồng; "Xem file PDF gốc" hiển thị trên Chrome/Edge/Firefox (nếu trống: mục 7.2 bước 6).
17. Cài sao lưu định kỳ theo `docs/backup.md` mục 3 (`scripts/backup.sh` trong cron/systemd) và chạy thử một lần: `scripts/backup.sh --dir /mnt/backup/vtp` : thư mục sao lưu có `db.dump`, `data.tar.gz`, `SHA256SUMS`, `MANIFEST`.
18. Mở cổng tường lửa nếu cần: `sudo ufw allow 8080/tcp` : `sudo ufw status` có luật.

### Mẫu báo cáo cho chủ sở hữu

```
BÁO CÁO TRIỂN KHAI VAN THU PORTAL
- URL truy cập: <AUTH_URL>            (HTTP/HTTPS: ...)
- Commit/nhánh đã triển khai: <hash> / <nhánh>
- Tài khoản admin đã tạo: <ADMIN_USERNAME> (mật khẩu đã đổi: có/không; KHÔNG ghi mật khẩu vào báo cáo)
- Cổng đang dùng: 8080 (HTTP), 8443 (HTTPS), tường lửa: <đã mở/chưa>
- Mạng Dify: <DIFY_NETWORK>, Base URL đã nhập: <http://dify-gateway/v1 hoặc khác>
- Kết quả "Kiểm tra kết nối": OCR <OK/lỗi>, Agent <OK/lỗi>
- Đầu ra scripts/post-deploy-check.sh: <dán bảng, không chứa bí mật>
- Việc thủ công còn tồn: <ví dụ: trình xem PDF trên Firefox chưa kiểm tra; HTTPS chưa bật; đã/ chưa tạo rule>
- Sao lưu: cron đã cài: <có/không>; nơi lưu: <đường dẫn>; APP_SECRET đã lưu riêng: <có/không>
- Bất thường/cảnh báo (WARN) cần chủ sở hữu quyết định: <...>
```
