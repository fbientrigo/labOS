import { Editor, Notice, Plugin } from "obsidian";

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
  reportWorker: "agy",
  reportValidator: "codex",
  reportCritic: "claude",
  reportTimeoutSeconds: 300,
};

export default class LabOSPlugin extends Plugin {
  settings: LabOSSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

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

  private async captureNote(text: string): Promise<void> {
    try {
      await this.getBackend().note(text);
      new Notice("Captured in LabOS.");
      await this.refreshViews();
    } catch (error) {
      this.showError(error);
    }
  }

  private async markCheckpoint(state: "working" | "broken"): Promise<void> {
    try {
      await this.getBackend().checkpoint(state);
      new Notice(state === "working" ? "Marked working." : "Marked broken.");
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
