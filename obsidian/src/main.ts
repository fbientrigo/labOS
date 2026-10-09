import { Editor, FileSystemAdapter, Notice, Plugin, TFile, normalizePath } from "obsidian";

import { CliLabOSBackend } from "./backend";
import { fingerprintTargets } from "./fingerprint";
import { LabOSSettingTab } from "./settings";
import { SessionNotes } from "./notes";
import type { LabOSBackend, LabOSSettings } from "./types";
import { LabOSView, VIEW_TYPE_LABOS } from "./view";

const DEFAULT_SETTINGS: LabOSSettings = {
  executable: "labos",
  home: "~/labos-data",
  defaultProject: "",
  defaultWorkdir: "",
  recentLimit: 30,
  reportsFolder: "LabOS/Reports",
  reportMode: "reviewed",
  reportWorker: "agy",
  reportValidator: "codex",
  reportCritic: "claude",
  reportTimeoutSeconds: 300,
  agyModel: "",
  codexModel: "",
  claudeModel: "",
  deviceColors: {},
  notesFolder: "LabOS/Notes",
  autoWriteDailyLog: false,
  copyQuickToNote: false,
  indexOnStartup: false,
  indexOnCreate: true,
  indexOnRename: true,
  indexOnDelete: true,
  noteIndex: {},
  fingerprintFiles: "",
};

export default class LabOSPlugin extends Plugin {
  settings: LabOSSettings = { ...DEFAULT_SETTINGS };
  private pendingLogDays = new Set<string>();
  notes!: SessionNotes;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.notes = new SessionNotes(this);

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.settings.indexOnRename) this.notes.onRename(oldPath, file.path);
      void this.getBackend().assetRename(oldPath, file.path).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice("LabOS could not record renamed asset: " + message, 8000);
      });
    }));

    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (this.settings.indexOnDelete) this.notes.onDelete(file.path);
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (this.settings.indexOnCreate) this.notes.onMetadata(file);
    }));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.indexOnStartup) void this.notes.rebuild();
    });

    this.registerView(
      VIEW_TYPE_LABOS,
      (leaf) => new LabOSView(leaf, this),
    );

    this.addRibbonIcon("flask-conical", "Open LabOS", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-panel",
      name: "Open panel",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "doctor",
      name: "Check setup",
      callback: () => {
        void this.runDoctor();
      },
    });

    this.addCommand({
      id: "capture-selection",
      name: "Capture editor selection as note",
      editorCallback: (editor: Editor) => {
        const text = editor.getSelection().trim();
        if (!text) {
          new Notice("Select text to capture as a LabOS note.");
          return;
        }
        void this.captureNote(text);
      },
    });

    this.addCommand({
      id: "retry-log-sync",
      name: "Retry pending LabOS daily log updates",
      callback: () => { void this.retryDailyLogs(); },
    });

    this.addCommand({
      id: "update-log",
      name: "Update log in LabOS",
      callback: () => { void this.updateActiveLog(); },
    });

    this.addCommand({
      id: "connect-note",
      name: "Connect this note to LabOS",
      callback: () => { void this.guard(() => this.notes.connectActive()); },
    });

    this.addCommand({
      id: "new-entry",
      name: "New entry (time added by LabOS)",
      editorCallback: (editor: Editor, view) => { void this.guard(() => this.notes.newEntry(editor, view.file)); },
    });

    this.addCommand({
      id: "sync-note",
      name: "Sync this note with LabOS",
      callback: () => { void this.guard(() => this.notes.sync(this.app.workspace.getActiveFile())); },
    });

    this.addCommand({
      id: "new-session-note",
      name: "New session note",
      callback: () => { void this.guard(() => this.notes.createSessionNote()); },
    });

    this.addCommand({
      id: "open-today-log",
      name: "Open today's log",
      callback: () => { void this.guard(() => this.openDailyLog()); },
    });

    this.addCommand({
      id: "write-today-log",
      name: "Write today's log",
      callback: () => { void this.guard(() => this.writeTodayLog()); },
    });

    this.addCommand({
      id: "rebuild-note-index",
      name: "Rebuild note index",
      callback: () => { void this.guard(() => this.rebuildIndex()); },
    });

    this.addCommand({
      id: "mark-working",
      name: "Mark working checkpoint",
      callback: () => {
        void this.markCheckpoint("working");
      },
    });

    this.addCommand({
      id: "mark-broken",
      name: "Mark broken checkpoint",
      callback: () => {
        void this.markCheckpoint("broken");
      },
    });

    this.addSettingTab(new LabOSSettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_LABOS);
  }

  getBackend(): LabOSBackend {
    return new CliLabOSBackend(this.settings);
  }

  get hasPendingLogUpdates(): boolean {
    return this.pendingLogDays.size > 0;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    await this.refreshViews();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_LABOS)[0];

    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? undefined;
      if (!leaf) {
        new Notice("Could not open the LabOS panel.");
        return;
      }
      await leaf.setViewState({
        type: VIEW_TYPE_LABOS,
        active: true,
      });
    }
    await workspace.revealLeaf(leaf);
    await this.refreshViews();
  }

  async refreshViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LABOS)) {
      if (leaf.view instanceof LabOSView) {
        await leaf.view.refresh();
      }
    }
  }

  private async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<LabOSSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(saved ?? {}),
    };
  }

  private async runDoctor(): Promise<void> {
    try {
      const result = await this.getBackend().doctor();
      const agents = Object.entries(result.agents)
        .map(([name, probe]) => `${name}=${probe.available ? "OK" : "missing"}`)
        .join(", ");
      new Notice(
        `LabOS core=${result.core_ok ? "OK" : "FAIL"}; ${agents}`,
        10000,
      );
    } catch (error) {
      this.showError(error);
    }
  }

  private async captureNote(text: string): Promise<void> {
    try {
      const file = this.app.workspace.getActiveFile();
      const event = await this.getBackend().capture({ text, links: file ? [{ title: file.basename, path: file.path }] : [] });
      const logUpdated = await this.writeDailyLogForEvent(event);
      new Notice(!logUpdated
        ? "Captured in LabOS; daily log update failed. Use Retry pending LabOS daily log updates."
        : "Captured in LabOS.", 8000);
      await this.refreshViews();
    } catch (error) {
      this.showError(error);
    }
  }

  /** Hash the files listed in Settings and attach them to a live checkpoint. Returns the files that failed. */
  async fingerprintCheckpoint(eventId: string, historical: boolean): Promise<string[]> {
    const skipped: string[] = [];
    for (const path of fingerprintTargets(this.settings.fingerprintFiles, historical)) {
      try {
        await this.getBackend().attach(path, "artifact", { hash: true, note: "checkpoint " + eventId });
      } catch {
        skipped.push(path.split(/[\/]/).pop() || path);
      }
    }
    return skipped;
  }

  async writeDailyLogForEvent(event: { timestamp: string; payload: Record<string, unknown> }): Promise<boolean> {
    if (!this.settings.autoWriteDailyLog) return true; // The log is written on request ("Write today's log").
    const instant = new Date(String(event.payload.occurred_at ?? event.timestamp));
    const day = [instant.getFullYear(), String(instant.getMonth() + 1).padStart(2, "0"), String(instant.getDate()).padStart(2, "0")].join("-");
    try {
      await this.writeDailyLog(day);
      this.pendingLogDays.delete(day);
      return true;
    } catch (error) {
      this.pendingLogDays.add(day);
      return false;
    }
  }

  async writeDailyLog(day: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const backend = this.getBackend();
    const stableId = await backend.dailyLogId(day);
    const vaultPath = await this.notes.logPath(stableId, day);
    await backend.writeDailyLog(day, adapter.getFullPath(normalizePath(vaultPath)));
    this.notes.remember("log:" + stableId, vaultPath);
  }

  private today(): string {
    return new Date().toLocaleDateString("en-CA");
  }

  async writeTodayLog(): Promise<void> {
    await this.writeDailyLog(this.today());
    new Notice("Today's log is up to date.");
  }

  async openDailyLog(): Promise<void> {
    const day = this.today();
    await this.writeDailyLog(day);
    const stableId = await this.getBackend().dailyLogId(day);
    const file = this.app.vault.getAbstractFileByPath(await this.notes.logPath(stableId, day));
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  async rebuildIndex(): Promise<void> {
    const count = await this.notes.rebuild();
    new Notice("LabOS note index rebuilt: " + String(count) + " entries.");
  }

  private async guard(action: () => Promise<void>): Promise<void> {
    try { await action(); } catch (error) { this.showError(error); }
  }

  async retryDailyLogs(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    for (const day of Array.from(this.pendingLogDays)) {
      try {
        await this.writeDailyLog(day);
        this.pendingLogDays.delete(day);
      } catch (error) {
        this.showError(error);
        return;
      }
    }
    new Notice("Pending LabOS daily logs are up to date.");
    await this.refreshViews();
  }

  private async updateActiveLog(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    const adapter = this.app.vault.adapter;
    if (!file || !(adapter instanceof FileSystemAdapter)) {
      new Notice("Open a LabOS daily log in Obsidian desktop first.");
      return;
    }
    try {
      const path = adapter.getFullPath(file.path);
      const preview = await this.getBackend().syncMarkdown(path);
      if (preview.status === "no_op") {
        new Notice("Markdown log is already in sync.");
        return;
      }
      const changedDetails = preview.changed_details?.length
        ? `\nChanges: ${preview.changed_details.map((item) => `${item.entry_id}: ${JSON.stringify(item.changes)}`).join("\n")}`
        : preview.changed.length ? `\nChanged entries: ${preview.changed.join(", ")}` : "";
      const newDetails = preview.new.length ? `\nNew entries: ${preview.new.map((item) => String(item.text ?? "(linked note)").slice(0, 120)).join(" | ")}` : "";
      const removedDetails = preview.removed.length ? `\nRemoved entries: ${preview.removed.join(", ")}` : "";
      const documentDiff = preview.text_diff ? `\nDocument edits:\n${preview.text_diff.slice(0, 1200)}` : "";
      const summary = `Apply Markdown changes?${changedDetails}${newDetails}${removedDetails}${documentDiff}`;
      if (!window.confirm(summary)) return;
      const result = await this.getBackend().syncMarkdown(path, true, preview.removed);
      new Notice(result.status === "confirmation_required" ? "Confirm the listed entry removals and retry." : `LabOS log updated; ${result.events.length} evidence events.`, 8000);
      await this.refreshViews();
    } catch (error) {
      this.showError(error);
    }
  }

  private async markCheckpoint(state: "working" | "broken"): Promise<void> {
    try {
      const event = await this.getBackend().checkpoint(state);
      const skipped = await this.fingerprintCheckpoint(event.id, false);
      const logUpdated = await this.writeDailyLogForEvent(event);
      new Notice(!logUpdated
        ? "Checkpoint saved; daily log update failed. Use Retry pending LabOS daily log updates."
        : skipped.length ? "Checkpoint saved; not fingerprinted: " + skipped.join(", ")
        : state === "working" ? "Marked working." : "Marked broken.", skipped.length ? 8000 : undefined);
      await this.refreshViews();
    } catch (error) {
      this.showError(error);
    }
  }

  private showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(message, 8000);
  }
}
