import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";

const authMock = vi.fn();
vi.mock("@/auth/config", () => ({ auth: () => authMock() }));
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db/client", () => ({
  get db() {
    return holder.db;
  },
}));

import { createUser, listUsers, resetPassword, setActive, UserError } from "@/server/users";
import { authorizeCredentials } from "@/auth/authorize";
import { GET, POST } from "@/app/api/admin/users/route";
import { PATCH } from "@/app/api/admin/users/[id]/route";

const mode = dbSuiteMode(process.env);
it.runIf(mode === "fail")("DATABASE_URL bắt buộc trong CI", () => {
  throw new Error("DATABASE_URL chưa đặt trong CI: test DB không thể chạy");
});

const session = (role: "admin" | "user") => ({
  user: { id: 1, username: "u", role, active: true },
  expires: "2099-01-01",
});
const jsonReq = (method: string, body?: unknown) =>
  new Request("http://x/api/admin/users", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(mode !== "run")("users", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    t = await createTestDb();
    holder.db = t.db;
  });
  afterAll(async () => {
    await t?.cleanup();
  });
  beforeEach(async () => {
    authMock.mockReset();
    await t.db.delete(schema.users);
  });

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof UserError) return e.code;
      throw e;
    }
    return null;
  };

  describe("server functions", () => {
    it("createUser rồi listUsers; không có passwordHash", async () => {
      const u = await createUser("  alice  ", "password1", "user", t.db);
      expect(u).toMatchObject({ username: "alice", role: "user", active: true });
      expect(u).not.toHaveProperty("passwordHash");
      const list = await listUsers(t.db);
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toMatch(/passwordHash|password_hash|argon2/);
      const [row] = await t.db.select().from(schema.users);
      expect(row.passwordHash).not.toBe("password1");
    });

    it("tên đăng nhập: độ dài 3–50, trùng (không phân biệt hoa thường) -> duplicate_username", async () => {
      expect(await codeOf(createUser("ab", "password1", "user", t.db))).toBe("invalid_username");
      expect(await codeOf(createUser("  ab  ", "password1", "user", t.db))).toBe("invalid_username");
      expect(await codeOf(createUser("a".repeat(51), "password1", "user", t.db))).toBe("invalid_username");
      await createUser("a".repeat(50), "password1", "user", t.db);
      await createUser("bob", "password1", "user", t.db);
      expect(await codeOf(createUser("bob", "password1", "user", t.db))).toBe("duplicate_username");
      expect(await codeOf(createUser("BOB", "password1", "user", t.db))).toBe("duplicate_username");
    });

    it("mật khẩu ngắn -> invalid_password; vai trò sai -> invalid_role", async () => {
      expect(await codeOf(createUser("carol", "short12", "user", t.db))).toBe("invalid_password");
      expect(await codeOf(createUser("carol", "password1", "root" as never, t.db))).toBe("invalid_role");
      expect(await listUsers(t.db)).toHaveLength(0);
    });

    it("đăng nhập: không phân biệt hoa thường; user bị tắt không đăng nhập được", async () => {
      const u = await createUser("Dave", "password1", "user", t.db);
      expect(await authorizeCredentials("Dave", "password1", t.db)).toMatchObject({ id: u.id });
      expect(await authorizeCredentials("dave", "password1", t.db)).toMatchObject({ id: u.id });
      await setActive(u.id, false, t.db);
      expect(await authorizeCredentials("Dave", "password1", t.db)).toBeNull();
      await setActive(u.id, true, t.db);
      expect(await authorizeCredentials("Dave", "password1", t.db)).not.toBeNull();
    });

    it("setActive: không tồn tại -> not_found", async () => {
      expect(await codeOf(setActive(999999, false, t.db))).toBe("not_found");
    });

    it("không tắt admin hoạt động cuối cùng; có admin thứ hai thì tắt được", async () => {
      const a1 = await createUser("admin1", "password1", "admin", t.db);
      await createUser("user1", "password1", "user", t.db);
      expect(await codeOf(setActive(a1.id, false, t.db))).toBe("last_admin");
      expect((await listUsers(t.db)).find((x) => x.id === a1.id)?.active).toBe(true);
      const a2 = await createUser("admin2", "password1", "admin", t.db);
      expect((await setActive(a1.id, false, t.db)).active).toBe(false);
      expect(await codeOf(setActive(a2.id, false, t.db))).toBe("last_admin");
    });

    it("admin đã tắt không được tính; bật lại user thường không bị chặn", async () => {
      const a1 = await createUser("admin1", "password1", "admin", t.db);
      const a2 = await createUser("admin2", "password1", "admin", t.db);
      await setActive(a1.id, false, t.db);
      expect(await codeOf(setActive(a2.id, false, t.db))).toBe("last_admin");
      expect((await setActive(a1.id, true, t.db)).active).toBe(true);
      expect((await setActive(a1.id, true, t.db)).active).toBe(true);
    });

    it("đồng thời: tắt hai admin duy nhất -> đúng một thành công, còn một admin hoạt động", async () => {
      const a1 = await createUser("admin1", "password1", "admin", t.db);
      const a2 = await createUser("admin2", "password1", "admin", t.db);
      const results = await Promise.allSettled([setActive(a1.id, false, t.db), setActive(a2.id, false, t.db)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      expect((rejected[0].reason as UserError).code).toBe("last_admin");
      const active = (await listUsers(t.db)).filter((x) => x.role === "admin" && x.active);
      expect(active).toHaveLength(1);
    });

    it("resetPassword: mật khẩu cũ hỏng, mới dùng được; ngắn -> invalid_password; không có -> not_found", async () => {
      const u = await createUser("erin", "password1", "user", t.db);
      expect(await codeOf(resetPassword(u.id, "short", t.db))).toBe("invalid_password");
      expect(await authorizeCredentials("erin", "password1", t.db)).not.toBeNull();
      await resetPassword(u.id, "new-password", t.db);
      expect(await authorizeCredentials("erin", "password1", t.db)).toBeNull();
      expect(await authorizeCredentials("erin", "new-password", t.db)).not.toBeNull();
      expect(await codeOf(resetPassword(999999, "new-password", t.db))).toBe("not_found");
    });

    it("user đã có sẵn (chữ hoa, do seed) vẫn đăng nhập được", async () => {
      await t.db.insert(schema.users).values({ username: "Admin", passwordHash: await hashPassword("password1"), role: "admin" });
      expect(await authorizeCredentials("Admin", "password1", t.db)).not.toBeNull();
      expect(await authorizeCredentials("admin", "password1", t.db)).not.toBeNull();
    });
  });

  describe("API", () => {
    it("401 chưa đăng nhập, 403 không phải admin, cho mọi method", async () => {
      for (const s of [null, session("user")]) {
        const want = s ? 403 : 401;
        authMock.mockResolvedValue(s);
        expect((await GET()).status).toBe(want);
        expect((await POST(jsonReq("POST", { username: "xyz", password: "password1", role: "user" }))).status).toBe(want);
        expect((await PATCH(jsonReq("PATCH", { active: false }), ctx("1"))).status).toBe(want);
        expect((await PATCH(jsonReq("PATCH", { password: "password1" }), ctx("1"))).status).toBe(want);
      }
      expect(await listUsers(t.db)).toHaveLength(0);
    });

    it("POST tạo (201), GET liệt kê không lộ passwordHash", async () => {
      authMock.mockResolvedValue(session("admin"));
      const res = await POST(jsonReq("POST", { username: "frank", password: "password1", role: "user" }));
      expect(res.status).toBe(201);
      const created = await res.json();
      expect(created).toMatchObject({ username: "frank", role: "user", active: true });
      expect(JSON.stringify(created)).not.toMatch(/passwordHash|argon2/);
      const list = await GET();
      expect(list.status).toBe(200);
      expect(JSON.stringify(await list.json())).not.toMatch(/passwordHash|password_hash|argon2/);
    });

    it("POST: 400 mật khẩu ngắn/thiếu trường, 409 trùng", async () => {
      authMock.mockResolvedValue(session("admin"));
      const short = await POST(jsonReq("POST", { username: "gina", password: "short", role: "user" }));
      expect(short.status).toBe(400);
      expect((await short.json()).error).toMatch(/8/);
      expect((await POST(jsonReq("POST", { username: "gina", role: "user" }))).status).toBe(400);
      expect((await POST(jsonReq("POST", { username: "gina", password: "password1", role: "x" }))).status).toBe(400);
      expect((await POST(jsonReq("POST", { username: "gina", password: "password1", role: "user" }))).status).toBe(201);
      expect((await POST(jsonReq("POST", { username: "GINA", password: "password1", role: "user" }))).status).toBe(409);
    });

    it("PATCH active: 409 khi tắt admin cuối, 200 khi có admin khác; reset password", async () => {
      authMock.mockResolvedValue(session("admin"));
      const a1 = await createUser("admin1", "password1", "admin", t.db);
      expect((await PATCH(jsonReq("PATCH", { active: false }), ctx(String(a1.id)))).status).toBe(409);
      const a2 = await createUser("admin2", "password1", "admin", t.db);
      const ok = await PATCH(jsonReq("PATCH", { active: false }), ctx(String(a1.id)));
      expect(ok.status).toBe(200);
      expect(JSON.stringify(await ok.json())).not.toMatch(/passwordHash|argon2/);
      expect((await PATCH(jsonReq("PATCH", { password: "short" }), ctx(String(a2.id)))).status).toBe(400);
      expect((await PATCH(jsonReq("PATCH", { password: "brand-new-pass" }), ctx(String(a2.id)))).status).toBe(200);
      expect(await authorizeCredentials("admin2", "brand-new-pass", t.db)).not.toBeNull();
    });

    it("PATCH: id không hợp lệ/quá lớn -> 400; không tồn tại -> 404; body rỗng -> 400", async () => {
      authMock.mockResolvedValue(session("admin"));
      for (const id of ["abc", "0", "-1", "1.5", "2147483648", "99999999999999999999"]) {
        expect((await PATCH(jsonReq("PATCH", { active: false }), ctx(id))).status).toBe(400);
      }
      expect((await PATCH(jsonReq("PATCH", { active: false }), ctx("999999"))).status).toBe(404);
      expect((await PATCH(jsonReq("PATCH", {}), ctx("1"))).status).toBe(400);
      expect((await PATCH(jsonReq("PATCH", { active: "no" }), ctx("1"))).status).toBe(400);
    });
  });

  it("users.passwordHash không bị lộ qua select của listUsers", async () => {
    await createUser("hank", "password1", "user", t.db);
    const [row] = await t.db.select().from(schema.users).where(eq(schema.users.username, "hank"));
    expect(row.passwordHash).toBeTruthy();
    expect(Object.keys((await listUsers(t.db))[0]).sort()).toEqual(["active", "createdAt", "id", "role", "username"]);
  });
});
