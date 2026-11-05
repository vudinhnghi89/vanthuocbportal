import Link from "next/link";
import { getRuleDraftFromDocument } from "@/server/rule-draft";
import { listRules } from "@/server/rules";
import { UUID_RE } from "@/server/document-detail";
import type { RuleDraft } from "@/server/rule-draft";
import { listUnits } from "@/server/units";
import { RulesManager } from "./rules-manager";

export const dynamic = "force-dynamic";

export default async function RulesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; fromDocument?: string | string[] }>;
}) {
  const { q, fromDocument: rawFrom } = await searchParams;
  const fromDocument = Array.isArray(rawFrom) ? rawFrom[0] : rawFrom;
  // Bản nháp từ văn bản: id sai/không tồn tại thì bỏ qua (form trống) kèm thông báo nhỏ.
  let initialDraft: RuleDraft | null = null;
  let draftNotice: string | undefined;
  if (fromDocument) {
    initialDraft = UUID_RE.test(fromDocument) ? await getRuleDraftFromDocument(fromDocument) : null;
    if (!initialDraft) draftNotice = "Không tìm thấy văn bản để tạo rule";
  }
  const [rules, units] = await Promise.all([listRules({ q }), listUnits()]);
  return (
    <section>
      <h1>Quản lý quy tắc</h1>
      <p>
        <Link href="/admin/rules/history">Lịch sử chỉnh sửa</Link>
      </p>
      <RulesManager rules={rules} units={units.filter((u) => u.active)} allUnits={units} q={q ?? ""} initialDraft={initialDraft} draftNotice={draftNotice} />
    </section>
  );
}
