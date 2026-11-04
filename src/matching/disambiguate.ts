import { pickRule } from "@/integrations/dify/client";
import { getDifySettings } from "@/server/settings";
import type { Rule } from "@/server/rules";

const MAX_CHARS = 30_000;

export type DisambiguateDeps = {
  getSettings?: typeof getDifySettings;
  pick?: typeof pickRule;
};

/** Code-point-safe prefix: never leaves half of a surrogate pair. */
function head(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/**
 * Ask the Dify agent which candidate rule fits the document.
 * Any failure yields null (no match); only the error class name is logged.
 */
export async function disambiguate(
  markdown: string,
  candidates: Rule[],
  deps: DisambiguateDeps = {},
): Promise<Rule | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const getSettings = deps.getSettings ?? getDifySettings;
  const pick = deps.pick ?? pickRule;
  try {
    const cfg = await getSettings("dify_agent");
    const id = await pick(
      cfg,
      head(markdown, MAX_CHARS),
      candidates.map((r) => ({ id: r.id, title: r.title ?? "", summary: r.summary ?? "" })),
    );
    return candidates.find((r) => r.id === id) ?? null;
  } catch (err) {
    const name = err instanceof Error ? err.constructor.name : "non-Error";
    console.warn(`[matching] agent disambiguation failed: ${name}`);
    return null;
  }
}
