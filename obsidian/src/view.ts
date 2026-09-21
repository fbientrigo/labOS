import {
  FileSystemAdapter,
  FuzzySuggestModal,
  ItemView,
  Notice,
  normalizePath,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { relative } from "path";

import type LabOSPlugin from "./main";
import type {
  DoctorResult,
  LabOSEvent,
  ReportMode,
  ReportProgress,
  ReportTask,
  SessionRecordResult,
  SessionState,
} from "./types";

export const VIEW_TYPE_LABOS = "labos-active-session";

function payloadString(event: LabOSEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value : "";
}

function eventText(event: LabOSEvent): string {
  if (event.type === "note") {
    return payloadString(event, "text");
  }
  if (event.type === "checkpoint") {
    const state = payloadString(event, "state").toUpperCase();
    const text = payloadString(event, "text");
    return text ? `${state} — ${text}` : state;
  }
  if (event.type === "artifact") {
    const kind = payloadString(event, "kind") || "artifact";
    return `${kind}: ${payloadString(event, "name")}`;
  }
  if (event.type === "session_start") {
    const label = payloadString(event, "label");
    return label ? `START — ${label}` : "START";
  }
  if (event.type === "session_end") {
    const text = payloadString(event, "text");
    return text ? `END — ${text}` : "END";
  }
  return event.type;
}

function eventTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isPhoto(file: TFile): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(
    file.extension.toLowerCase(),
  );
}

function modeDescription(mode: ReportMode): string {
  if (mode === "factual") {
    return "Deterministic only · no AI";
  }
  if (mode === "reviewed") {
    return "Worker → validator";
  }
  return "Worker → validator → critic → revision → final validator";
}

class VaultFilePicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: LabOSView["app"],
    private readonly choose: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Attach a file from this vault...");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}

export class LabOSView extends ItemView {
  private reportTask: ReportTask | null = null;
  private reportProgress: ReportProgress | null = null;
  private doctorResult: DoctorResult | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: LabOSPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_LABOS;
  }

  getDisplayText(): string {
    return "LabOS";
  }

  getIcon(): string {
    return "flask-conical";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("labos-view");

    const header = contentEl.createDiv({ cls: "labos-header labos-topbar" });

    const brand = header.createEl("button", {
      cls: "labos-brand-button",
      attr: {
        type: "button",
        title: "LabOS · Experiments Remember — refresh view",
        "aria-label": "LabOS · Experiments Remember — refresh view",
      },
    });
    const mark = brand.createSpan({
      cls: "labos-memory-core",
      attr: { "aria-hidden": "true" },
    });
    for (let index = 1; index <= 4; index += 1) {
      mark.createSpan({ cls: `labos-memory-core-segment segment-${index}` });
    }
    mark.createSpan({ cls: "labos-memory-core-center" });
    mark.createSpan({ cls: "labos-memory-core-state" });

    const brandCopy = brand.createSpan({ cls: "labos-brand-copy" });
    const wordmark = brandCopy.createSpan({ cls: "labos-wordmark" });
    wordmark.createSpan({ cls: "labos-wordmark-lab", text: "Lab" });
    wordmark.createSpan({ cls: "labos-wordmark-os", text: "OS" });
    brandCopy.createSpan({
      cls: "labos-brand-tagline",
      text: "EXPERIMENTS REMEMBER",
    });
    brand.addEventListener("click", () => {
      void this.refresh();
    });

    const headerActions = header.createDiv({ cls: "labos-actions" });
    const doctor = headerActions.createEl("button", { text: "Check setup" });
    doctor.addEventListener("click", () => {
      void this.runDoctor(doctor);
    });
    const refreshButton = headerActions.createEl("button", { text: "Refresh" });
    refreshButton.addEventListener("click", () => {
      void this.refresh();
    });

    this.renderDoctorStatus(contentEl);

    try {
      const backend = this.plugin.getBackend();
      const session = await backend.status();
      let record: SessionRecordResult | null = null;

      if (session) {
        try {
          record = await backend.record(session.session_id);
        } catch {
          // Keep capture usable even when derived display data has a problem.
        }
        this.renderActiveSession(contentEl, session);
        if (record) {
          this.renderCoverage(contentEl, record);
        }
      } else {
        this.renderStart(contentEl);
      }

      const events = await backend.recent(this.plugin.settings.recentLimit);
      this.renderTimeline(contentEl, events, session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      contentEl.createDiv({ cls: "labos-error", text: message });
    }
  }

  private renderDoctorStatus(container: HTMLElement): void {
    if (!this.doctorResult) {
      return;
    }
    const row = container.createDiv({ cls: "labos-status-line" });
    row.createSpan({
      cls: this.doctorResult.core_ok ? "labos-ok" : "labos-error",
      text: `Core: ${this.doctorResult.core_ok ? "OK" : "FAIL"}`,
    });
    const agentSummary = Object.entries(this.doctorResult.agents)
      .map(([name, probe]) => `${name}:${probe.available ? "OK" : "missing"}`)
      .join(" · ");
    row.createSpan({ cls: "labos-event-time", text: agentSummary });
  }

  private async runDoctor(button: HTMLButtonElement): Promise<void> {
    const original = button.textContent || "Check setup";
    button.disabled = true;
    button.setText("Checking…");
    try {
      this.doctorResult = await this.plugin.getBackend().doctor();
      const missing = Object.entries(this.doctorResult.agents)
        .filter(([, probe]) => !probe.available)
        .map(([name]) => name);
      if (!this.doctorResult.core_ok) {
        new Notice("LabOS core preflight failed. See panel status.", 10000);
      } else if (missing.length) {
        new Notice(
          `Core OK. Missing optional agent CLI(s): ${missing.join(", ")}.`,
          10000,
        );
      } else {
        new Notice("LabOS core and agent CLI preflight passed.", 7000);
      }
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message, 10000);
    } finally {
      button.disabled = false;
      button.setText(original);
    }
  }

  private renderStart(container: HTMLElement): void {
    const section = container.createDiv({ cls: "labos-section labos-stack" });
    section.createEl("h3", { text: "Start work" });

    const project = section.createEl("input", {
      cls: "labos-input",
      attr: { placeholder: "Project (e.g. TGC)" },
    });
    project.value = this.plugin.settings.defaultProject;

    const label = section.createEl("input", {
      cls: "labos-input",
      attr: { placeholder: "What are you doing? (optional)" },
    });

    const workdir = section.createEl("input", {
      cls: "labos-input",
      attr: { placeholder: "Repo/work directory for Git snapshots (optional)" },
    });
    workdir.value = this.plugin.settings.defaultWorkdir;

    const start = section.createEl("button", { text: "Start" });
    start.addEventListener("click", () => {
      const projectValue = project.value.trim();
      if (!projectValue) {
        new Notice("Project is required.");
        project.focus();
        return;
      }
      void this.act(async () => {
        await this.plugin.getBackend().start(
          projectValue,
          label.value.trim() || undefined,
          workdir.value.trim() || undefined,
        );
        new Notice(`LabOS started: ${projectValue}`);
      });
    });

    this.renderReportControls(section, undefined, "Generate last report");
  }

  private renderActiveSession(
    container: HTMLElement,
    session: SessionState,
  ): void {
    const section = container.createDiv({ cls: "labos-section labos-stack" });

    section.createEl("h3", { text: session.project });
    if (session.label) {
      section.createDiv({ text: session.label });
    }
    section.createDiv({
      cls: "labos-event-time",
      text: `Started ${new Date(session.started_at).toLocaleString()}`,
    });
    if (session.started_cwd) {
      section.createDiv({
        cls: "labos-event-time",
        text: session.started_cwd,
      });
    }

    const capture = section.createEl("textarea", {
      cls: "labos-textarea",
      attr: { placeholder: "Quick note..." },
    });

    const actions = section.createDiv({ cls: "labos-actions" });
    const noteButton = actions.createEl("button", { text: "Add note" });
    noteButton.addEventListener("click", () => {
      void this.captureNote(capture);
    });

    const working = actions.createEl("button", { text: "✓ Working" });
    working.addEventListener("click", () => {
      void this.captureCheckpoint("working", capture);
    });

    const broken = actions.createEl("button", { text: "✗ Broken" });
    broken.addEventListener("click", () => {
      void this.captureCheckpoint("broken", capture);
    });

    capture.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.captureNote(capture);
      }
    });

    const attachActions = section.createDiv({ cls: "labos-actions" });
    const current = attachActions.createEl("button", {
      text: "Attach current note",
    });
    current.addEventListener("click", () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) {
        new Notice("No active vault file.");
        return;
      }
      void this.attachVaultFile(file);
    });

    const choose = attachActions.createEl("button", { text: "Choose vault file" });
    choose.addEventListener("click", () => {
      new VaultFilePicker(this.app, (file) => {
        void this.attachVaultFile(file);
      }).open();
    });

    this.renderReportControls(section, session.session_id, "Generate report");

    const end = section.createEl("button", { text: "End work" });
    end.addEventListener("click", () => {
      void this.act(async () => {
        await this.plugin.getBackend().end();
        new Notice("LabOS session ended.");
      });
    });
  }

  private renderCoverage(
    container: HTMLElement,
    result: SessionRecordResult,
  ): void {
    const section = container.createDiv({ cls: "labos-section" });
    const head = section.createDiv({ cls: "labos-header" });
    head.createEl("h3", { text: "Evidence coverage" });
    head.createSpan({
      cls: "labos-event-time",
      text: result.evidence_sha256.slice(0, 12),
      attr: { title: result.evidence_sha256 },
    });

    const grid = section.createDiv({ cls: "labos-coverage" });
    for (const item of result.record.coverage.items) {
      const row = grid.createDiv({ cls: "labos-coverage-row" });
      const symbol =
        item.state === "present" ? "✓" : item.state === "absent" ? "–" : "·";
      row.createSpan({
        cls:
          item.state === "present"
            ? "labos-ok"
            : item.state === "absent"
              ? "labos-muted"
              : "labos-event-time",
        text: symbol,
      });
      row.createSpan({ text: item.label });
      row.createSpan({ cls: "labos-event-time", text: item.detail });
    }
    section.createDiv({
      cls: "labos-event-time",
      text: "Coverage reports what was recorded; it is not a quality score.",
    });
  }

  private renderReportControls(
    section: HTMLElement,
    sessionId: string | undefined,
    label: string,
  ): void {
    const block = section.createDiv({ cls: "labos-report-block labos-stack" });
    block.createEl("strong", { text: "Handoff" });

    const row = block.createDiv({ cls: "labos-actions" });
    const mode = row.createEl("select", { cls: "labos-select" });
    for (const value of ["factual", "reviewed", "rigorous"] as ReportMode[]) {
      const option = mode.createEl("option", {
        text: value.charAt(0).toUpperCase() + value.slice(1),
        value,
      });
      option.selected = this.plugin.settings.reportMode === value;
    }
    mode.disabled = this.reportTask !== null;
    mode.addEventListener("change", () => {
      this.plugin.settings.reportMode = mode.value as ReportMode;
      void this.plugin.saveSettings();
    });

    const button = row.createEl("button", {
      text: this.reportTask ? "Cancel report" : label,
    });
    const progress = block.createDiv({ cls: "labos-progress" });
    this.updateProgressDisplay(progress, button, label);

    button.addEventListener("click", () => {
      if (this.reportTask) {
        button.setText("Cancelling…");
        void this.reportTask.cancel();
        return;
      }
      void this.generateReport(
        button,
        progress,
        mode.value as ReportMode,
        sessionId,
        label,
      );
    });

    block.createDiv({
      cls: "labos-event-time",
      text: modeDescription(this.plugin.settings.reportMode),
    });
  }

  private updateProgressDisplay(
    progressEl: HTMLElement,
    button: HTMLButtonElement,
    idleLabel: string,
  ): void {
    progressEl.empty();
    if (!this.reportProgress) {
      if (!this.reportTask) {
        button.setText(idleLabel);
      }
      return;
    }
    const p = this.reportProgress;
    progressEl.createDiv({
      text: `${p.current}/${p.total} · ${p.message}`,
    });
    if (this.reportTask) {
      button.setText(`Cancel · ${p.stage}`);
    }
  }

  private async captureNote(textarea: HTMLTextAreaElement): Promise<void> {
    const text = textarea.value.trim();
    if (!text) {
      return;
    }
    await this.act(async () => {
      await this.plugin.getBackend().note(text);
      textarea.value = "";
    });
  }

  private async captureCheckpoint(
    state: "working" | "broken",
    textarea: HTMLTextAreaElement,
  ): Promise<void> {
    const text = textarea.value.trim();
    await this.act(async () => {
      await this.plugin.getBackend().checkpoint(state, text || undefined);
      textarea.value = "";
      new Notice(state === "working" ? "Marked working." : "Marked broken.");
    });
  }

  private async attachVaultFile(file: TFile): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("LabOS file attachment currently requires Obsidian desktop.");
      return;
    }
    const fullPath = adapter.getFullPath(file.path);
    await this.act(async () => {
      await this.plugin
        .getBackend()
        .attach(fullPath, isPhoto(file) ? "photo" : "artifact");
      new Notice(`Attached: ${file.name}`);
    });
  }

  private async generateReport(
    button: HTMLButtonElement,
    progressEl: HTMLElement,
    mode: ReportMode,
    sessionId: string | undefined,
    idleLabel: string,
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("Reports currently require Obsidian desktop.");
      return;
    }

    const folder = normalizePath(this.plugin.settings.reportsFolder)
      .replace(/^\/+/, "");
    if (!folder || folder === ".." || folder.startsWith("../")) {
      new Notice("Reports folder must stay inside the Obsidian vault.");
      return;
    }

    this.reportProgress = {
      stage: "starting",
      message: "Starting report run",
      current: 0,
      total: 1,
      status: "RUNNING",
      timestamp: new Date().toISOString(),
    };

    const task = this.plugin.getBackend().startReport(
      adapter.getFullPath(folder),
      {
        sessionId,
        mode,
        worker: this.plugin.settings.reportWorker,
        validator: this.plugin.settings.reportValidator,
        critic: this.plugin.settings.reportCritic,
        timeoutSeconds: this.plugin.settings.reportTimeoutSeconds,
      },
      (next) => {
        this.reportProgress = next;
        this.updateProgressDisplay(progressEl, button, idleLabel);
      },
    );
    this.reportTask = task;
    this.updateProgressDisplay(progressEl, button, idleLabel);

    try {
      const result = await task.promise;
      this.reportProgress = null;

      if (result.status === "CANCELLED") {
        new Notice("LabOS report cancelled. Deterministic Session Record preserved.");
        return;
      }

      const vaultPath = normalizePath(
        relative(adapter.getBasePath(), result.report),
      );
      const statusText =
        result.status === "VALIDATED"
          ? "validated"
          : result.status === "FACTUAL"
            ? "factual"
            : result.status === "REVIEW_REQUIRED"
              ? "review required"
              : "AI failed; factual fallback preserved";

      new Notice(
        `LabOS report ready · ${statusText} · run ${result.run_id}`,
        10000,
      );

      await new Promise((resolveDelay) => window.setTimeout(resolveDelay, 250));
      const file = this.app.vault.getFileByPath(vaultPath);
      if (file) {
        await this.app.workspace.getLeaf(false).openFile(file);
      } else {
        new Notice(`Report saved at: ${vaultPath}`, 10000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message, 12000);
    } finally {
      this.reportTask = null;
      this.reportProgress = null;
      button.setText(idleLabel);
      progressEl.empty();
      await this.refresh();
    }
  }

  private renderTimeline(
    container: HTMLElement,
    events: LabOSEvent[],
    session: SessionState | null,
  ): void {
    const section = container.createDiv({ cls: "labos-section" });
    section.createEl("h3", { text: session ? "This session" : "Recent" });

    const visible = session
      ? events.filter((event) => event.session_id === session.session_id)
      : events;

    if (visible.length === 0) {
      section.createDiv({
        cls: "labos-event-time",
        text: "No captured evidence yet.",
      });
      return;
    }

    for (const event of visible.slice().reverse()) {
      const row = section.createDiv({ cls: "labos-event" });
      const head = row.createDiv({ cls: "labos-event-head" });
      head.createSpan({
        cls: "labos-event-kind",
        text: event.type.replace("_", " "),
      });
      head.createSpan({
        cls: "labos-event-time",
        text: eventTime(event.timestamp),
      });
      row.createDiv({ text: eventText(event) });
    }
  }

  private async act(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message, 8000);
    }
  }
}
