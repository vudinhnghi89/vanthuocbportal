import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const SECRET = "s".repeat(40);
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.APP_SECRET;
  process.env.APP_SECRET = SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = saved;
});

describe("crypto", () => {
  it("round-trips", () => {
    expect(decryptSecret(encryptSecret("app-abcdef123456"))).toBe("app-abcdef123456");
    expect(decryptSecret(encryptSecret(""))).toBe("");
    expect(decryptSecret(encryptSecret("Khóa tiếng Việt ✓"))).toBe("Khóa tiếng Việt ✓");
  });

  it("uses format v1 and never contains plaintext", () => {
    const enc = encryptSecret("app-abcdef123456");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc.split(":")).toHaveLength(4);
    expect(enc).not.toContain("app-abcdef123456");
  });

  it("gives different ciphertext each time", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects tampering of ciphertext, tag and iv", () => {
    const [v, iv, tag, ct] = encryptSecret("app-abcdef123456").split(":");
    const flip = (b64: string) => {
      const b = Buffer.from(b64, "base64");
      b[0] ^= 1;
      return b.toString("base64");
    };
    expect(() => decryptSecret([v, iv, tag, flip(ct)].join(":"))).toThrow();
    expect(() => decryptSecret([v, iv, flip(tag), ct].join(":"))).toThrow();
    expect(() => decryptSecret([v, flip(iv), tag, ct].join(":"))).toThrow();
  });

  it("rejects unknown versions and malformed input", () => {
    const [, iv, tag, ct] = encryptSecret("x").split(":");
    expect(() => decryptSecret(["v2", iv, tag, ct].join(":"))).toThrow(/version|phiên bản/i);
    expect(() => decryptSecret("garbage")).toThrow();
  });

  it("fails to decrypt with a different APP_SECRET", () => {
    const enc = encryptSecret("x");
    process.env.APP_SECRET = "t".repeat(40);
    expect(() => decryptSecret(enc)).toThrow();
  });

  it("requires APP_SECRET of at least 32 chars", () => {
    process.env.APP_SECRET = "short";
    expect(() => encryptSecret("x")).toThrow(/APP_SECRET/);
    delete process.env.APP_SECRET;
    expect(() => encryptSecret("x")).toThrow(/APP_SECRET/);
    expect(() => decryptSecret("v1:a:b:c")).toThrow(/APP_SECRET/);
  });
});
