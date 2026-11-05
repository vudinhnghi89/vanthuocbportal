type Listener = (e: { data: string }) => void;

/** EventSource giả để điều khiển open/message/error trong test. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset() {
    FakeEventSource.instances = [];
  }
  static get last() {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, l: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  // --- điều khiển từ test ---
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown, type = "document") {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    for (const l of this.listeners.get(type) ?? []) l({ data: raw });
  }
  fail(closed = false) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.();
  }
}
