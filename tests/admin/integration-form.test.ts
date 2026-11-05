import { describe, expect, it } from "vitest";
import { initialFormValues } from "@/app/admin/integrations/form-values";

const defaults = { inputVar: "file", outputVarMd: "markdown", outputVarJson: "json", timeoutS: 300, retries: 3 };
const empty = {
  baseUrl: "", apiKeyMasked: null, keyStatus: "none" as const, inputVar: "", outputVarMd: "", outputVarJson: "",
  timeoutS: 0, retries: 0, updatedAt: null, updatedBy: null,
};

describe("initialFormValues", () => {
  it("unconfigured card uses defaults", () => {
    expect(initialFormValues(empty, defaults)).toMatchObject({ inputVar: "file", timeoutS: "300", retries: "3" });
  });
  it("configured card keeps saved values, including retries=0", () => {
    const v = { ...empty, baseUrl: "http://x", apiKeyMasked: "****", keyStatus: "ok" as const, inputVar: "f2", outputVarMd: "m2", outputVarJson: "j2", timeoutS: 5, retries: 0, updatedAt: "2026-01-01T00:00:00Z" };
    expect(initialFormValues(v, defaults)).toEqual({
      baseUrl: "http://x", inputVar: "f2", outputVarMd: "m2", outputVarJson: "j2", timeoutS: "5", retries: "0",
    });
  });
});
