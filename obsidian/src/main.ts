import { Editor, FileSystemAdapter, Notice, Plugin, normalizePath } from "obsidian";

import { CliLabOSBackend } from "./backend";
import { LabOSSettingTab } from "./settings";
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
};

export default class LabOSPlugin extends Plugin {
  settings: LabOSSettings = { ...DEFAULT_SETTINGS };
  private pendingLogDays = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      void this.getBackend().assetRename(oldPath, file.path).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice("LabOS could not record renamed asset: " + message, 8000);
      });
    }));

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

  async writeDailyLogForEvent(event: { timestamp: string; payload: Record<string, unknown> }): Promise<boolean> {
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
    const stableId = await this.getBackend().dailyLogId(day);
    const marker = new RegExp(`<!--\\s*labos-log-id:${stableId}\\s*-->`, "i");
    const matches: string[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const contents = await this.app.vault.cachedRead(file);
      if (marker.test(contents)) matches.push(file.path);
    }
    if (matches.length > 1) throw new Error(`Multiple vault notes contain the stable ID for ${day}; resolve the duplicate log first.`);
    const vaultPath = matches[0];
    const path = adapter.getFullPath(normalizePath(vaultPath ?? "LabOS/Logs/" + day + ".md"));
    await this.getBackend().writeDailyLog(day, path);
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
      const logUpdated = await this.writeDailyLogForEvent(event);
      new Notice(!logUpdated
        ? "Checkpoint saved; daily log update failed. Use Retry pending LabOS daily log updates."
        : state === "working" ? "Marked working." : "Marked broken.");
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
