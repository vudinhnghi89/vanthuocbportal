import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const INFO = "van-thu-portal/integration-secrets/v1";
const MIN_SECRET_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

/** Khóa AES-256 dẫn xuất từ APP_SECRET bằng HKDF-SHA256; ném lỗi rõ ràng nếu thiếu/ngắn. */
function getKey(): Buffer {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < MIN_SECRET_LEN) {
    throw new Error(`APP_SECRET phải được đặt và dài tối thiểu ${MIN_SECRET_LEN} ký tự`);
  }
  return Buffer.from(hkdfSync("sha256", secret, "", INFO, 32));
}

/** AES-256-GCM; định dạng `v1:<iv b64>:<tag b64>:<ciphertext b64>`, IV ngẫu nhiên 12 byte mỗi lần. */
export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(enc: string): string {
  const key = getKey();
  const parts = typeof enc === "string" ? enc.split(":") : [];
  if (parts.length !== 4) throw new Error("Dữ liệu mã hóa không hợp lệ");
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) throw new Error("Phiên bản mã hóa không được hỗ trợ (unsupported version)");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new Error("Dữ liệu mã hóa không hợp lệ");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
