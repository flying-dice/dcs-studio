// Shared busy/notice lifecycle for the manager tool windows (Injection
// Manager, Mission Scripting). Every backend action funnels through `run`:
// one action at a time, failures land in the notice, success may set one.

export interface Notice {
  ok: boolean;
  text: string;
}

export class ToolActions {
  busy = $state(false);
  notice = $state<Notice | null>(null);

  /** Record a failure without running an action (detect/refresh paths). */
  fail(e: unknown): void {
    this.notice = { ok: false, text: String(e) };
  }

  clearNotice(): void {
    this.notice = null;
  }

  /** Run one backend action: no-op while busy; sets the success/failure notice. */
  async run(okText: string | null, action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.notice = null;
    try {
      await action();
      if (okText) this.notice = { ok: true, text: okText };
    } catch (e) {
      this.fail(e);
    } finally {
      this.busy = false;
    }
  }
}
