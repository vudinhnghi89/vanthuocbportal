import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { dbSuiteMode } from "../db/require-db";
import { createTestDb } from "../db/test-db";
import { seed } from "@/db/seed";
import * as schema from "@/db/schema";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { hashPassword } from "@/lib/password";
import { PgBoss } from "pg-boss";

const ROOT = path.resolve(__dirname, "../..");
const BACKUP_SH = path.join(ROOT, "scripts/backup.sh");
const RESTORE_SH = path.join(ROOT, "scripts/restore.sh");
const APP_SECRET = "s3cr3t-app-secret-0123456789abcdef-UNIQUE";
const DIFY_KEY = "app-DIFY-KEY-for-backup-test";
const mode = dbSuiteMode(process.env);

type Run = { status: number | null; stdout: string; stderr: string };

function run(script: string, args: string[], env: Record<string, string>, cwd: string, extraPath = ""): Run {
  const r = spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: `${extraPath}${extraPath ? ":" : ""}${process.env.PATH}`, HOME: process.env.HOME ?? "/tmp", ...env } as unknown as NodeJS.ProcessEnv,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function sha256(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p)];
  });
}

const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

it("scripts pass bash -n", () => {
  for (const s of [BACKUP_SH, RESTORE_SH, path.join(ROOT, "scripts/lib-backup.sh")]) {
    const r = spawnSync("bash", ["-n", s], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  }
});

const hasShellcheck = spawnSync("sh", ["-c", "command -v shellcheck"]).status === 0;
it.skipIf(!hasShellcheck)("scripts pass shellcheck", () => {
  const r = spawnSync("shellcheck", ["-x", "-s", "bash", BACKUP_SH, RESTORE_SH, path.join(ROOT, "scripts/lib-backup.sh")], {
    encoding: "utf8",
    cwd: path.join(ROOT, "scripts"),
  });
  expect(r.stdout).toBe("");
  expect(r.status).toBe(0);
});

it.runIf(mode === "fail")("DATABASE_URL bắt buộc trong CI", () => {
  throw new Error("DATABASE_URL chưa đặt trong CI");
});

describe.skipIf(mode !== "run")("backup.sh / restore.sh (direct mode, real database)", () => {
  let tmp: string;
  let src: Awaited<ReturnType<typeof createTestDb>>;
  let srcPool: Pool;
  let admin: Pool;
  const extraDbs: string[] = [];
  let dataDir: string;
  let backups: string;
  let good: string; // path of a valid backup
  const tables = ["users", "units", "rules", "documents", "document_events"] as const;
  const dataFiles: Record<string, Buffer> = {};
  const savedSecret = process.env.APP_SECRET;

  const baseEnv = () => ({ DATABASE_URL: src.url, DATA_DIR: dataDir, BACKUP_MODE: "direct", BACKUP_DIR: backups, APP_SECRET });
  const urlFor = (db: string) => {
    const u = new URL(process.env.DATABASE_URL!);
    u.pathname = `/${db}`;
    return u.toString();
  };
  async function newEmptyDb() {
    const name = `vtp_t_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${name}`);
    extraDbs.push(name);
    return { name, url: urlFor(name) };
  }
  async function count(url: string, table: string) {
    const p = new Pool({ connectionString: url });
    p.on("error", () => {});
    try {
      return Number((await p.query(`select count(*) c from ${table}`)).rows[0].c);
    } finally {
      await p.end();
    }
  }
  async function tableCount(url: string) {
    const p = new Pool({ connectionString: url });
    p.on("error", () => {});
    try {
      return Number((await p.query(`select count(*) c from pg_tables where schemaname in ('public','pgboss')`)).rows[0].c);
    } finally {
      await p.end();
    }
  }
  const mk = (name: string) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  function copyBackup(name: string) {
    const d = path.join(tmp, name);
    fs.cpSync(good, d, { recursive: true });
    return d;
  }
  function rewriteSums(dir: string) {
    const files = ["db.dump", "data.tar.gz", "MANIFEST"].filter((f) => fs.existsSync(path.join(dir, f)));
    fs.writeFileSync(path.join(dir, "SHA256SUMS"), files.map((f) => `${sha256(path.join(dir, f))}  ${f}\n`).join(""));
  }

  beforeAll(async () => {
    process.env.APP_SECRET = APP_SECRET;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vtp-backup-test-"));
    admin = new Pool({ connectionString: process.env.DATABASE_URL });
    admin.on("error", () => {});
    src = await createTestDb();
    srcPool = new Pool({ connectionString: src.url });
    srcPool.on("error", () => {});
    await seed(src.db, { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "s3cret-pass-1" });
    const [u2] = await src.db.insert(schema.users)
      .values({ username: "nguyen.van.a", passwordHash: await hashPassword("mat-khau-dai-123"), role: "user" })
      .returning();
    const units = await src.db.insert(schema.units).values([{ name: "Phòng Hành chính" }, { name: "Phòng Kế hoạch" }]).returning();
    const [rule] = await src.db.insert(schema.rules)
      .values({ issuer: "Bộ Y tế", docType: "Công văn", title: "Quy tắc thử", mainUnitId: units[0].id, infoUnitId: units[1].id })
      .returning();
    const docs = await src.db.insert(schema.documents).values([
      { filename: "Công văn số 12 – Bộ Y tế.pdf", pdfPath: "pdf/a.pdf", status: "done", matchedRuleId: rule.id, uploadedBy: u2.id, extracted: { so: "12/BYT", tieuDe: "Ví dụ ✓" } },
      { filename: "b.pdf", pdfPath: "pdf/b.pdf", status: "queued", uploadedBy: u2.id },
      { filename: "c.pdf", pdfPath: "pdf/c.pdf", status: "failed", error: "lỗi", uploadedBy: u2.id },
    ]).returning();
    await src.db.insert(schema.documentEvents).values(
      docs.map((d) => ({ documentId: d.id, toStatus: d.status, actorId: u2.id, note: "tạo" })),
    );
    await src.db.insert(schema.integrationSettings).values({
      key: "dify_ocr", baseUrl: "https://dify.example", apiKeyEnc: encryptSecret(DIFY_KEY), inputVar: "doc",
    });
    // pg-boss tạo schema `pgboss` thật trong cùng database; thêm một job để chứng minh nó được sao lưu.
    const boss = new PgBoss({ connectionString: src.url, supervise: false, schedule: false });
    boss.on("error", () => {});
    await boss.start();
    await boss.createQueue("ocr");
    await boss.send("ocr", { documentId: docs[1].id });
    await boss.stop({ graceful: true, timeout: 2000 });

    dataDir = mk("data");
    fs.mkdirSync(path.join(dataDir, "pdf"));
    fs.mkdirSync(path.join(dataDir, "md"));
    const files = ["pdf/a.pdf", "pdf/Công văn số 12 – Bộ Y tế (bản gốc).pdf", "md/a.md", "md/Quyết định 5 năm.md"];
    for (const f of files) {
      dataFiles[f] = randomBytes(2048);
      fs.writeFileSync(path.join(dataDir, f), dataFiles[f]);
    }
    backups = path.join(tmp, "backups");
  }, 60_000);

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = savedSecret;
    try {
      for (const n of extraDbs) await admin?.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
      await srcPool?.end();
      await src?.cleanup();
      await admin?.end();
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  describe("backup.sh", () => {
    it("creates a timestamped directory with the expected files, modes and manifest", async () => {
      const r = run(BACKUP_SH, [], baseEnv(), tmp);
      expect(r.stderr).not.toBe("");
      expect(r.status).toBe(0);
      const m = r.stdout.trim().match(/^BACKUP_PATH=(.+)$/);
      expect(m).not.toBeNull();
      good = path.resolve(tmp, m![1]);
      expect(path.basename(good)).toMatch(/^vtp-\d{8}-\d{6}$/);
      expect(path.dirname(good)).toBe(backups);
      expect(fs.readdirSync(good).sort()).toEqual(["MANIFEST", "SHA256SUMS", "data.tar.gz", "db.dump"]);
      expect(modeOf(good)).toBe(0o700);
      for (const f of fs.readdirSync(good)) expect(modeOf(path.join(good, f))).toBe(0o600);
      expect(fs.readdirSync(backups)).toEqual([path.basename(good)]); // no .partial left

      const manifest = fs.readFileSync(path.join(good, "MANIFEST"), "utf8");
      for (const t of tables) {
        expect(manifest).toContain(`rows.${t}=${await count(src.url, t)}`);
      }
      expect(manifest).toMatch(/^created_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
      expect(manifest).toMatch(/^mode=direct$/m);
      expect(manifest).toMatch(/^size.db_dump=\d+$/m);
      expect(manifest).toMatch(/^size.data_tar_gz=\d+$/m);
      expect(manifest).toMatch(/^tool.pg_dump=/m);
      expect(manifest).toMatch(/^git_commit=/m);

      // checksums valid
      const sums = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: good, encoding: "utf8" });
      expect(sums.status).toBe(0);

      // dump contains the pgboss schema
      const list = spawnSync("pg_restore", ["--list", path.join(good, "db.dump")], { encoding: "utf8" });
      expect(list.status).toBe(0);
      expect(list.stdout).toMatch(/SCHEMA - pgboss/);
      expect(list.stdout).toMatch(/TABLE DATA public users/);
    });

    it("stores pdf/ and md/ (including Vietnamese file names) in data.tar.gz", () => {
      const t = spawnSync("tar", ["--quoting-style=literal", "-tzf", path.join(good, "data.tar.gz")], { encoding: "utf8" });
      expect(t.status).toBe(0);
      expect(t.stdout).toContain("pdf/Công văn số 12 – Bộ Y tế (bản gốc).pdf");
      expect(t.stdout).toContain("md/Quyết định 5 năm.md");
    });

    it("never leaks the database URL, passwords or APP_SECRET, and includes no .env", () => {
      const r = run(BACKUP_SH, [], baseEnv(), tmp);
      expect(r.status).toBe(0);
      const extra = path.resolve(tmp, r.stdout.trim().replace("BACKUP_PATH=", ""));
      for (const dir of [good, extra]) {
        for (const f of ["MANIFEST", "SHA256SUMS"]) {
          const txt = fs.readFileSync(path.join(dir, f), "utf8");
          expect(txt).not.toContain(src.url);
          expect(txt).not.toContain("postgres://");
          expect(txt).not.toContain(APP_SECRET);
          expect(txt).not.toMatch(/password/i);
        }
        expect(walk(dir).some((f) => f.includes(".env"))).toBe(false);
        const tarList = spawnSync("tar", ["-tzf", path.join(dir, "data.tar.gz")], { encoding: "utf8" }).stdout;
        expect(tarList).not.toContain(".env");
      }
      for (const out of [r.stdout, r.stderr]) {
        expect(out).not.toContain(src.url);
        expect(out).not.toContain("postgres://");
        expect(out).not.toContain(APP_SECRET);
      }
      fs.rmSync(extra, { recursive: true, force: true });
    }, 30_000);

    it("--no-data skips data.tar.gz", () => {
      const dir = mk("nodata-backups");
      const r = run(BACKUP_SH, ["--no-data", "--dir", dir], { ...baseEnv(), DATA_DIR: "" }, tmp);
      expect(r.status).toBe(0);
      const out = path.resolve(tmp, r.stdout.trim().replace("BACKUP_PATH=", ""));
      expect(fs.readdirSync(out).sort()).toEqual(["MANIFEST", "SHA256SUMS", "db.dump"]);
    });

    it("--keep deletes only old valid backups; foreign dirs and symlinks are untouched", () => {
      const dir = mk("retention");
      const manifest = "vtp-backup-manifest 1\ncreated_at=2020-01-01T00:00:00Z\n";
      for (const n of ["vtp-20200101-000000", "vtp-20200102-000000", "vtp-20200103-000000"]) {
        fs.mkdirSync(path.join(dir, n));
        fs.writeFileSync(path.join(dir, n, "MANIFEST"), manifest);
        fs.writeFileSync(path.join(dir, n, "db.dump"), "x");
      }
      // old-looking names that must NOT be deleted
      fs.mkdirSync(path.join(dir, "vtp-20190101-000000")); // no MANIFEST
      fs.writeFileSync(path.join(dir, "vtp-20190101-000000", "precious.txt"), "keep");
      fs.mkdirSync(path.join(dir, "vtp-20190202-000000")); // MANIFEST with the wrong content
      fs.writeFileSync(path.join(dir, "vtp-20190202-000000", "MANIFEST"), "hello\n");
      fs.mkdirSync(path.join(dir, "notes"));
      fs.writeFileSync(path.join(dir, "notes", "a.txt"), "keep");
      const outside = mk("outside-target");
      fs.writeFileSync(path.join(outside, "MANIFEST"), manifest);
      fs.writeFileSync(path.join(outside, "important.txt"), "keep");
      fs.symlinkSync(outside, path.join(dir, "vtp-20180101-000000"));
      fs.writeFileSync(path.join(dir, "vtp-20170101-000000"), "a plain file");

      const r = run(BACKUP_SH, ["--keep", "2", "--dir", dir], baseEnv(), tmp);
      expect(r.status).toBe(0);
      const left = fs.readdirSync(dir).sort();
      const created = path.basename(r.stdout.trim().replace("BACKUP_PATH=", ""));
      expect(left).toEqual(
        ["notes", "vtp-20170101-000000", "vtp-20180101-000000", "vtp-20190101-000000", "vtp-20190202-000000", "vtp-20200103-000000", created].sort(),
      );
      expect(fs.readFileSync(path.join(dir, "vtp-20190101-000000", "precious.txt"), "utf8")).toBe("keep");
      expect(fs.lstatSync(path.join(dir, "vtp-20180101-000000")).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(outside, "important.txt"), "utf8")).toBe("keep");
      expect(fs.existsSync(path.join(dir, "notes", "a.txt"))).toBe(true);
    });

    it("retention works when BACKUP_DIR is a symlink, and never follows symlinked children", () => {
      const real = mk("ret-real");
      const link = path.join(tmp, "ret-link");
      fs.symlinkSync(real, link);
      const manifest = "vtp-backup-manifest 1\n";
      for (const n of ["vtp-20200101-000000", "vtp-20200102-000000", "vtp-20200103-000000"]) {
        fs.mkdirSync(path.join(real, n));
        fs.writeFileSync(path.join(real, n, "MANIFEST"), manifest);
      }
      const outside = mk("ret-outside");
      fs.writeFileSync(path.join(outside, "MANIFEST"), manifest);
      fs.writeFileSync(path.join(outside, "important.txt"), "keep");
      fs.symlinkSync(outside, path.join(real, "vtp-20100101-000000"));
      const r = run(BACKUP_SH, ["--keep", "2", "--dir", link], baseEnv(), tmp);
      expect(r.status, r.stderr).toBe(0);
      const created = path.basename(r.stdout.trim().replace("BACKUP_PATH=", ""));
      expect(fs.readdirSync(real).sort()).toEqual(["vtp-20100101-000000", "vtp-20200103-000000", created].sort());
      expect(fs.readFileSync(path.join(outside, "important.txt"), "utf8")).toBe("keep");
    });

    it("never deletes the backup it just made, even when newer-named backups exist (clock skew)", () => {
      const dir = mk("ret-skew");
      for (const n of ["vtp-29990101-000000", "vtp-29990102-000000", "vtp-29990103-000000"]) {
        fs.mkdirSync(path.join(dir, n));
        fs.writeFileSync(path.join(dir, n, "MANIFEST"), "vtp-backup-manifest 1\n");
      }
      const r = run(BACKUP_SH, ["--keep", "2", "--dir", dir], baseEnv(), tmp);
      expect(r.status, r.stderr).toBe(0);
      const created = r.stdout.trim().replace("BACKUP_PATH=", "");
      expect(fs.existsSync(path.join(created, "db.dump"))).toBe(true);
      expect(r.stderr).toMatch(/WARNING.*clock/i);
      expect(fs.readdirSync(dir).sort()).toEqual(["vtp-29990103-000000", path.basename(created)].sort());
    });

    it("rejects invalid --keep values", () => {
      for (const k of ["0", "-1", "abc", ""]) {
        const r = run(BACKUP_SH, ["--keep", k, "--dir", path.join(tmp, "k")], baseEnv(), tmp);
        expect(r.status).toBe(2);
      }
      expect(fs.existsSync(path.join(tmp, "k"))).toBe(false);
    });

    it("refuses unsafe backup directories", () => {
      const cwd = mk("unsafe-cwd");
      for (const bad of ["/", "", "../escape", "a/../../b", "/etc", "//", "/."]) {
        const r = run(BACKUP_SH, [], { ...baseEnv(), BACKUP_DIR: bad }, cwd);
        expect(r.status, `BACKUP_DIR=${JSON.stringify(bad)}`).toBe(2);
      }
      const r = run(BACKUP_SH, ["--dir", ""], baseEnv(), cwd);
      expect(r.status).toBe(2);
      expect(fs.readdirSync(cwd)).toEqual([]);
      expect(fs.existsSync(path.join(tmp, "escape"))).toBe(false);
    });

    it("a mid-way failure leaves no .partial and no new directory, and exits non-zero", () => {
      const dir = mk("failing");
      const keepMe = path.join(dir, "vtp-20200101-000000");
      fs.mkdirSync(keepMe);
      fs.writeFileSync(path.join(keepMe, "MANIFEST"), "vtp-backup-manifest 1\n");
      // 1) pg_dump against a database that does not exist
      let r = run(BACKUP_SH, ["--keep", "1", "--dir", dir], { ...baseEnv(), DATABASE_URL: urlFor("vtp_does_not_exist_xyz") }, tmp);
      expect(r.status).not.toBe(0);
      expect(fs.readdirSync(dir)).toEqual(["vtp-20200101-000000"]);
      // 2) database fine but the data directory is missing (fails after db.dump was already written)
      r = run(BACKUP_SH, ["--keep", "1", "--dir", dir], { ...baseEnv(), DATA_DIR: path.join(tmp, "no-such-dir") }, tmp);
      expect(r.status).not.toBe(0);
      expect(fs.readdirSync(dir)).toEqual(["vtp-20200101-000000"]);
    });
  });

  describe("restore.sh", () => {
    const restoreEnv = (url: string, data: string) => ({ RESTORE_DATABASE_URL: url, DATA_DIR: data, BACKUP_MODE: "direct", APP_SECRET });

    it("without --yes prints the plan, exits 2 and changes nothing", async () => {
      const target = await newEmptyDb();
      const data = path.join(tmp, "restore-data-noyes");
      const r = run(RESTORE_SH, [good], restoreEnv(target.url, data), tmp);
      expect(r.status).toBe(2);
      expect(r.stdout + r.stderr).toContain("--yes");
      expect(await tableCount(target.url)).toBe(0);
      expect(fs.existsSync(data)).toBe(false);
    });

    describe("--wipe-data refuses unsafe DATA_DIR (exit 2, Vietnamese message)", () => {
      const wipeRun = (dataDir: string, home: string) =>
        run(RESTORE_SH, [good, "--yes", "--wipe-data"], { ...restoreEnv("postgres://x@localhost/x", dataDir), HOME: home }, tmp);
      const refused = (r: { status: number | null; stdout: string; stderr: string }) => {
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("Từ chối --wipe-data");
      };

      it("DATA_DIR is /", () => refused(wipeRun("/", tmp)));

      it("DATA_DIR is $HOME", () => {
        const home = fs.mkdtempSync(path.join(tmp, "home-"));
        fs.mkdirSync(path.join(home, "pdf"));
        refused(wipeRun(home, home));
        expect(fs.existsSync(path.join(home, "pdf"))).toBe(true);
      });

      it("DATA_DIR is a parent of $HOME (also through a symlink)", () => {
        const parent = fs.mkdtempSync(path.join(tmp, "parent-"));
        const home = path.join(parent, "u");
        fs.mkdirSync(home);
        refused(wipeRun(parent, home));
        const link = path.join(tmp, "link-to-parent");
        fs.symlinkSync(parent, link);
        refused(wipeRun(link, home));
      });

      it("DATA_DIR has anything besides pdf/ and md/ at the top level", () => {
        for (const make of [
          (d: string) => fs.writeFileSync(path.join(d, "keep.txt"), "x"),
          (d: string) => fs.mkdirSync(path.join(d, "other")),
          (d: string) => fs.writeFileSync(path.join(d, "pdf"), "a file named pdf"),
          (d: string) => fs.symlinkSync("/tmp", path.join(d, "md")),
        ]) {
          const d = fs.mkdtempSync(path.join(tmp, "dd-"));
          make(d);
          refused(wipeRun(d, tmp));
        }
      });

      it("a plain pdf/ + md/ (or empty/missing) DATA_DIR passes the wipe guard", () => {
        const ok = fs.mkdtempSync(path.join(tmp, "dd-ok-"));
        fs.mkdirSync(path.join(ok, "pdf"));
        fs.mkdirSync(path.join(ok, "md"));
        for (const d of [ok, path.join(tmp, "dd-missing")]) {
          const r = wipeRun(d, tmp);
          expect(r.stderr).not.toContain("Từ chối --wipe-data");
        }
      });
    });

    it("requires a target and a backup directory", () => {
      expect(run(RESTORE_SH, [], restoreEnv("postgres://x@localhost/x", tmp), tmp).status).toBe(2);
      expect(run(RESTORE_SH, [good, "--yes"], { BACKUP_MODE: "direct", DATA_DIR: tmp }, tmp).status).toBe(2);
      expect(run(RESTORE_SH, [path.join(tmp, "missing"), "--yes"], restoreEnv("postgres://x@localhost/x", tmp), tmp).status).toBe(2);
    });

    it("refuses a tampered backup (checksum mismatch) and changes nothing", async () => {
      const bad = copyBackup("tampered");
      const buf = fs.readFileSync(path.join(bad, "db.dump"));
      buf[Math.floor(buf.length / 2)] ^= 0xff;
      fs.writeFileSync(path.join(bad, "db.dump"), buf);
      const target = await newEmptyDb();
      const data = path.join(tmp, "restore-data-tampered");
      const r = run(RESTORE_SH, [bad, "--yes"], restoreEnv(target.url, data), tmp);
      expect(r.status).toBe(3);
      expect(await tableCount(target.url)).toBe(0);
      expect(fs.existsSync(data)).toBe(false);
    });

    it("refuses a missing SHA256SUMS", async () => {
      const bad = copyBackup("nosums");
      fs.rmSync(path.join(bad, "SHA256SUMS"));
      const target = await newEmptyDb();
      const r = run(RESTORE_SH, [bad, "--yes"], restoreEnv(target.url, path.join(tmp, "rd-nosums")), tmp);
      expect(r.status).toBe(3);
      expect(await tableCount(target.url)).toBe(0);
    });

    it("refuses a populated target without --force, then restores over it with --force", async () => {
      const target = await newEmptyDb();
      const p = new Pool({ connectionString: target.url });
      p.on("error", () => {});
      await p.query("create table users (id int primary key, note text)");
      await p.query("insert into users values (1, 'existing')");
      await p.end();
      const data = path.join(tmp, "restore-data-populated");
      let r = run(RESTORE_SH, [good, "--yes"], restoreEnv(target.url, data), tmp);
      expect(r.status).toBe(4);
      expect(await count(target.url, "users")).toBe(1);
      expect(fs.existsSync(data)).toBe(false);

      r = run(RESTORE_SH, [good, "--yes", "--force"], restoreEnv(target.url, data), tmp);
      expect(r.status, r.stderr).toBe(0);
      expect(await count(target.url, "users")).toBe(await count(src.url, "users"));
    }, 60_000);

    it("restores into an empty database: row counts, contents, encrypted setting, pgboss and data files", async () => {
      const target = await newEmptyDb();
      const data = mk("restore-data-ok");
      fs.mkdirSync(path.join(data, "pdf"), { recursive: true });
      fs.writeFileSync(path.join(data, "pdf", "keep.txt"), "pre-existing");
      const r = run(RESTORE_SH, [good, "--yes"], restoreEnv(target.url, data), tmp);
      expect(r.status, r.stderr).toBe(0);
      for (const out of [r.stdout, r.stderr]) {
        expect(out).not.toContain("postgres://");
        expect(out).not.toContain(APP_SECRET);
      }
      expect(r.stderr).toContain("/api/health");

      for (const t of tables) expect(await count(target.url, t)).toBe(await count(src.url, t));
      const q = async (url: string, sql: string) => {
        const p = new Pool({ connectionString: url });
        p.on("error", () => {});
        try {
          return (await p.query(sql)).rows;
        } finally {
          await p.end();
        }
      };
      for (const sql of [
        "select id, username, password_hash, role, active from users order by id",
        "select id, name, is_secretariat from units order by id",
        "select id, issuer, doc_type, title, main_unit_id, info_unit_id from rules order by id",
        "select id, filename, pdf_path, status, extracted, uploaded_by from documents order by filename",
        "select id, document_id, to_status, note from document_events order by id",
        "select key, base_url, api_key_enc from integration_settings order by key",
        "select name, data from pgboss.job order by created_on",
      ]) {
        expect(await q(target.url, sql), sql).toEqual(await q(src.url, sql));
      }
      const [setting] = await q(target.url, "select api_key_enc from integration_settings where key='dify_ocr'");
      expect(decryptSecret(setting.api_key_enc)).toBe(DIFY_KEY);
      expect((await q(target.url, "select username from users where username like 'nguyen%'"))[0].username).toBe("nguyen.van.a");

      for (const [rel, buf] of Object.entries(dataFiles)) {
        const f = path.join(data, rel);
        expect(fs.readFileSync(f).equals(buf), rel).toBe(true);
        expect(modeOf(f) & 0o022).toBe(0);
      }
      expect(fs.readFileSync(path.join(data, "pdf", "keep.txt"), "utf8")).toBe("pre-existing");

      // --wipe-data removes unrelated files first; --force needed since the target is now populated
      const again = run(RESTORE_SH, [good, "--yes"], restoreEnv(target.url, data), tmp);
      expect(again.status).toBe(4);
      const wipe = run(RESTORE_SH, [good, "--yes", "--force", "--wipe-data"], restoreEnv(target.url, data), tmp);
      expect(wipe.status, wipe.stderr).toBe(0);
      expect(fs.existsSync(path.join(data, "pdf", "keep.txt"))).toBe(false);
      expect(walk(data).sort()).toEqual(Object.keys(dataFiles).sort());
    }, 90_000);

    it("a failing pg_restore rolls back everything (including the pgboss drop) and says so", async () => {
      const target = await newEmptyDb();
      const data = mk("rollback-data");
      const ok = run(RESTORE_SH, [good, "--yes"], restoreEnv(target.url, data), tmp);
      expect(ok.status, ok.stderr).toBe(0);
      const snap = async () => {
        const p = new Pool({ connectionString: target.url });
        p.on("error", () => {});
        try {
          const users = (await p.query("select id, username, password_hash from users order by id")).rows;
          const jobs = Number((await p.query("select count(*) c from pgboss.job")).rows[0].c);
          const docs = Number((await p.query("select count(*) c from documents")).rows[0].c);
          return { users, jobs, docs };
        } finally {
          await p.end();
        }
      };
      const before = await snap();
      const bad = copyBackup("truncated");
      const size = fs.statSync(path.join(bad, "db.dump")).size;
      fs.truncateSync(path.join(bad, "db.dump"), size - 64);
      rewriteSums(bad);
      const r = run(RESTORE_SH, [bad, "--yes", "--force"], restoreEnv(target.url, data), tmp);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Phục hồi thất bại");
      expect(r.stderr).toContain("không bị thay đổi");
      expect(await snap()).toEqual(before);
    }, 60_000);

    it.each([
      ["parent traversal", () => ["../evil", "pdf/ok.pdf"], "evil"],
      ["absolute path", (abs: string) => [abs, "pdf/ok.pdf"], "abs-target/pwned"],
      ["embedded ..", () => ["pdf/../../evil2", "pdf/ok.pdf"], "evil2"],
    ])("rejects a malicious data.tar.gz (%s) and writes nothing", async (_n, entries, probe) => {
      const dir = copyBackup(`evil-${probe.replace(/\W/g, "_")}`);
      const absTarget = path.join(tmp, "abs-target", "pwned");
      const py = [
        "import tarfile,sys,io",
        "out=sys.argv[1]; names=sys.argv[2:]",
        "t=tarfile.open(out,'w:gz')",
        "for n in names:",
        "    d=b'pwned'; i=tarfile.TarInfo(n); i.size=len(d); t.addfile(i,io.BytesIO(d))",
        "t.close()",
      ].join("\n");
      const mkTar = spawnSync("python3", ["-I", "-c", py, path.join(dir, "data.tar.gz"), ...entries(absTarget)], { encoding: "utf8" });
      expect(mkTar.status, mkTar.stderr).toBe(0);
      rewriteSums(dir); // checksums match: only the content check can stop it
      const target = await newEmptyDb();
      const data = mk(`evil-data-${probe.replace(/\W/g, "_")}`);
      const r = run(RESTORE_SH, [dir, "--yes"], restoreEnv(target.url, path.join(data, "inner")), tmp);
      expect(r.status).toBe(5);
      expect(await tableCount(target.url)).toBe(0); // rejected before the database was touched
      expect(fs.existsSync(path.join(data, "evil"))).toBe(false);
      expect(fs.existsSync(path.join(data, "inner"))).toBe(false);
      expect(fs.existsSync(path.join(tmp, "evil"))).toBe(false);
      expect(fs.existsSync(path.join(tmp, "evil2"))).toBe(false);
      expect(fs.existsSync(absTarget)).toBe(false);
    }, 30_000);

    it("rejects symlink and hardlink entries in data.tar.gz", async () => {
      const dir = copyBackup("evil-symlink");
      const py = [
        "import tarfile,sys",
        "t=tarfile.open(sys.argv[1],'w:gz')",
        "i=tarfile.TarInfo('pdf/link'); i.type=tarfile.SYMTYPE; i.linkname='/etc'; t.addfile(i)",
        "t.close()",
      ].join("\n");
      expect(spawnSync("python3", ["-I", "-c", py, path.join(dir, "data.tar.gz")]).status).toBe(0);
      rewriteSums(dir);
      const target = await newEmptyDb();
      const r = run(RESTORE_SH, [dir, "--yes"], restoreEnv(target.url, path.join(tmp, "evil-link-data")), tmp);
      expect(r.status).toBe(5);
      expect(await tableCount(target.url)).toBe(0);
      expect(fs.existsSync(path.join(tmp, "evil-link-data"))).toBe(false);
    });
  });

  describe("compose mode (stubbed docker)", () => {
    let bin: string;
    let log: string;
    let stubData: string;

    const stubEnv = (extra: Record<string, string> = {}) => ({
      BACKUP_MODE: "compose",
      COMPOSE_FILE: "/srv/vtp/docker-compose.yml",
      COMPOSE_PROJECT_DIR: "/srv/vtp",
      STUB_LOG: log,
      STUB_DATA: stubData,
      // These must never reach docker arguments:
      DATABASE_URL: "postgres://vanthu:hunter2-SECRET@postgres:5432/vanthu",
      POSTGRES_PASSWORD: "hunter2-SECRET",
      APP_SECRET,
      ...extra,
    });
    const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("|").slice(1));

    beforeAll(() => {
      bin = mk("stub-bin");
      log = path.join(tmp, "docker.log");
      stubData = mk("stub-data");
      fs.writeFileSync(path.join(stubData, "x.txt"), "x");
      const stub = `#!/usr/bin/env bash
{ printf 'ARGS'; for a in "$@"; do printf '|%s' "$a"; done; printf '\\n'; } >> "$STUB_LOG"
joined="$*"
case "$joined" in
  *"compose version"*) echo "Docker Compose version v2.29.0-stub"; exit 0;;
  *" ps "*) printf 'web\\nworker\\npostgres\\n'; exit 0;;
  *"exec -T postgres"*"pg_dump --version"*) echo "pg_dump (PostgreSQL) 16.0-stub"; exit 0;;
  *"exec -T postgres"*"pg_dump"*) printf 'PGDMP-stub-dump-bytes'; exit 0;;
  *"exec -T postgres"*"pg_restore --list"*) cat >/dev/null; exit 0;;
  *"exec -T postgres"*"pg_restore"*) cat >/dev/null; exit 0;;
  *"exec -T postgres"*"psql"*)
    sql="$(cat)"
    case "$sql" in
      *to_regclass*) echo "\${STUB_USERS_EXIST:-f}";;
      "select count(*) from public.users;"*) echo "\${STUB_USERS_COUNT:-0}";;
      *) echo "3|1|2|4|5";;
    esac
    exit 0;;
  *"exec -T web tar"*"-czf -"*) tar -C "$STUB_DATA" -czf - .; exit 0;;
  *"exec -T web tar"*"-xzof -"*) cat >/dev/null; exit 0;;
  *"exec -T web"*) cat >/dev/null 2>&1 || true; exit 0;;
esac
echo "stub docker: unexpected call: $joined" >&2
exit 99
`;
      fs.writeFileSync(path.join(bin, "docker"), stub, { mode: 0o755 });
    });

    it("backup uses docker compose exec -T with credentials from the container, none on the command line", () => {
      fs.writeFileSync(log, "");
      const dir = mk("compose-backups");
      const r = run(BACKUP_SH, ["--dir", dir], stubEnv(), tmp, bin);
      expect(r.status, r.stderr).toBe(0);
      const all = calls();
      const base = ["compose", "-f", "/srv/vtp/docker-compose.yml", "--project-directory", "/srv/vtp", "exec", "-T"];
      const dump = all.find((c) => c.join(" ").includes("pg_dump -U") || (c.includes("postgres") && c.join(" ").includes("pg_dump") && !c.join(" ").includes("--version")));
      expect(dump).toBeDefined();
      expect(dump!.slice(0, base.length)).toEqual(base);
      expect(dump!.slice(base.length, base.length + 3)).toEqual(["postgres", "sh", "-c"]);
      const script = dump![base.length + 3];
      expect(script).toContain('PGPASSWORD="$POSTGRES_PASSWORD"');
      expect(script).toMatch(/pg_dump .*-Fc .*--no-owner/);
      expect(script).toContain('-U "$POSTGRES_USER"');
      expect(script).toContain('-d "$POSTGRES_DB"');
      const tarCall = all.find((c) => c.includes("web"));
      expect(tarCall).toEqual([...base, "web", "tar", "-C", "/data", "-czf", "-", "."]);
      const raw = fs.readFileSync(log, "utf8");
      expect(raw).not.toContain("hunter2-SECRET");
      expect(raw).not.toContain(APP_SECRET);
      expect(raw).not.toContain("postgres://");
      const out = path.resolve(tmp, r.stdout.trim().replace("BACKUP_PATH=", ""));
      expect(fs.readFileSync(path.join(out, "db.dump"), "utf8")).toBe("PGDMP-stub-dump-bytes");
      expect(fs.readFileSync(path.join(out, "MANIFEST"), "utf8")).toMatch(/^mode=compose$/m);
      expect(fs.readFileSync(path.join(out, "MANIFEST"), "utf8")).toContain("rows.users=3");
      expect(spawnSync("tar", ["-tzf", path.join(out, "data.tar.gz")]).status).toBe(0);
      expect(spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: out }).status).toBe(0);
      expect(r.stdout + r.stderr).not.toContain("hunter2-SECRET");
    });

    it("compose backup fails cleanly when docker fails", () => {
      const dir = mk("compose-fail");
      const failBin = mk("fail-bin");
      fs.writeFileSync(path.join(failBin, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const r = run(BACKUP_SH, ["--dir", dir], stubEnv(), tmp, failBin);
      expect(r.status).not.toBe(0);
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("restore pipes db.dump to pg_restore in the postgres container and data to the web container", () => {
      const out = mk("compose-restore-src");
      const b = run(BACKUP_SH, ["--dir", out], stubEnv(), tmp, bin);
      expect(b.status).toBe(0);
      const made = path.resolve(tmp, b.stdout.trim().replace("BACKUP_PATH=", ""));
      fs.writeFileSync(log, "");
      const r = run(RESTORE_SH, [made, "--yes"], stubEnv(), tmp, bin);
      expect(r.status, r.stderr).toBe(0);
      const all = calls();
      const base = ["compose", "-f", "/srv/vtp/docker-compose.yml", "--project-directory", "/srv/vtp", "exec", "-T"];
      const restore = all.find((c) => c.join(" ").includes("pg_restore") && !c.join(" ").includes("--list"));
      expect(restore).toBeDefined();
      expect(restore!.slice(0, base.length + 3)).toEqual([...base, "postgres", "sh", "-c"]);
      // pg_restore only converts the archive to SQL (no connection); psql applies it in one transaction.
      const apply = all.filter((c) => c.join(" ").includes("psql")).pop();
      expect(apply![base.length + 3]).toContain('PGPASSWORD="$POSTGRES_PASSWORD"');
      expect(restore![base.length + 3]).toMatch(/--clean --if-exists --no-owner/);
      expect(restore![base.length + 3]).not.toMatch(/ -d /);
      expect(all).toContainEqual([...base, "web", "tar", "-C", "/data", "-xzof", "-"]);
      expect(fs.readFileSync(log, "utf8")).not.toContain("hunter2-SECRET");
      expect(r.stderr).toMatch(/WARNING: web and\/or worker are running/); // warns that web/worker are running
    });

    it("compose restore refuses a populated database without --force", () => {
      const out = mk("compose-restore-src2");
      const b = run(BACKUP_SH, ["--dir", out], stubEnv(), tmp, bin);
      const made = path.resolve(tmp, b.stdout.trim().replace("BACKUP_PATH=", ""));
      fs.writeFileSync(log, "");
      const r = run(RESTORE_SH, [made, "--yes"], stubEnv({ STUB_USERS_EXIST: "t", STUB_USERS_COUNT: "7" }), tmp, bin);
      expect(r.status).toBe(4);
      expect(calls().some((c) => c.join(" ").includes("pg_restore") && !c.join(" ").includes("--list"))).toBe(false);
    });
  });
});
