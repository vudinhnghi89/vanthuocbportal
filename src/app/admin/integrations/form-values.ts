export type View = {
  baseUrl: string;
  apiKeyMasked: string | null;
  keyStatus: "none" | "ok" | "unreadable";
  inputVar: string;
  outputVarMd: string;
  outputVarJson: string;
  timeoutS: number;
  retries: number;
  updatedAt: string | null;
  updatedBy: string | null;
};
export type Defaults = { inputVar: string; outputVarMd: string; outputVarJson: string; timeoutS: number; retries: number };

/** Saved values for a configured card (so retries=0 survives); defaults only when nothing was saved yet. */
export function initialFormValues(v: View, d: Defaults) {
  const saved = v.updatedAt !== null;
  return {
    baseUrl: v.baseUrl,
    inputVar: saved ? v.inputVar : d.inputVar,
    outputVarMd: saved ? v.outputVarMd : d.outputVarMd,
    outputVarJson: saved ? v.outputVarJson : d.outputVarJson,
    timeoutS: String(saved ? v.timeoutS : d.timeoutS),
    retries: String(saved ? v.retries : d.retries),
  };
}
