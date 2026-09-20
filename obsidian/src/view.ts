import {
  FileSystemAdapter,
  FuzzySuggestModal,
  ItemView,
  Notice,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

import type LabOSPlugin from "./main";
import type { LabOSEvent, SessionState } from "./types";

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

    const header = contentEl.createDiv({ cls: "labos-header" });
    header.createEl("strong", { text: "LabOS" });
    const refreshButton = header.createEl("button", { text: "Refresh" });
    refreshButton.addEventListener("click", () => {
      void this.refresh();
    });

    try {
      const backend = this.plugin.getBackend();
      const session = await backend.status();

      if (session) {
        this.renderActiveSession(contentEl, session);
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

    const start = section.createEl("button", { text: "Start" });
    start.addEventListener("click", () => {
      const projectValue = project.value.trim();
      if (!projectValue) {
        new Notice("Project is required.");
        project.focus();
        return;
      }

      void this.act(async () => {
        await this.plugin.getBackend().start(projectValue, label.value.trim());
        new Notice(`LabOS started: ${projectValue}`);
      });
    });
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

    const end = section.createEl("button", { text: "End work" });
    end.addEventListener("click", () => {
      void this.act(async () => {
        await this.plugin.getBackend().end();
        new Notice("LabOS session ended.");
      });
    });
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
