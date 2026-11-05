const INT4_MAX = 2147483647;

/** `?ruleId=`: chỉ chấp nhận số nguyên dương trong int4 (cột rule_id); sai định dạng/vượt trần -> invalid (không truy vấn). */
export function parseRuleIdParam(raw: string | string[] | undefined): { id?: number; invalid: boolean } {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === "") return { invalid: false };
  if (!/^\d{1,10}$/.test(v)) return { invalid: true };
  const n = Number(v);
  if (n < 1 || n > INT4_MAX) return { invalid: true };
  return { id: n, invalid: false };
}
