# Sao lưu và phục hồi

Tài liệu cho quản trị viên hệ thống. Script nằm trong `scripts/`: `backup.sh` (sao lưu), `restore.sh` (phục hồi), `lib-backup.sh` (hàm dùng chung, không chạy trực tiếp).

## 1. Được sao lưu gì, không gì

| Có trong bản sao lưu | Ghi chú |
| --- | --- |
| `db.dump` | Toàn bộ database ứng dụng (`pg_dump -Fc --no-owner`), gồm người dùng (mật khẩu đã băm argon2), đơn vị, rule, văn bản, lịch sử sự kiện, cấu hình tích hợp (API key Dify **đã mã hóa**) và schema `pgboss` (hàng đợi job). |
| `data.tar.gz` | Volume `/data` (`appdata`): `pdf/` (PDF tải lên) và `md/` (kết quả OCR). |
| `SHA256SUMS` | Checksum của ba file còn lại; `restore.sh` kiểm tra trước khi làm gì khác. |
| `MANIFEST` | Văn bản UTF-8: thời điểm tạo (UTC), git commit, số dòng `users/units/rules/documents/document_events`, kích thước file, phiên bản công cụ. |

**Không** có trong bản sao lưu (cố ý):

- `.env`, `APP_SECRET`, `AUTH_SECRET`, `ADMIN_PASSWORD`, `POSTGRES_PASSWORD`. Tách bí mật khỏi dữ liệu để kẻ lấy được bản sao lưu không giải mã được API key đã lưu.
- Volume của Caddy (`caddy_data`, `caddy_config`): chứa chứng chỉ TLS, tự cấp lại được.
- Ảnh Docker và mã nguồn (lấy từ git).

**Hãy lưu `.env` (đặc biệt `APP_SECRET`) riêng**, ví dụ trong trình quản lý mật khẩu hoặc két bí mật của cơ quan. Mất `APP_SECRET` thì các API key Dify trong database không giải mã được; hệ thống vẫn chạy, chỉ cần nhập lại key ở Quản trị > Tích hợp. `AUTH_SECRET` chỉ ảnh hưởng phiên đăng nhập hiện tại (mọi người phải đăng nhập lại).

## 2. Chạy thủ công

Mặc định script chạy ở chế độ `compose`: dùng `docker compose exec -T` vào dịch vụ `postgres` (`pg_dump`) và `web` (`tar` thư mục `/data`). Thông tin đăng nhập database do chính container đọc từ biến môi trường của nó, không xuất hiện trên dòng lệnh hay trong log của máy chủ.

```bash
cd /opt/vanthu                      # thư mục chứa docker-compose.yml
BACKUP_DIR=/mnt/backup/vtp scripts/backup.sh            # giữ 14 bản mới nhất
BACKUP_DIR=/mnt/backup/vtp scripts/backup.sh --keep 30  # giữ 30 bản
scripts/backup.sh --dir /mnt/backup/vtp --no-data       # chỉ database
```

Biến môi trường và tùy chọn:

| Tên | Ý nghĩa |
| --- | --- |
| `BACKUP_MODE` | `compose` (mặc định) hoặc `direct` (Postgres ngoài Docker: dùng `pg_dump` cục bộ với `DATABASE_URL` và nén thư mục `DATA_DIR`). |
| `BACKUP_DIR` / `--dir` | Nơi lưu (mặc định `./backups`). Đặt rỗng, `/`, thư mục hệ thống hoặc đường dẫn có `..` đều bị từ chối. |
| `COMPOSE_FILE`, `COMPOSE_PROJECT_DIR` | Chọn project compose khi chạy từ thư mục khác. |
| `--keep N` | Giữ N bản mới nhất (mặc định 14). |
| `--no-data` | Bỏ qua `/data`. |

Mỗi lần chạy tạo thư mục `vtp-YYYYmmdd-HHMMSS/` (quyền 0700, file 0600). Script ghi vào `*.partial` rồi đổi tên khi xong; nếu lỗi giữa chừng thì xóa phần dở và thoát với mã khác 0. Cuối cùng script tự kiểm tra: `pg_restore --list`, `tar -tzf`, đối chiếu checksum. Dòng cuối trên stdout là `BACKUP_PATH=<thư mục>`.

**Mã thoát:** `0` thành công; `1` lỗi (đã dọn phần dở); `2` sai cách dùng hoặc đường dẫn không an toàn; `3` bản sao lưu không qua bước tự kiểm tra; `4` sao lưu xong nhưng không xóa được bản cũ.

**Lưu giữ (retention):** sau khi sao lưu thành công, script chỉ xóa các thư mục thật (không phải symlink) có tên `vtp-YYYYmmdd-HHMMSS` **và** chứa `MANIFEST` hợp lệ, từ bản thứ N+1 trở đi. Thư mục lạ, symlink, file khác không bao giờ bị đụng đến. Thư mục `.partial` mồ côi (do máy mất điện giữa chừng) không bị xóa tự động; hãy xóa tay sau khi chắc chắn không có lần sao lưu nào đang chạy.

Lưu ý nhất quán: số dòng trong `MANIFEST`, `db.dump` và `data.tar.gz` được lấy lần lượt chứ không cùng một thời điểm. Nên chạy lúc ít người dùng (đêm). Nếu một PDF được tải lên đúng lúc đó, bộ điều hòa (reconciler) của worker sẽ xử lý văn bản thiếu file/job sau khi phục hồi.

## 3. Chạy hằng ngày (cron)

Mỗi ngày lúc 02:30, `flock` chống chạy chồng, ghi log, `BACKUP_DIR` trên ổ đĩa khác:

```cron
# crontab -e (người dùng có quyền chạy docker; log và lock đặt ở nơi người dùng đó ghi được)
30 2 * * * cd /opt/vanthu && flock -n "$HOME/.vtp-backup.lock" env BACKUP_DIR=/mnt/backup/vtp scripts/backup.sh --keep 14 >> "$HOME/vtp-backup.log" 2>&1
```

`flock -n` bỏ qua lượt chạy nếu lượt trước chưa xong. Nhớ xoay vòng log (`logrotate`) và theo dõi mã thoát/dòng `ERROR` trong `$HOME/vtp-backup.log`. Muốn ghi vào `/var/log` hoặc `/var/lock`, hãy đặt dòng cron trong crontab của root (`sudo crontab -e`) hoặc cấp quyền ghi cho người dùng đó (hoặc cho cron gửi mail).

Thay thế bằng systemd timer:

```ini
# /etc/systemd/system/vtp-backup.service
[Service]
Type=oneshot
WorkingDirectory=/opt/vanthu
Environment=BACKUP_DIR=/mnt/backup/vtp
ExecStart=/usr/bin/flock -n /var/lock/vtp-backup.lock /opt/vanthu/scripts/backup.sh --keep 14

# /etc/systemd/system/vtp-backup.timer
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
[Install]
WantedBy=timers.target
```

Bật bằng `systemctl enable --now vtp-backup.timer`; xem kết quả bằng `journalctl -u vtp-backup.service`.

## 4. Chép ra ngoài máy chủ

Bản sao lưu cùng ổ đĩa với hệ thống không chống được hỏng đĩa. Chép sang máy khác (nên dùng khóa SSH riêng, chỉ có quyền ghi vào thư mục đích):

```bash
rsync -a --delete-after --chmod=Du=rwx,Fu=rw /mnt/backup/vtp/ backup@kho-luu-tru:/srv/vtp-backup/
```

Bản sao lưu chứa nội dung văn bản và mật khẩu đã băm, nên **mã hóa trước khi chép ra ngoài cơ quan** (không bắt buộc nếu kho lưu trữ nội bộ đã được bảo vệ). Ví dụ với `age`:

```bash
age -r age1...khoa_cong_khai... -o vtp-20261105-023000.tar.age <(tar -C /mnt/backup/vtp -cf - vtp-20261105-023000)
# giải mã:  age -d -i khoa_rieng.txt vtp-20261105-023000.tar.age | tar -xf -
```

hoặc với `gpg`: `tar -C /mnt/backup/vtp -cf - vtp-20261105-023000 | gpg --encrypt -r admin@co-quan.vn > vtp-20261105-023000.tar.gpg`. Giữ khóa riêng tách khỏi bản sao lưu (cùng nơi với `APP_SECRET`).

## 5. Dung lượng

- Database nhỏ (vài chục MB sau nhiều năm; dump nén).
- `/data` tăng theo số PDF: ước lượng `số văn bản/ngày × dung lượng PDF trung bình × số ngày` (ví dụ 200 văn bản/ngày × 1 MB × 250 ngày ≈ 50 GB/năm). PDF đã nén sẵn nên `gzip` giảm rất ít.
- Mỗi bản sao lưu là một bản đầy đủ; với `--keep 14` cần xấp xỉ `14 × (dung lượng /data + dump)` trên ổ `BACKUP_DIR`. Khi `/data` lớn, giảm `--keep` ở nơi lưu cục bộ và giữ lịch sử dài hơn ở kho ngoài, hoặc bàn thêm giải pháp sao lưu gia tăng (nằm ngoài phạm vi script này).
- Kiểm tra: `df -h /mnt/backup` và `du -sh /mnt/backup/vtp/*`.

## 6. Phục hồi trên máy chủ mới (từng bước)

Thứ tự bắt buộc: **cơ sở dữ liệu, rồi dữ liệu, rồi mới khởi động dịch vụ ứng dụng.**

1. Cài Docker, lấy mã nguồn đúng phiên bản (xem `git_commit` trong `MANIFEST`), tạo `.env` từ bản đã lưu riêng, **giữ nguyên `APP_SECRET` cũ** (và `POSTGRES_PASSWORD` cũ, URL-safe: `DATABASE_URL` được Compose tự ghép từ đó).
2. Chép thư mục sao lưu về (giải mã nếu đã mã hóa), ví dụ `/mnt/backup/vtp/vtp-20261105-023000`.
3. Chỉ khởi động Postgres và `web` (cần container `web` để ghi vào volume `/data`), không khởi động `worker`:
   ```bash
   docker compose up -d postgres web
   ```
   Trên máy mới database còn trống nên `web` chưa có gì để phục vụ. Script chỉ cảnh báo (không tự dừng dịch vụ) nếu thấy `web`/`worker` đang chạy; khi phục hồi đè lên hệ thống đang chạy, hãy chạy `docker compose stop web worker` trước rồi `docker compose start web`.
4. Xem trước kế hoạch (không thay đổi gì):
   ```bash
   scripts/restore.sh /mnt/backup/vtp/vtp-20261105-023000
   ```
5. Thực hiện:
   ```bash
   scripts/restore.sh /mnt/backup/vtp/vtp-20261105-023000 --yes
   ```
   Script kiểm tra `SHA256SUMS`, đọc thử `db.dump`, kiểm tra `data.tar.gz` (từ chối đường dẫn tuyệt đối, `..`, symlink/hardlink), rồi phục hồi database trong một transaction (`pg_restore --clean --if-exists --no-owner`) và giải nén dữ liệu vào `/data` mà không xóa file khác (thêm `--wipe-data` để làm sạch `/data` trước).
   - Database đích đã có người dùng thì script **từ chối** (mã 4); chỉ thêm `--force` khi chắc chắn muốn ghi đè.
   - Schema `pgboss` được xóa và dựng lại từ bản sao lưu. Việc xóa và toàn bộ phục hồi database nằm trong **một giao dịch**: nếu lỗi, database đích giữ nguyên như trước và script in thông báo tiếng Việt nêu rõ tình trạng. Chỉ bước giải nén `/data` nằm ngoài giao dịch (nếu lỗi ở bước này, database đã được phục hồi và script báo rõ).
   - Phục hồi đè (`--force`) bản sao lưu cũ lên database có schema **mới hơn** (đã chạy thêm migration) sẽ để lại các bảng/cột thừa không có trong bản sao lưu; hãy chạy lại migration (`npm run db:migrate` hoặc khởi động lại `web`) và ưu tiên phục hồi vào database trống.
   - File dữ liệu được giải nén với quyền theo `umask` của tiến trình (mặc định 0644 / thư mục 0755, script đặt `umask 022`). Muốn chặt hơn, đổi quyền thư mục `/data` sau khi phục hồi (người dùng chạy `web`/`worker` phải đọc/ghi được).
6. Khởi động toàn bộ: `docker compose up -d`.
7. Kiểm tra:
   - `curl -fs http://127.0.0.1:8080/api/health` (hoặc địa chỉ công khai) trả về OK.
   - Đăng nhập, mở danh sách văn bản, so số lượng với `MANIFEST`; mở thử vài văn bản cũ để chắc PDF hiển thị.
   - Quản trị > Tích hợp: nếu `APP_SECRET` khác bản gốc, nhập lại API key Dify.
   - Hàng đợi pg-boss được phục hồi nguyên trạng; reconciler của worker sẽ xếp lại và quét các văn bản đang kẹt, không cần thao tác tay. Theo dõi vài phút.

Chế độ `direct` (Postgres ngoài Docker): tạo database trống rồi chạy `BACKUP_MODE=direct RESTORE_DATABASE_URL=postgres://user:pass@host/db DATA_DIR=/var/lib/vtp/data scripts/restore.sh <thư mục> --yes`. Địa chỉ đích luôn phải đưa rõ ràng, script không tự lấy `DATABASE_URL`. Phiên bản `pg_restore` phải không cũ hơn phiên bản `pg_dump` đã tạo bản sao lưu.

## 7. Diễn tập phục hồi định kỳ

Sao lưu chưa từng được phục hồi thử thì chưa đáng tin. Mỗi quý (và sau mỗi thay đổi lớn về hạ tầng):

- [ ] Lấy bản sao lưu mới nhất từ **kho ngoài** (không phải bản trên máy chủ), giải mã nếu cần.
- [ ] Dựng môi trường thử riêng (máy ảo hoặc `docker compose -p vtp-drill`), không trỏ vào Dify/dữ liệu thật nếu không cần.
- [ ] `scripts/restore.sh <thư mục>` (xem kế hoạch), rồi `--yes`; ghi lại thời gian thực hiện.
- [ ] `/api/health` OK; số dòng trong ứng dụng khớp `MANIFEST`; mở được vài PDF và bản Markdown.
- [ ] Đăng nhập bằng tài khoản thật (hash mật khẩu phục hồi đúng); API key Dify giải mã được với `APP_SECRET` đã lưu riêng, hoặc xác nhận quy trình nhập lại.
- [ ] Cron/timer đang chạy: kiểm tra `$HOME/vtp-backup.log`, ngày của bản mới nhất, dung lượng ổ đĩa.
- [ ] Xóa môi trường thử và mọi bản giải mã tạm.

## 8. Bảo mật file sao lưu

- Chứa nội dung văn bản, tên người dùng, hash mật khẩu argon2 và API key Dify đã mã hóa bằng `APP_SECRET`. Coi như dữ liệu mật.
- Thư mục 0700, file 0600, chủ sở hữu là tài khoản chạy script. Không để `BACKUP_DIR` ở nơi web có thể phục vụ.
- Không đưa `.env`/`APP_SECRET` vào cùng nơi lưu với bản sao lưu; mã hóa trước khi gửi ra ngoài (mục 4); hạn chế người có quyền đọc kho sao lưu.
- Khi nghi ngờ bản sao lưu bị lộ: đặt lại mật khẩu mọi người dùng, đổi `APP_SECRET` (rồi nhập lại key Dify) và `AUTH_SECRET`, và thu hồi API key Dify.
- Script không in `DATABASE_URL`, mật khẩu hay `APP_SECRET`, và `MANIFEST` không chứa chúng.
