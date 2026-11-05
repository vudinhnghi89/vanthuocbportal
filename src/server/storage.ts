import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Thư mục dữ liệu (volume /data khi chạy Docker). Đọc môi trường mỗi lần gọi để test ghi đè được. */
export function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || "./data");
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

/**
 * Lưu markdown OCR vào `${DATA_DIR}/md/<uuid>.md`, ghi nguyên tử như savePdf. Trả về đường dẫn tuyệt đối.
 */
export async function saveMarkdown(text: string): Promise<string> {
  const dir = path.join(dataDir(), "md");
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });
  const id = randomUUID();
  const final = path.join(dir, `${id}.md`);
  const tmp = path.join(dir, `.${id}.tmp`);
  try {
    await fs.writeFile(tmp, text, { mode: 0o640, flag: "wx", encoding: "utf8" });
    await fs.rename(tmp, final);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return final;
}

/** Đường dẫn (sau khi resolve) có nằm trong DATA_DIR (hoặc thư mục con `sub` của nó) không. */
export function isInsideDataDir(filePath: string, sub?: string): boolean {
  const root = sub ? path.join(/*turbopackIgnore: true*/ dataDir(), sub) : dataDir();
  return path.resolve(filePath).startsWith(root + path.sep);
}

/** Xóa tệp PDF; từ chối đường dẫn nằm ngoài DATA_DIR. Tệp không tồn tại thì bỏ qua. */
export async function deletePdf(filePath: string): Promise<void> {
  if (!isInsideDataDir(filePath)) throw new Error("Đường dẫn nằm ngoài thư mục dữ liệu");
  await fs.rm(path.resolve(filePath), { force: true });
}
