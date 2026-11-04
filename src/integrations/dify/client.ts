import fs from "node:fs/promises";
import path from "node:path";
import {
  DifyConfigError,
  DifyError,
  DifyHttpError,
  DifyNetworkError,
  DifyOutputError,
  DifyTimeoutError,
  DifyWorkflowError,
} from "./errors";

export * from "./errors";

export type DifySettings = {
  baseUrl: string;
  apiKey: string;
  inputVar: string;
  outputVarMd: string;
  outputVarJson: string;
  timeoutS: number;
  retries: number;
};

export type RuleCandidate = { id: number; title: string; summary: string };

export type DifyClientOptions = {
  /** Override the backoff sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff base delay, default 1000 ms (factor 2, cap 30 s). */
  baseDelayMs?: number;
};

const USER = "van-thu-portal";
const MAX_DELAY_MS = 30_000;
const MAX_TEXT = 300;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function truncate(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Remove the API key (raw, URL-encoded and JSON-escaped forms) from text bound for error messages. */
export function scrubKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  const forms = new Set([apiKey, encodeURIComponent(apiKey), JSON.stringify(apiKey).slice(1, -1)]);
  let out = text;
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join("[redacted]");
  return out;
}

function scrub(text: string, cfg: DifySettings): string {
  return scrubKey(text, cfg.apiKey);
}

/** Scrub first, then truncate, so a key straddling the cut cannot leave a partial prefix. */
function safeText(text: string, cfg: DifySettings): string {
  return truncate(scrub(text, cfg));
}

const MAX_RETRIES = 10;

/** Validate/normalise settings: bad timeout throws, bad retries fall back to 0 (capped at 10). */
function normalise(cfg: DifySettings): DifySettings {
  if (!Number.isFinite(cfg.timeoutS) || cfg.timeoutS <= 0) {
    throw new DifyConfigError("Dify timeout must be a positive number of seconds");
  }
  const retries = Number.isFinite(cfg.retries) ? Math.min(MAX_RETRIES, Math.max(0, Math.floor(cfg.retries))) : 0;
  return { ...cfg, retries };
}

function endpoint(cfg: DifySettings, p: string): string {
  return `${cfg.baseUrl.replace(/\/+$/, "")}${p}`;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof DifyTimeoutError || err instanceof DifyNetworkError) return true;
  return err instanceof DifyHttpError && (err.status === 429 || err.status >= 500);
}

/** One HTTP attempt with its own timeout; returns parsed JSON or throws a typed error. */
async function attempt(cfg: DifySettings, p: string, init: RequestInit): Promise<unknown> {
  try {
    const res = await fetch(endpoint(cfg, p), {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(cfg.timeoutS * 1000),
    });
    const text = await res.text();
    if (!res.ok) throw new DifyHttpError(res.status, safeText(text, cfg));
    try {
      return JSON.parse(text);
    } catch {
      throw new DifyOutputError("Dify returned a non-JSON response");
    }
  } catch (err) {
    if (err instanceof DifyError) throw err;
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new DifyTimeoutError(cfg.timeoutS);
    const cause = (err as { cause?: { code?: string } } | null)?.cause;
    throw new DifyNetworkError(scrub(cause?.code ?? (err as Error)?.message ?? "unknown", cfg));
  }
}

/** Retries network errors, timeouts, 429 and 5xx with exponential backoff; other 4xx fail immediately. */
async function request(
  cfg: DifySettings,
  p: string,
  makeInit: () => RequestInit,
  opts: DifyClientOptions,
): Promise<unknown> {
  const sleep = opts.sleep ?? defaultSleep;
  const base = opts.baseDelayMs ?? 1000;
  for (let n = 0; ; n++) {
    try {
      return await attempt(cfg, p, makeInit());
    } catch (err) {
      if (n >= cfg.retries || !isRetryable(err)) throw err;
      await sleep(Math.min(base * 2 ** n, MAX_DELAY_MS));
    }
  }
}

async function runWorkflow(
  cfg: DifySettings,
  inputs: Record<string, unknown>,
  opts: DifyClientOptions,
): Promise<Record<string, unknown>> {
  const res = (await request(
    cfg,
    "/workflows/run",
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs, response_mode: "blocking", user: USER }),
    }),
    opts,
  )) as { data?: { status?: string; outputs?: Record<string, unknown> | null; error?: unknown } } | null;
  const data = res?.data;
  if (!data || data.status !== "succeeded") {
    const detail = typeof data?.error === "string" ? data.error : "";
    throw new DifyWorkflowError(String(data?.status ?? "unknown"), safeText(detail, cfg));
  }
  return data.outputs ?? {};
}

function stripFences(s: string): string {
  const m = /^\s*```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(s);
  return (m ? m[1] : s).trim();
}

export async function runOcr(
  cfg: DifySettings,
  pdfPath: string,
  opts: DifyClientOptions = {},
): Promise<{ markdown: string; json: unknown }> {
  cfg = normalise(cfg);
  const bytes = await fs.readFile(pdfPath);
  const filename = path.basename(pdfPath);
  const up = (await request(
    cfg,
    "/files/upload",
    () => {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/pdf" }), filename);
      form.append("user", USER);
      return { method: "POST", body: form };
    },
    opts,
  )) as { id?: unknown } | null;
  if (typeof up?.id !== "string" || !up.id) throw new DifyOutputError("Dify upload response has no file id");

  const outputs = await runWorkflow(
    cfg,
    { [cfg.inputVar]: { type: "document", transfer_method: "local_file", upload_file_id: up.id } },
    opts,
  );

  const markdown = outputs[cfg.outputVarMd];
  if (typeof markdown !== "string") {
    throw new DifyOutputError(`Dify output variable "${cfg.outputVarMd}" is missing or not a string`);
  }
  const raw = outputs[cfg.outputVarJson];
  if (raw === undefined || raw === null) {
    throw new DifyOutputError(`Dify output variable "${cfg.outputVarJson}" is missing`);
  }
  let json: unknown = raw;
  if (typeof raw === "string") {
    try {
      json = JSON.parse(stripFences(raw));
    } catch {
      throw new DifyOutputError(`Dify output variable "${cfg.outputVarJson}" is not valid JSON`);
    }
  }
  return { markdown, json };
}

/** Interpret the agent output (number, numeric string, JSON text or object); undefined when unusable. */
function parseRuleId(value: unknown, depth = 0): number | undefined {
  if (depth > 2) return undefined;
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value === "string") {
    const s = stripFences(value);
    if (/^\d+$/.test(s)) return Number(s);
    try {
      return parseRuleId(JSON.parse(s), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === "object" && "rule_id" in value) {
    return parseRuleId((value as { rule_id: unknown }).rule_id, depth + 1);
  }
  return undefined;
}

/**
 * Ask the Dify agent workflow which candidate rule matches the document.
 * Returns the id only if it is one of `candidates`, otherwise null (also for empty/garbage output).
 * Transport failures (after retries) THROW typed errors (DifyHttpError, DifyTimeoutError,
 * DifyNetworkError, DifyWorkflowError); the caller treats a throw as "no match".
 */
export async function pickRule(
  cfg: DifySettings,
  markdown: string,
  candidates: RuleCandidate[],
  opts: DifyClientOptions = {},
): Promise<number | null> {
  cfg = normalise(cfg);
  const outputs = await runWorkflow(
    cfg,
    { [cfg.inputVar]: markdown, candidates: JSON.stringify(candidates) },
    opts,
  );
  const id = parseRuleId(outputs[cfg.outputVarJson]);
  return id !== undefined && candidates.some((c) => c.id === id) ? id : null;
}
