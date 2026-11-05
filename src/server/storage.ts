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

/**
 * Đường dẫn thật (sau khi giải symlink) nếu nằm trong DATA_DIR (hoặc thư mục con `sub`), ngược lại null.
 * So sánh bằng realpath của cả gốc lẫn đích; đích chưa tồn tại thì dùng realpath của thư mục cha.
 * Gốc không tồn tại -> null. Dùng kết quả này để mở tệp (thu hẹp cửa sổ TOCTOU).
 */
export async function resolveInsideDataDir(filePath: string, sub?: string): Promise<string | null> {
  const lexicalRoot = sub ? path.join(/*turbopackIgnore: true*/ dataDir(), sub) : dataDir();
  const lexicalTarget = path.resolve(filePath);
  if (!lexicalTarget.startsWith(lexicalRoot + path.sep)) return null;
  try {
    const root = await fs.realpath(lexicalRoot);
    let real: string;
    try {
      real = await fs.realpath(lexicalTarget);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
      real = path.join(await fs.realpath(path.dirname(lexicalTarget)), path.basename(lexicalTarget));
    }
    return real.startsWith(root + path.sep) ? real : null;
  } catch {
    return null;
  }
}

/** Đường dẫn có nằm trong DATA_DIR (hoặc thư mục con `sub`) không, sau khi giải symlink. */
export async function isInsideDataDir(filePath: string, sub?: string): Promise<boolean> {
  return (await resolveInsideDataDir(filePath, sub)) !== null;
}

/** Xóa tệp PDF; chỉ chấp nhận đường dẫn trong `${DATA_DIR}/pdf` (kể cả sau symlink). Tệp không tồn tại thì bỏ qua. */
export async function deletePdf(filePath: string): Promise<void> {
  if (!(await isInsideDataDir(filePath, "pdf"))) throw new Error("Đường dẫn nằm ngoài thư mục dữ liệu");
  await fs.rm(path.resolve(filePath), { force: true });
}
