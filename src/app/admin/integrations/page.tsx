import { getDifySettingsView } from "@/server/settings";
import { IntegrationCard } from "./integration-card";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const [ocr, agent] = await Promise.all([getDifySettingsView("dify_ocr"), getDifySettingsView("dify_agent")]);
  const plain = (v: typeof ocr) => ({ ...v, updatedAt: v.updatedAt ? v.updatedAt.toISOString() : null });
  return (
    <section>
      <h1>Cấu hình tích hợp Dify</h1>
      <IntegrationCard
        integrationKey="dify_ocr"
        title="OCR workflow"
        initial={plain(ocr)}
        defaults={{ inputVar: "file", outputVarMd: "markdown", outputVarJson: "json", timeoutS: 300, retries: 3 }}
        help={
          <p>
            Workflow nhận một biến đầu vào kiểu tệp (file) và phải trả về hai biến đầu ra: một biến văn bản markdown và
            một biến json (chuỗi JSON hoặc đối tượng).
          </p>
        }
      />
      <IntegrationCard
        integrationKey="dify_agent"
        title="Agent chọn rule"
        initial={plain(agent)}
        defaults={{ inputVar: "markdown", outputVarMd: "markdown", outputVarJson: "rule_id", timeoutS: 120, retries: 2 }}
        help={
          <p>
            Workflow nhận nội dung markdown của văn bản trong biến đầu vào, cùng biến <code>candidates</code> (chuỗi JSON
            dạng <code>[{`{"id","title","summary"}`}]</code>). Workflow phải trả về id quy tắc được chọn trong biến JSON
            đầu ra: một số hoặc <code>{`{"rule_id": n}`}</code>. Biến markdown đầu ra không được dùng nhưng vẫn cần điền.
          </p>
        }
      />
    </section>
  );
}
