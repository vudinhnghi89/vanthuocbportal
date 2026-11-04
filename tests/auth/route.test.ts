import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn(async () => new Response("ok", { status: 200 })));
vi.mock("@/auth/config", () => ({ handlers: { GET: vi.fn(), POST: post } }));

import { POST } from "@/app/api/auth/[...nextauth]/route";
import { resetLoginRateLimit } from "@/auth/rate-limit";
import type { NextRequest } from "next/server";

const req = (path: string, ip = "9.9.9.9") =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "x-forwarded-for": ip } }) as NextRequest;

describe("route POST wrapper", () => {
  beforeEach(() => {
    resetLoginRateLimit();
    post.mockClear();
  });

  it("lần thứ 6 tới callback/credentials -> 429, không gọi handler", async () => {
    for (let i = 0; i < 5; i++) expect((await POST(req("/api/auth/callback/credentials"))).status).toBe(200);
    expect((await POST(req("/api/auth/callback/credentials"))).status).toBe(429);
    expect(post).toHaveBeenCalledTimes(5);
  });

  it("endpoint khác (signout) không bị giới hạn", async () => {
    for (let i = 0; i < 8; i++) expect((await POST(req("/api/auth/signout"))).status).toBe(200);
  });
});
