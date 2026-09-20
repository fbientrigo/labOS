import { App, PluginSettingTab, Setting } from "obsidian";

import type LabOSPlugin from "./main";

export class LabOSSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LabOSPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

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
          .setPlaceholder("tgc")
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
          .setPlaceholder("~/thesis/atlasfpga_continuous_tcp")
          .setValue(this.plugin.settings.defaultWorkdir)
          .onChange(async (value) => {
            this.plugin.settings.defaultWorkdir = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Recent events")
      .setDesc("Number of recent events shown in the LabOS panel.")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.recentLimit))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0 && parsed <= 200) {
              this.plugin.settings.recentLimit = parsed;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
