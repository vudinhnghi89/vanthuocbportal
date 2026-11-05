// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDetail = vi.fn();
vi.mock("@/server/document-detail", () => ({ getDocumentDetail: (id: string) => getDetail(id) }));
const requireUserPage = vi.fn();
vi.mock("@/auth/page-guard", () => ({ requireUserPage: () => requireUserPage() }));
vi.mock("@/components/DocumentDetailView", () => ({ DocumentDetailView: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import DocumentPage from "@/app/(user)/documents/[id]/page";

describe("document detail page", () => {
  beforeEach(() => {
    getDetail.mockReset();
    requireUserPage.mockReset();
    requireUserPage.mockResolvedValue({ user: { role: "admin" } });
  });
  it("calls notFound for unknown ids", async () => {
    getDetail.mockResolvedValue(null);
    await expect(DocumentPage({ params: Promise.resolve({ id: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("passes isAdmin from the session", async () => {
    getDetail.mockResolvedValue({ id: "x" });
    const el = (await DocumentPage({ params: Promise.resolve({ id: "x" }) })) as { props: { isAdmin: boolean } };
    expect(el.props.isAdmin).toBe(true);
    requireUserPage.mockResolvedValue({ user: { role: "user" } });
    const el2 = (await DocumentPage({ params: Promise.resolve({ id: "x" }) })) as { props: { isAdmin: boolean } };
    expect(el2.props.isAdmin).toBe(false);
  });
});
