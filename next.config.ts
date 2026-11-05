import type { NextConfig } from "next";

/**
 * CSP cho trang. Next 16 (App Router) chèn script khởi động nội tuyến; dùng nonce theo yêu cầu buộc mọi trang
 * render động và dễ vỡ với `next start`, nên chọn 'unsafe-inline' cho script/style (xem docs/security-checklist.md).
 * Mọi nguồn khác đều bị khóa về 'self'.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

/**
 * Route phát PDF (/api/documents/<id>/file) tự đặt `Content-Security-Policy: default-src 'none'; sandbox`
 * và `X-Content-Type-Options`; loại khỏi các luật dưới đây để mỗi header chỉ xuất hiện một lần.
 * (Chromium có thể để trống trình xem PDF tích hợp khi có `sandbox`: xem mục kiểm tra thủ công trong docs.)
 */
const NOT_PDF_FILE_ROUTE = "/:path((?!api/documents/[^/]+/file$).*)";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg-boss", "pg"],
  async headers() {
    return [
      { source: NOT_PDF_FILE_ROUTE, headers: [...SECURITY_HEADERS, { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY }] },
      {
        // Route PDF: giữ CSP/nosniff riêng của route; chỉ thêm các header không xung đột.
        source: "/api/documents/:id/file",
        headers: SECURITY_HEADERS.filter((h) => h.key !== "X-Content-Type-Options"),
      },
    ];
  },
};

export default nextConfig;
