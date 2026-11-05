import { Dropzone } from "@/components/Dropzone";

export default function HomePage() {
  return (
    <>
      <h1>Tải văn bản lên</h1>
      <Dropzone />
      {/* T-6.2 thay nội dung này bằng danh sách; đăng ký sự kiện window "documents:uploaded" để tải lại. */}
      <section aria-label="Danh sách văn bản">
        <h2>Văn bản</h2>
        <p className="muted">Danh sách văn bản sẽ hiển thị ở đây</p>
      </section>
    </>
  );
}
