import { App, PluginSettingTab, Setting } from "obsidian";

import type LabOSPlugin from "./main";
import type { AgentProvider, LabOSSettings, ReportMode } from "./types";

const PROVIDERS: AgentProvider[] = ["agy", "codex", "claude"];

function addProviderOptions(dropdown: {
  addOption(value: string, display: string): unknown;
}): void {
  for (const provider of PROVIDERS) {
    dropdown.addOption(provider, provider);
  }
}

export class LabOSSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LabOSPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Core" });

    new Setting(containerEl)
      .setName("LabOS executable")
      .setDesc("Executable name or absolute path. Usually 'labos'.")
      .addText((text) =>
        text
          .setPlaceholder("labos")
          .setValue(this.plugin.settings.executable)
          .onChange(async (value) => {
            this.plugin.settings.executable = value.trim() || "labos";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("LabOS home")
      .setDesc("Raw evidence directory used by the CLI.")
      .addText((text) =>
        text
          .setPlaceholder("~/labos-data")
          .setValue(this.plugin.settings.home)
          .onChange(async (value) => {
            this.plugin.settings.home = value.trim() || "~/labos-data";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default project")
      .setDesc("Pre-fills the project field when starting work.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.defaultProject)
          .onChange(async (value) => {
            this.plugin.settings.defaultProject = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default work directory")
      .setDesc("Optional repo/work directory used for Git snapshots.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.defaultWorkdir)
          .onChange(async (value) => {
            this.plugin.settings.defaultWorkdir = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Recent events")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.recentLimit))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0 && parsed <= 200) {
              this.plugin.settings.recentLimit = parsed;
              await this.plugin.saveSettings();
            }
          }),
      );

    containerEl.createEl("h3", { text: "Reports" });

    new Setting(containerEl)
      .setName("Default report mode")
      .setDesc("Factual uses no AI; Reviewed uses worker+validator; Rigorous adds critic+revision+final validation.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("factual", "Factual")
          .addOption("reviewed", "Reviewed")
          .addOption("rigorous", "Rigorous")
          .setValue(this.plugin.settings.reportMode)
          .onChange(async (value) => {
            this.plugin.settings.reportMode = value as ReportMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Reports folder")
      .setDesc("Folder inside this vault for versioned report runs.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.reportsFolder)
          .onChange(async (value) => {
            this.plugin.settings.reportsFolder = value.trim() || "LabOS/Reports";
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h3", { text: "Advanced agent configuration" });

    for (const [role, settingKey] of [
      ["Worker", "reportWorker"],
      ["Validator", "reportValidator"],
      ["Critic", "reportCritic"],
    ] as const) {
      new Setting(containerEl)
        .setName(role)
        .addDropdown((dropdown) => {
          addProviderOptions(dropdown);
          dropdown
            .setValue(this.plugin.settings[settingKey])
            .onChange(async (value) => {
              this.plugin.settings[settingKey] = value as AgentProvider;
              await this.plugin.saveSettings();
            });
        });
    }

    for (const [label, settingKey] of [
      ["Agy model", "agyModel"],
      ["Codex model", "codexModel"],
      ["Claude model", "claudeModel"],
    ] as const) {
      new Setting(containerEl)
        .setName(label)
        .setDesc("Optional. Pin this for reproducible model provenance; blank uses the CLI default.")
        .addText((text) =>
          text
            .setValue(this.plugin.settings[settingKey])
            .onChange(async (value) => {
              this.plugin.settings[settingKey] = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName("Agent timeout")
      .setDesc("Maximum seconds allowed for each external agent call.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.reportTimeoutSeconds))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed >= 30 && parsed <= 1800) {
              this.plugin.settings.reportTimeoutSeconds = parsed;
              await this.plugin.saveSettings();
            }
          }),
      );

    containerEl.createEl("h3", { text: "Notes and index" });

    new Setting(containerEl)
      .setName("Session notes folder")
      .setDesc("Where 'New session note' creates YYMMDD.md. Connected notes can live anywhere and can be moved freely.")
      .addText((text) =>
        text
          .setPlaceholder("LabOS/Notes")
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async (value) => {
            this.plugin.settings.notesFolder = value.trim() || "LabOS/Notes";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Files to fingerprint at each checkpoint")
      .setDesc("One absolute path per line, for example the ELF and the bitstream. Their SHA-256 is saved with every live Working/Broken checkpoint. Empty: off.")
      .addTextArea((area) =>
        area
          .setPlaceholder("C:\path\to\firmware.elf")
          .setValue(this.plugin.settings.fingerprintFiles)
          .onChange(async (value) => {
            this.plugin.settings.fingerprintFiles = value;
            await this.plugin.saveSettings();
          }),
      );

    const toggles: Array<[keyof Pick<LabOSSettings, "autoWriteDailyLog" | "copyQuickToNote" | "indexOnStartup" | "indexOnCreate" | "indexOnRename" | "indexOnDelete">, string, string]> = [
      ["autoWriteDailyLog", "Update the daily log on every capture", "Off: write it only from the menu ('Write today's log')."],
      ["copyQuickToNote", "Copy quick-box notes into the session note", "Adds each quick note to your connected note in the same format."],
      ["indexOnStartup", "Build the note index at startup", "Off by default because a scan slows Obsidian starting. Use menu > Rebuild note index instead."],
      ["indexOnCreate", "Index new and edited connected notes", "Cheap: reads only the note that changed."],
      ["indexOnRename", "Follow moved notes and linked files", "Updates connected-note paths and explicitly linked LabOS assets when a vault file is renamed. Turn off to skip rename processing."],
      ["indexOnDelete", "Forget deleted notes", "Removes deleted notes from the index."],
    ];
    for (const [key, name, desc] of toggles) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
            this.plugin.settings[key] = value;
            await this.plugin.saveSettings();
          }),
        );
    }
  }
}
