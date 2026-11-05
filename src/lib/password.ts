import { hash, verify } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 8;
/** Trần độ dài mật khẩu (tránh băm chuỗi khổng lồ). Áp dụng khi tạo, đặt lại và đăng nhập. */
export const MAX_PASSWORD_LENGTH = 256;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
