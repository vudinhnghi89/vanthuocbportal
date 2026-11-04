import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Thư mục dữ liệu (volume /data khi chạy Docker). Đọc môi trường mỗi lần gọi để test ghi đè được. */
export function dataDir(): string {
  return path.resolve(process.env.DATA_DIR || "./data");
}

/**
 * Lưu PDF vào `${DATA_DIR}/pdf/<uuid>.pdf` (tên do máy chủ sinh, không liên quan tên người dùng gửi).
 * Ghi nguyên tử: tệp tạm trong cùng thư mục rồi rename. Trả về đường dẫn tuyệt đối.
 */
export async function savePdf(buffer: Buffer): Promise<string> {
  const dir = path.join(dataDir(), "pdf");
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });
  const id = randomUUID();
  const final = path.join(dir, `${id}.pdf`);
  const tmp = path.join(dir, `.${id}.tmp`);
  try {
    await fs.writeFile(tmp, buffer, { mode: 0o640, flag: "wx" });
    await fs.rename(tmp, final);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return final;
}

/** Xóa tệp PDF; từ chối đường dẫn nằm ngoài DATA_DIR. Tệp không tồn tại thì bỏ qua. */
export async function deletePdf(filePath: string): Promise<void> {
  const root = dataDir();
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(root + path.sep)) throw new Error("Đường dẫn nằm ngoài thư mục dữ liệu");
  await fs.rm(resolved, { force: true });
}
