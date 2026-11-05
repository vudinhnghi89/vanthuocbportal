// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const listRules = vi.fn();
const listUnits = vi.fn();
const getDraft = vi.fn();
vi.mock("@/server/rules", () => ({ listRules: (...a: unknown[]) => listRules(...a) }));
vi.mock("@/server/units", () => ({ listUnits: () => listUnits() }));
vi.mock("@/server/rule-draft", () => ({ getRuleDraftFromDocument: (id: string) => getDraft(id) }));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/app/admin/rules/rules-manager", () => ({ RulesManager: () => null }));

import RulesPage from "@/app/admin/rules/page";

type El = { props: Record<string, unknown> };
const ID = "11111111-1111-4111-8111-111111111111";
const find = (node: unknown): El | null => {
  const n = node as { type?: unknown; props?: { children?: unknown } };
  if (!n || typeof n !== "object") return null;
  if (n.props && "initialDraft" in (n.props as object)) return n as El;
  const kids = ([] as unknown[]).concat(n.props?.children ?? []);
  for (const k of kids) {
    const r = find(k);
    if (r) return r;
  }
  return null;
};

describe("admin rules page ?fromDocument", () => {
  beforeEach(() => {
    listRules.mockReset().mockResolvedValue([]);
    listUnits.mockReset().mockResolvedValue([{ id: 1, name: "A", active: true }, { id: 2, name: "Off", active: false }]);
    getDraft.mockReset();
  });
  it("loads the draft for a valid uuid", async () => {
    const d = { issuer: "X", documentId: ID };
    getDraft.mockResolvedValue(d);
    const el = find(await RulesPage({ searchParams: Promise.resolve({ fromDocument: ID }) }))!;
    expect(getDraft).toHaveBeenCalledWith(ID);
    expect(el.props.initialDraft).toBe(d);
    expect(el.props.draftNotice).toBeUndefined();
    expect((el.props.units as unknown[]).length).toBe(1);
  });
  it("invalid uuid is ignored with a notice, DB not queried", async () => {
    const el = find(await RulesPage({ searchParams: Promise.resolve({ fromDocument: "../x" }) }))!;
    expect(getDraft).not.toHaveBeenCalled();
    expect(el.props.initialDraft).toBeNull();
    expect(el.props.draftNotice).toBeTruthy();
  });
  it("unknown document is ignored with a notice", async () => {
    getDraft.mockResolvedValue(null);
    const el = find(await RulesPage({ searchParams: Promise.resolve({ fromDocument: ID }) }))!;
    expect(el.props.initialDraft).toBeNull();
    expect(el.props.draftNotice).toBeTruthy();
  });
  it("array param uses first value; absent param means no draft and no notice", async () => {
    getDraft.mockResolvedValue(null);
    await RulesPage({ searchParams: Promise.resolve({ fromDocument: [ID, "x"] as never }) });
    expect(getDraft).toHaveBeenCalledWith(ID);
    const el = find(await RulesPage({ searchParams: Promise.resolve({}) }))!;
    expect(el.props.initialDraft).toBeNull();
    expect(el.props.draftNotice).toBeUndefined();
  });
});
