import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import { documents, rules as rulesTable, units } from "@/db/schema";
import { disambiguate as defaultDisambiguate } from "@/matching/disambiguate";
import { extractFields } from "@/matching/extract";
import { matchRules } from "@/matching/match";
import { loadAliases } from "@/server/aliases";
import type { Rule } from "@/server/rules";
import { DocumentNotFoundError, transition, type DbLike, type Status } from "@/server/status";

export type RuleCheckOutcome = { method: "single" | "agent" | "none"; ruleId: number | null };

export type RuleCheckDeps = {
  disambiguate?: typeof defaultDisambiguate;
  readMarkdown?: (path: string) => Promise<string>;
  db?: DbLike;
};

/** Văn bản không ở trạng thái rule_checking (lỗi của bên gọi). */
export class InvalidStateError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly status: Status,
  ) {
    super(`Văn bản đang ở trạng thái ${status}, không thể tra soát rule`);
    this.name = "InvalidStateError";
  }
}

/** Thiếu đơn vị Ban thư ký: cấu hình sai, phải báo lỗi rõ ràng thay vì định tuyến sai. */
export class SecretariatMissingError extends Error {
  constructor() {
    super("Chưa cấu hình đơn vị Ban thư ký");
    this.name = "SecretariatMissingError";
  }
}

const PAST_RULE_CHECK: readonly Status[] = ["classified", "unit_processing", "done"];
const defaultReadMarkdown = (path: string) => readFile(path, "utf8");

async function loadMarkdown(path: string | null, read: (p: string) => Promise<string>): Promise<string> {
  if (!path) return "";
  try {
    return await read(path);
  } catch {
    return "";
  }
}

/**
 * Bước 3-4 của luồng xử lý: tra rule rồi phân loại. Trả null nếu văn bản đã được xử lý (giao lại job).
 * Không giữ giao dịch/khóa dòng khi gọi agent (HTTP); phần ghi là một giao dịch duy nhất.
 */
export async function runRuleCheck(documentId: string, deps: RuleCheckDeps = {}): Promise<RuleCheckOutcome | null> {
  const db = deps.db ?? defaultDb;
  const disambiguate = deps.disambiguate ?? defaultDisambiguate;
  const readMarkdown = deps.readMarkdown ?? defaultReadMarkdown;

  // Giai đoạn đọc (không khóa).
  const [document] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!document) throw new DocumentNotFoundError(documentId);
  if (PAST_RULE_CHECK.includes(document.status)) return null;
  if (document.status !== "rule_checking") throw new InvalidStateError(documentId, document.status);

  const activeRules: Rule[] = await db.select().from(rulesTable).where(eq(rulesTable.active, true));
  const aliases = await loadAliases(db as never);
  const [secretariat] = await db.select({ id: units.id }).from(units).where(eq(units.isSecretariat, true));
  if (!secretariat) throw new SecretariatMissingError();
  const markdown = await loadMarkdown(document.mdPath, readMarkdown);
  const extracted = extractFields(document.extracted);

  // Quyết định.
  const candidates = matchRules(extracted, activeRules, aliases);
  let rule: Rule | null = null;
  let method: RuleCheckOutcome["method"] = "none";
  if (candidates.length === 1) {
    rule = candidates[0];
    method = "single";
  } else if (candidates.length > 1) {
    rule = await disambiguate(markdown, candidates);
    method = rule ? "agent" : "none";
  }

  // Giai đoạn ghi: một giao dịch.
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: documents.status })
      .from(documents)
      .where(eq(documents.id, documentId))
      .for("update");
    if (!locked) throw new DocumentNotFoundError(documentId);
    if (locked.status !== "rule_checking") return null;

    const patch = rule
      ? { matchedRuleId: rule.id, matchMethod: method, mainUnitId: rule.mainUnitId, infoUnitId: rule.infoUnitId, needsManual: false }
      : { matchedRuleId: null, matchMethod: "none" as const, mainUnitId: null, infoUnitId: secretariat.id, needsManual: true };
    await tx
      .update(documents)
      .set({ ...patch, updatedAt: sql`clock_timestamp()` as never })
      .where(and(eq(documents.id, documentId), eq(documents.status, "rule_checking")));

    const note = rule ? `Khớp rule #${rule.id} (${method})` : "Không khớp rule nào, chuyển Ban thư ký";
    await transition(documentId, "classified", { note }, tx as unknown as DbLike);
    return { method, ruleId: rule ? rule.id : null };
  });
}
