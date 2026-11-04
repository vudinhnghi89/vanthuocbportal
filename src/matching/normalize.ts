// Thuần (không import DB/server): dùng được ở client component và worker.

const COMBINING_MARKS = /[̀-ͯ]/g;
// zero-width (U+200B–U+200D), word joiner, BOM, soft hyphen
const INVISIBLE = /[​-‍⁠﻿­]/g;
const NON_ALNUM_RUN = /[^\p{L}\p{N}]+/gu;

/**
 * Chuẩn hóa để so khớp: hạ chữ thường, bỏ dấu tiếng Việt (đ -> d), bỏ ký tự vô hình,
 * mọi chuỗi ký tự không phải chữ/số (dấu câu, khoảng trắng Unicode...) -> một dấu cách.
 * Cùng kết quả cho NFC và NFD.
 */
export function normalize(s: string): string {
  return s
    .replace(INVISIBLE, "")
    .toLowerCase() // trước NFD để "İ" -> "i̇" -> "i"
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/đ/g, "d")
    .replace(NON_ALNUM_RUN, " ")
    .trim();
}

export type Alias = { alias: string; canonicalIssuer: string };

/** Tên cơ quan chuẩn (đã chuẩn hóa). Một bước, không nối chuỗi; trùng thì lấy bí danh đứng trước. */
export function canonicalIssuer(s: string, aliases: Alias[]): string {
  const n = normalize(s);
  for (const a of aliases) {
    if (normalize(a.alias) === n) return normalize(a.canonicalIssuer);
  }
  return n;
}
