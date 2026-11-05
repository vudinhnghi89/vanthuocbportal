// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dropzone } from "@/components/Dropzone";

class MockXHR {
  static instances: MockXHR[] = [];
  method = "";
  url = "";
  body: FormData | null = null;
  aborted = false;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() {
    MockXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  get fileNames() {
    return this.body!.getAll("files").map((f) => (f as File).name);
  }
}

const MB = 1024 * 1024;
const pdf = (name = "a.pdf") => new File(["%PDF-1.4"], name, { type: "application/pdf" });
const sized = (name: string, size: number, type = "application/pdf") => {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
};
const okResults = (names: string[]) => ({
  results: names.map((filename, i) => ({ filename, ok: true, id: String(i), status: "queued" })),
});
const user = () => userEvent.setup({ applyAccept: false });
const input = () => screen.getByLabelText("Chọn tệp PDF") as HTMLInputElement;

beforeEach(() => {
  MockXHR.instances = [];
  vi.stubGlobal("XMLHttpRequest", MockXHR);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dropzone", () => {
  it("auto-uploads a selected valid PDF with field 'files', shows progress then queued", async () => {
    render(<Dropzone />);
    await user().upload(input(), pdf());
    expect(MockXHR.instances).toHaveLength(1);
    const x = MockXHR.instances[0];
    expect(x.method).toBe("POST");
    expect(x.url).toBe("/api/documents");
    expect(x.fileNames).toEqual(["a.pdf"]);
    act(() => x.progress(50, 100));
    expect(screen.getByText("Đang tải lên 50%")).toBeTruthy();
    act(() => x.respond(201, okResults(["a.pdf"])));
    expect(screen.getByText("Đã vào hàng đợi")).toBeTruthy();
  });

  it("shows 'Chờ tải lên' for files waiting for a later batch", async () => {
    render(<Dropzone />);
    await user().upload(input(), Array.from({ length: 11 }, (_, i) => pdf(`f${i}.pdf`)));
    expect(screen.getAllByText("Chờ tải lên")).toHaveLength(1);
  });

  it.each([
    ["txt", () => sized("a.txt", 10, "text/plain"), /PDF/],
    ["60 MiB", () => sized("big.pdf", 60 * MB), /50 MB/],
    ["empty", () => sized("e.pdf", 0), /rỗng/],
  ])("lists invalid %s with reason and does not send it", async (_n, make, re) => {
    render(<Dropzone />);
    await user().upload(input(), make());
    expect(MockXHR.instances).toHaveLength(0);
    expect(screen.getByText(re, { selector: "li *" })).toBeTruthy();
  });

  it("mixed selection sends only valid files", async () => {
    render(<Dropzone />);
    await user().upload(input(), [pdf("ok.pdf"), sized("x.txt", 5, "text/plain")]);
    expect(MockXHR.instances).toHaveLength(1);
    expect(MockXHR.instances[0].fileNames).toEqual(["ok.pdf"]);
    act(() => MockXHR.instances[0].respond(201, okResults(["ok.pdf"])));
    expect(screen.getByRole("status").textContent).toBe("Đã đưa 1 văn bản vào hàng đợi, 1 lỗi");
  });

  it("12 valid files -> two sequential requests (10 then 2)", async () => {
    render(<Dropzone />);
    const files = Array.from({ length: 12 }, (_, i) => pdf(`f${i}.pdf`));
    await user().upload(input(), files);
    expect(MockXHR.instances).toHaveLength(1);
    expect(MockXHR.instances[0].fileNames).toHaveLength(10);
    await act(async () => MockXHR.instances[0].respond(201, okResults(files.slice(0, 10).map((f) => f.name))));
    expect(MockXHR.instances).toHaveLength(2);
    expect(MockXHR.instances[1].fileNames).toEqual(["f10.pdf", "f11.pdf"]);
  });

  it("renders the server's per-file error verbatim", async () => {
    render(<Dropzone />);
    await user().upload(input(), pdf());
    act(() =>
      MockXHR.instances[0].respond(400, {
        results: [{ filename: "a.pdf", ok: false, error: "Tệp không phải PDF hợp lệ", code: "not_pdf" }],
      }),
    );
    expect(screen.getByText("Lỗi: Tệp không phải PDF hợp lệ")).toBeTruthy();
  });

  it("401 suggests logging in again", async () => {
    render(<Dropzone />);
    await user().upload(input(), pdf());
    act(() => MockXHR.instances[0].respond(401, { error: "Chưa đăng nhập" }));
    expect(screen.getByText(/đăng nhập lại/)).toBeTruthy();
  });

  it("network error maps to a message", async () => {
    render(<Dropzone />);
    await user().upload(input(), pdf());
    act(() => MockXHR.instances[0].onerror?.());
    expect(screen.getByText(/Lỗi: Mất kết nối mạng/)).toBeTruthy();
  });

  it("dispatches documents:uploaded once after success, not after total failure", async () => {
    const spy = vi.fn();
    window.addEventListener("documents:uploaded", spy);
    try {
      render(<Dropzone />);
      await user().upload(input(), pdf("a.pdf"));
      act(() => MockXHR.instances[0].respond(500, {}));
      expect(spy).not.toHaveBeenCalled();
      await user().upload(input(), pdf("b.pdf"));
      act(() => MockXHR.instances[1].respond(201, okResults(["b.pdf"])));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("documents:uploaded", spy);
    }
  });

  it("aria-live summary and clear button", async () => {
    render(<Dropzone />);
    const files = [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"), pdf("d.pdf")];
    await user().upload(input(), files);
    act(() =>
      MockXHR.instances[0].respond(201, {
        results: [
          ...okResults(["a.pdf", "b.pdf", "c.pdf"]).results,
          { filename: "d.pdf", ok: false, error: "Tệp rỗng", code: "empty" },
        ],
      }),
    );
    const live = screen.getByRole("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("Đã đưa 3 văn bản vào hàng đợi, 1 lỗi");
    await user().click(screen.getByRole("button", { name: "Xóa danh sách" }));
    expect(screen.queryByText("a.pdf")).toBeNull();
  });

  it("does not re-upload the exact same File object", async () => {
    render(<Dropzone />);
    const f = pdf();
    await user().upload(input(), f);
    act(() => MockXHR.instances[0].respond(201, okResults(["a.pdf"])));
    await user().upload(input(), f);
    expect(MockXHR.instances).toHaveLength(1);
  });

  it("Enter and Space on the drop zone open the file picker", async () => {
    render(<Dropzone />);
    const click = vi.spyOn(input(), "click");
    const zone = screen.getByTestId("dropzone");
    fireEvent.keyDown(zone, { key: "Enter" });
    fireEvent.keyDown(zone, { key: " " });
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("'Chọn tệp' button opens the file picker", async () => {
    render(<Dropzone />);
    const click = vi.spyOn(input(), "click");
    await user().click(screen.getByRole("button", { name: "Chọn tệp" }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("drop uploads files; dragover toggles highlight; non-file drags ignored", async () => {
    render(<Dropzone />);
    const zone = screen.getByTestId("dropzone");
    fireEvent.dragOver(zone, { dataTransfer: { types: ["text/plain"] } });
    expect(zone.classList.contains("dropzone--active")).toBe(false);
    fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"] } });
    expect(zone.classList.contains("dropzone--active")).toBe(true);
    fireEvent.dragLeave(zone, { dataTransfer: { types: ["Files"] } });
    expect(zone.classList.contains("dropzone--active")).toBe(false);
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [pdf("d.pdf")] } });
    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    expect(MockXHR.instances[0].fileNames).toEqual(["d.pdf"]);
    expect(zone.classList.contains("dropzone--active")).toBe(false);
  });

  it("ignores dropped folders", async () => {
    render(<Dropzone />);
    const zone = screen.getByTestId("dropzone");
    const dir = new File([], "folder");
    const items = [
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) },
    ];
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [dir, pdf("k.pdf")], items } });
    await waitFor(() => expect(MockXHR.instances).toHaveLength(1));
    expect(MockXHR.instances[0].fileNames).toEqual(["k.pdf"]);
    expect(within(screen.getByTestId("dropzone-list")).queryByText("folder")).toBeNull();
  });

  it("aborts the in-flight request on unmount", async () => {
    const { unmount } = render(<Dropzone />);
    await user().upload(input(), pdf());
    unmount();
    expect(MockXHR.instances[0].aborted).toBe(true);
  });
});
