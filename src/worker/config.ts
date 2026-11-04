/**
 * Thời gian tối đa chờ job OCR đang chạy khi tắt worker (SIGTERM/SIGINT).
 * PHẢI nhỏ hơn `stop_grace_period` của service worker trong docker-compose.yml (hiện 45s),
 * nếu không Docker SIGKILL worker trước khi pg-boss kịp đánh dấu job fail để giao lại.
 */
export const SHUTDOWN_TIMEOUT_MS = 30_000;
