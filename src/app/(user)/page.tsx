import { DocumentTable } from "@/components/DocumentTable";
import { Dropzone } from "@/components/Dropzone";

export default function HomePage() {
  return (
    <>
      <h1>Tải văn bản lên</h1>
      <Dropzone />
      <section aria-label="Danh sách văn bản">
        <h2>Văn bản</h2>
        <DocumentTable />
      </section>
    </>
  );
}
