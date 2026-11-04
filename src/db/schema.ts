import { sql } from "drizzle-orm";
import {
  bigserial, boolean, check, index, integer, jsonb, pgTable, serial, text,
  timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

export const USER_ROLES = ["admin", "user"] as const;
export const DOCUMENT_STATUSES = [
  "queued", "ocr_processing", "rule_checking", "classified", "unit_processing", "done", "failed",
] as const;
export const MATCH_METHODS = ["single", "agent", "none"] as const;
export const RULE_AUDIT_ACTIONS = ["create", "update", "delete", "toggle"] as const;
export const INTEGRATION_KEYS = ["dify_ocr", "dify_agent"] as const;

const inList = (col: string, values: readonly string[]) =>
  sql.raw(`${col} in (${values.map((v) => `'${v}'`).join(", ")})`);

const ts = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: USER_ROLES }).notNull().default("user"),
    active: boolean("active").notNull().default(true),
    createdAt: ts("created_at"),
  },
  () => [check("users_role_check", inList("role", USER_ROLES))],
);

export const units = pgTable(
  "units",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull().unique(),
    isSecretariat: boolean("is_secretariat").notNull().default(false),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    // tối đa một đơn vị Ban thư ký
    uniqueIndex("units_one_secretariat").on(t.isSecretariat).where(sql`${t.isSecretariat}`),
  ],
);

export const rules = pgTable(
  "rules",
  {
    id: serial("id").primaryKey(),
    issuer: text("issuer").notNull(),
    docType: text("doc_type").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    mainUnitId: integer("main_unit_id").notNull().references(() => units.id),
    infoUnitId: integer("info_unit_id").references(() => units.id),
    priority: integer("priority").notNull().default(0),
    active: boolean("active").notNull().default(true),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("rules_issuer_doc_type_idx").on(t.issuer, t.docType)],
);

export const ruleAudit = pgTable(
  "rule_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // không FK: giữ lịch sử kể cả khi rule bị xóa
    ruleId: integer("rule_id").notNull(),
    action: text("action", { enum: RULE_AUDIT_ACTIONS }).notNull(),
    actorId: integer("actor_id").references(() => users.id),
    before: jsonb("before"),
    after: jsonb("after"),
    at: ts("at"),
  },
  (t) => [
    check("rule_audit_action_check", inList("action", RULE_AUDIT_ACTIONS)),
    index("rule_audit_rule_id_idx").on(t.ruleId, t.at),
  ],
);

export const issuerAliases = pgTable("issuer_aliases", {
  id: serial("id").primaryKey(),
  alias: text("alias").notNull().unique(),
  canonicalIssuer: text("canonical_issuer").notNull(),
});

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    filename: text("filename").notNull(),
    pdfPath: text("pdf_path").notNull(),
    mdPath: text("md_path"),
    extracted: jsonb("extracted"),
    status: text("status", { enum: DOCUMENT_STATUSES }).notNull().default("queued"),
    matchedRuleId: integer("matched_rule_id").references(() => rules.id, { onDelete: "set null" }),
    matchMethod: text("match_method", { enum: MATCH_METHODS }),
    mainUnitId: integer("main_unit_id").references(() => units.id),
    infoUnitId: integer("info_unit_id").references(() => units.id),
    needsManual: boolean("needs_manual").notNull().default(false),
    error: text("error"),
    uploadedBy: integer("uploaded_by").references(() => users.id),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    check("documents_status_check", inList("status", DOCUMENT_STATUSES)),
    check(
      "documents_match_method_check",
      sql`${t.matchMethod} is null or ${inList("match_method", MATCH_METHODS)}`,
    ),
    index("documents_status_idx").on(t.status),
    index("documents_created_at_idx").on(t.createdAt),
    index("documents_main_unit_idx").on(t.mainUnitId),
  ],
);

export const documentEvents = pgTable(
  "document_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    fromStatus: text("from_status", { enum: DOCUMENT_STATUSES }),
    toStatus: text("to_status", { enum: DOCUMENT_STATUSES }).notNull(),
    actorId: integer("actor_id").references(() => users.id),
    note: text("note"),
    at: ts("at"),
  },
  (t) => [
    check("document_events_from_check", sql`${t.fromStatus} is null or ${inList("from_status", DOCUMENT_STATUSES)}`),
    check("document_events_to_check", inList("to_status", DOCUMENT_STATUSES)),
    index("document_events_doc_idx").on(t.documentId, t.at),
  ],
);

export const integrationSettings = pgTable(
  "integration_settings",
  {
    key: text("key", { enum: INTEGRATION_KEYS }).primaryKey(),
    baseUrl: text("base_url").notNull().default(""),
    apiKeyEnc: text("api_key_enc"),
    inputVar: text("input_var").notNull().default(""),
    outputVarMd: text("output_var_md").notNull().default(""),
    outputVarJson: text("output_var_json").notNull().default(""),
    timeoutS: integer("timeout_s").notNull().default(120),
    retries: integer("retries").notNull().default(3),
    updatedBy: integer("updated_by").references(() => users.id),
    updatedAt: ts("updated_at"),
  },
  () => [check("integration_settings_key_check", inList("key", INTEGRATION_KEYS))],
);

export const settingsAudit = pgTable(
  "settings_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    key: text("key", { enum: INTEGRATION_KEYS }).notNull(),
    actorId: integer("actor_id").references(() => users.id),
    beforeMasked: jsonb("before_masked"),
    afterMasked: jsonb("after_masked"),
    at: ts("at"),
  },
  () => [check("settings_audit_key_check", inList("key", INTEGRATION_KEYS))],
);
