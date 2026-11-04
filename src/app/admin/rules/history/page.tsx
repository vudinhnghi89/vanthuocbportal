import Link from "next/link";
import { listRuleAudit, type Rule } from "@/server/rules";

export const dynamic = "force-dynamic";

const ACTION_LABEL: Record<string, string> = {
  create: "Tạo",
  update: "Sửa",
  toggle: "Bật/tắt",
  delete: "Xóa",
};
const FIELD_LABEL: Record<string, string> = {
  issuer: "Cơ quan ban hành",
  docType: "Loại văn bản",
  title: "Tiêu đề",
  summary: "Trích yếu",
  mainUnitId: "Đơn vị chính",
  infoUnitId: "Đơn vị nhận để biết",
  priority: "Độ ưu tiên",
  active: "Hoạt động",
};

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "(trống)" : String(v));

/** Danh sách "trường: trước → sau" cho các trường thay đổi (create/delete liệt kê toàn bộ giá trị). */
function diffLines(before: Rule | null, after: Rule | null): string[] {
  return Object.keys(FIELD_LABEL).flatMap((k) => {
    const b = before ? (before as Record<string, unknown>)[k] : undefined;
    const a = after ? (after as Record<string, unknown>)[k] : undefined;
    if (before && after && b === a) return [];
    return [`${FIELD_LABEL[k]}: ${before ? show(b) : "—"} → ${after ? show(a) : "—"}`];
  });
}

export default async function RuleHistoryPage({ searchParams }: { searchParams: Promise<{ ruleId?: string }> }) {
  const { ruleId } = await searchParams;
  const id = ruleId && /^\d+$/.test(ruleId) ? Number(ruleId) : undefined;
  const entries = await listRuleAudit(id);
  return (
    <section>
      <h1>Lịch sử chỉnh sửa quy tắc{id ? ` #${id}` : ""}</h1>
      <p>
        <Link href="/admin/rules">← Quay lại quản lý quy tắc</Link>
      </p>
      {entries.length === 0 ? (
        <p>Chưa có lịch sử.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Thời gian</th>
              <th>Người sửa</th>
              <th>Hành động</th>
              <th>Quy tắc</th>
              <th>Thay đổi</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const snap = e.after ?? e.before;
              return (
                <tr key={e.id}>
                  <td>{e.at.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</td>
                  <td>{e.actorUsername ?? "(không rõ)"}</td>
                  <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td>
                    <Link href={`/admin/rules/history?ruleId=${e.ruleId}`}>#{e.ruleId}</Link>
                    {snap ? ` ${snap.issuer} – ${snap.docType}` : ""}
                  </td>
                  <td>
                    <ul>
                      {diffLines(e.before, e.after).map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
