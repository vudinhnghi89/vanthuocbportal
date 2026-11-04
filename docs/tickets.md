# Danh mục ticket

Mỗi ticket là một GitHub Issue; epic là issue cha, ticket là sub-issue. Chi tiết từng task: `docs/superpowers/plans/2026-11-04-van-thu-portal.md`.

| Epic | Issue | Milestone | Ticket |
|---|---|---|---|
| E0 Nền tảng | #1 | M1 | #9 T-0.1 scaffold, #10 T-0.2 schema DB, #11 T-0.3 auth, #16 T-0.4 CI |
| E1 Admin | #2 | M1 | #12 T-1.1 đơn vị, #13 T-1.2 CRUD rule, #14 T-1.3 audit rule, #15 T-1.4 người dùng |
| E2 Dify | #3 | M2 | #17 T-2.1 client, #18 T-2.2 cấu hình endpoint/key |
| E3 Upload & hàng đợi | #4 | M2 | #23 T-3.1 upload, #19 T-3.2 hàng đợi, #20 T-3.3 state machine |
| E4 Pipeline OCR | #5 | M2 | #21 T-4.1 job OCR, #22 T-4.2 lỗi/retry |
| E5 Tra rule | #6 | M3 | #24 T-5.1 chuẩn hóa, #25 T-5.2 bộ khớp, #26 T-5.3 agent, #27 T-5.4 điều phối |
| E6 Giao diện User | #7 | M4 | #28 T-6.1 kéo thả, #29 T-6.2 danh sách/lọc, #30 T-6.3 đổi trạng thái, #31 T-6.4 SSE, #32 T-6.5 chi tiết/thủ công |
| E7 Chất lượng & triển khai | #8 | M5 | #33 T-7.1 E2E, #34 T-7.2 triển khai, #35 T-7.3 backup, #36 T-7.4 bảo mật |

Thứ tự: E0 → (E1, E2, E3 song song) → E4 → E5 → E6 → E7.
