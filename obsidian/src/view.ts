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
  DeviceKind,
  DeviceResource,
  DoctorResult,
  LabOSEvent,
  ReportMode,
  ReportProgress,
  ReportTask,
  ResourceSnapshot,
  SessionRecordResult,
  SessionState,
} from "./types";

export const VIEW_TYPE_LABOS = "labos-active-session";

type LabOSPage = "today" | "devices" | "reports";

const DEVICE_KINDS: DeviceKind[] = [
  "board",
  "scope",
  "psu",
  "daq",
  "detector",
  "other",
];

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
    return text ? state + " — " + text : state;
  }
  if (event.type === "artifact") {
    const kind = payloadString(event, "kind") || "artifact";
    return kind + ": " + payloadString(event, "name");
  }
  if (event.type === "session_start") {
    const label = payloadString(event, "label");
    return label ? "START — " + label : "START";
  }
  if (event.type === "session_end") {
    const text = payloadString(event, "text");
    return text ? "END — " + text : "END";
  }
  if (event.type === "resource_add" || event.type === "resource_remove") {
    const action = event.type === "resource_add" ? "DEVICE ADDED" : "DEVICE REMOVED";
    const alias = payloadString(event, "alias") || payloadString(event, "resource_id");
    return action + (alias ? " — " + alias : "");
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

function eventDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleString();
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

function activeResourceIds(record: SessionRecordResult | null): Set<string> {
  return new Set(
    (record?.record.resource_context?.active_at_end ?? []).map(
      (resource) => resource.resource_id,
    ),
  );
}

function snapshotFor(
  device: DeviceResource,
  snapshots: ResourceSnapshot[],
): ResourceSnapshot {
  return snapshots.find((item) => item.resource_id === device.resource_id) ?? {
    resource_id: device.resource_id,
    fingerprint: device.fingerprint,
    alias: device.alias,
    kind: device.kind,
  };
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

class DevicePicker extends FuzzySuggestModal<DeviceResource> {
  constructor(
    app: LabOSView["app"],
    private readonly devices: DeviceResource[],
    private readonly choose: (device: DeviceResource) => void,
    placeholder = "Choose a device...",
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): DeviceResource[] {
    return this.devices;
  }

  getItemText(device: DeviceResource): string {
    return device.alias + " · " + device.fingerprint + " · " + device.kind;
  }

  onChooseItem(device: DeviceResource): void {
    this.choose(device);
  }
}

export class LabOSView extends ItemView {
  private reportTask: ReportTask | null = null;
  private reportProgress: ReportProgress | null = null;
  private doctorResult: DoctorResult | null = null;
  private page: LabOSPage = "today";
  private selectedDeviceId: string | null = null;
  private preselectedStartDeviceIds = new Set<string>();

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

    this.renderHeader(contentEl);
    this.renderNavigation(contentEl);
    this.renderDoctorStatus(contentEl);

    try {
      const backend = this.plugin.getBackend();
      const [session, devices, events] = await Promise.all([
        backend.status(),
        backend.devices(),
        backend.recent(this.plugin.settings.recentLimit),
      ]);

      let record: SessionRecordResult | null = null;
      if (session) {
        try {
          record = await backend.record(session.session_id);
        } catch {
          // Capture remains usable if a derived view is temporarily unavailable.
        }
      }

      if (this.page === "today") {
        this.renderToday(contentEl, session, record, devices, events);
      } else if (this.page === "devices") {
        this.renderDevices(contentEl, session, record, devices);
      } else {
        this.renderReports(contentEl, session, record);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      contentEl.createDiv({ cls: "labos-error", text: message });
    }
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "labos-header" });
    header.createEl("strong", { text: "LabOS" });

    const headerActions = header.createDiv({ cls: "labos-actions" });
    const doctor = headerActions.createEl("button", { text: "Check setup" });
    doctor.addEventListener("click", () => {
      void this.runDoctor(doctor);
    });
    const refreshButton = headerActions.createEl("button", { text: "Refresh" });
    refreshButton.addEventListener("click", () => {
      void this.refresh();
    });
  }

  private renderNavigation(container: HTMLElement): void {
    const nav = container.createDiv({ cls: "labos-nav" });
    for (const [page, label] of [
      ["today", "Today"],
      ["devices", "Devices"],
      ["reports", "Reports"],
    ] as Array<[LabOSPage, string]>) {
      const button = nav.createEl("button", {
        cls: this.page === page ? "labos-nav-active" : "",
        text: label,
      });
      button.addEventListener("click", () => {
        this.page = page;
        if (page !== "devices") {
          this.selectedDeviceId = null;
        }
        void this.refresh();
      });
    }
  }

  private renderDoctorStatus(container: HTMLElement): void {
    if (!this.doctorResult) {
      return;
    }
    const row = container.createDiv({ cls: "labos-status-line" });
    row.createSpan({
      cls: this.doctorResult.core_ok ? "labos-ok" : "labos-error",
      text: "Core: " + (this.doctorResult.core_ok ? "OK" : "FAIL"),
    });
    const agentSummary = Object.entries(this.doctorResult.agents)
      .map(([name, probe]) => name + ":" + (probe.available ? "OK" : "missing"))
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
          "Core OK. Missing optional agent CLI(s): " + missing.join(", ") + ".",
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

  private renderToday(
    container: HTMLElement,
    session: SessionState | null,
    record: SessionRecordResult | null,
    devices: DeviceResource[],
    events: LabOSEvent[],
  ): void {
    if (session) {
      this.renderActiveSession(container, session, record, devices);
      if (record) {
        this.renderCoverage(container, record);
      }
    } else {
      this.renderStart(container, devices);
    }
    this.renderTimeline(container, events, session);
  }

  private renderStart(container: HTMLElement, devices: DeviceResource[]): void {
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

    const selected = new Set(this.preselectedStartDeviceIds);
    this.preselectedStartDeviceIds.clear();

    const deviceBlock = section.createDiv({ cls: "labos-device-picker-block" });
    deviceBlock.createEl("strong", { text: "Devices in this work" });
    deviceBlock.createDiv({
      cls: "labos-muted",
      text: "Optional. Start remains valid with no devices selected.",
    });

    if (devices.length === 0) {
      const empty = deviceBlock.createDiv({ cls: "labos-empty-state" });
      empty.createDiv({ text: "No devices registered yet." });
      const go = empty.createEl("button", { text: "Register a device" });
      go.addEventListener("click", () => {
        this.page = "devices";
        void this.refresh();
      });
    } else {
      const search = deviceBlock.createEl("input", {
        cls: "labos-input",
        attr: { placeholder: "Filter devices..." },
      });
      const list = deviceBlock.createDiv({ cls: "labos-device-checklist" });

      const draw = (): void => {
        list.empty();
        const query = search.value.trim().toLocaleLowerCase();
        const visible = devices.filter((device) =>
          [device.alias, device.fingerprint, device.kind]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query),
        );
        for (const device of visible) {
          const labelEl = list.createEl("label", { cls: "labos-device-choice" });
          const checkbox = labelEl.createEl("input", { type: "checkbox" });
          checkbox.checked = selected.has(device.resource_id);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              selected.add(device.resource_id);
            } else {
              selected.delete(device.resource_id);
            }
          });
          const text = labelEl.createDiv();
          text.createDiv({ text: device.alias });
          text.createDiv({
            cls: "labos-muted",
            text: device.fingerprint + " · " + device.kind,
          });
        }
        if (visible.length === 0) {
          list.createDiv({ cls: "labos-muted", text: "No matching devices." });
        }
      };
      search.addEventListener("input", draw);
      draw();
    }

    const start = section.createEl("button", { text: "Start" });
    start.addEventListener("click", () => {
      const projectValue = project.value.trim();
      if (!projectValue) {
        new Notice("Project is required.");
        project.focus();
        return;
      }
      void this.act(async () => {
        const backend = this.plugin.getBackend();
        await backend.start(
          projectValue,
          label.value.trim() || undefined,
          workdir.value.trim() || undefined,
        );
        const failures: string[] = [];
        for (const resourceId of selected) {
          try {
            await backend.useDevice(resourceId);
          } catch (error) {
            failures.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        if (failures.length) {
          throw new Error(
            "Session started, but some device associations failed: " +
              failures.join(" | "),
          );
        }
        new Notice("LabOS started: " + projectValue);
      });
    });
  }

  private renderActiveSession(
    container: HTMLElement,
    session: SessionState,
    record: SessionRecordResult | null,
    devices: DeviceResource[],
  ): void {
    const section = container.createDiv({ cls: "labos-section labos-stack" });

    section.createEl("h3", { text: session.project });
    if (session.label) {
      section.createDiv({ text: session.label });
    }
    section.createDiv({
      cls: "labos-event-time",
      text: "Started " + new Date(session.started_at).toLocaleString(),
    });
    if (session.started_cwd) {
      section.createDiv({
        cls: "labos-event-time",
        text: session.started_cwd,
      });
    }

    this.renderActiveDevices(section, record, devices);

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

  private renderActiveDevices(
    container: HTMLElement,
    record: SessionRecordResult | null,
    devices: DeviceResource[],
  ): void {
    const block = container.createDiv({ cls: "labos-active-devices" });
    const head = block.createDiv({ cls: "labos-header" });
    head.createEl("strong", { text: "Devices in this work" });

    const activeSnapshots = record?.record.resource_context?.active_at_end ?? [];
    const activeIds = new Set(activeSnapshots.map((item) => item.resource_id));

    const add = head.createEl("button", { text: "+ Add device" });
    add.disabled = devices.every((device) => activeIds.has(device.resource_id));
    add.addEventListener("click", () => {
      const available = devices.filter(
        (device) => !activeIds.has(device.resource_id),
      );
      new DevicePicker(
        this.app,
        available,
        (device) => {
          void this.act(async () => {
            await this.plugin.getBackend().useDevice(device.resource_id);
          });
        },
        "Add a device to this work...",
      ).open();
    });

    if (activeSnapshots.length === 0) {
      block.createDiv({
        cls: "labos-muted",
        text: "No device context recorded for this work.",
      });
      return;
    }

    for (const snapshot of activeSnapshots) {
      const current =
        devices.find((device) => device.resource_id === snapshot.resource_id) ??
        null;
      const row = block.createDiv({ cls: "labos-active-device-row" });
      const identity = row.createDiv({ cls: "labos-device-identity" });
      identity.createDiv({
        text: current?.alias || snapshot.alias || snapshot.resource_id,
      });
      identity.createDiv({
        cls: "labos-muted",
        text:
          (current?.fingerprint || snapshot.fingerprint || "unknown fingerprint") +
          (current?.kind || snapshot.kind
            ? " · " + (current?.kind || snapshot.kind)
            : ""),
      });

      const actions = row.createDiv({ cls: "labos-actions" });
      const replace = actions.createEl("button", { text: "Replace" });
      replace.disabled = devices.every((device) => activeIds.has(device.resource_id));
      replace.addEventListener("click", () => {
        const available = devices.filter(
          (device) => !activeIds.has(device.resource_id),
        );
        new DevicePicker(
          this.app,
          available,
          (next) => {
            void this.act(async () => {
              const backend = this.plugin.getBackend();
              await backend.removeDevice(snapshot.resource_id);
              try {
                await backend.useDevice(next.resource_id);
              } catch (error) {
                new Notice(
                  "Previous device was removed, but replacement could not be added.",
                  10000,
                );
                throw error;
              }
            });
          },
          "Replace with...",
        ).open();
      });

      const remove = actions.createEl("button", { text: "Remove" });
      remove.addEventListener("click", () => {
        void this.act(async () => {
          await this.plugin.getBackend().removeDevice(snapshot.resource_id);
        });
      });
    }
  }

  private renderDevices(
    container: HTMLElement,
    session: SessionState | null,
    record: SessionRecordResult | null,
    devices: DeviceResource[],
  ): void {
    const selected = this.selectedDeviceId
      ? devices.find((device) => device.resource_id === this.selectedDeviceId)
      : null;

    if (selected) {
      this.renderDeviceDetail(container, selected, session, record, devices);
      return;
    }

    const section = container.createDiv({ cls: "labos-section labos-stack" });
    const title = section.createDiv({ cls: "labos-header" });
    title.createEl("h2", { text: "Devices" });
    title.createSpan({
      cls: "labos-muted",
      text: String(devices.length) + " registered",
    });

    this.renderRegisterDevice(section);

    if (devices.length === 0) {
      section.createDiv({
        cls: "labos-empty-state",
        text: "No devices registered. Add the physical fingerprint and a short alias.",
      });
      return;
    }

    const search = section.createEl("input", {
      cls: "labos-input",
      attr: { placeholder: "Search alias or fingerprint..." },
    });
    const list = section.createDiv({ cls: "labos-device-list" });

    const draw = (): void => {
      list.empty();
      const query = search.value.trim().toLocaleLowerCase();
      const visible = devices.filter((device) =>
        [device.alias, device.fingerprint, device.kind]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query),
      );

      for (const device of visible) {
        const card = list.createEl("button", { cls: "labos-device-card" });
        const left = card.createDiv({ cls: "labos-device-identity" });
        left.createDiv({ cls: "labos-device-name", text: device.alias });
        left.createDiv({ cls: "labos-device-fingerprint", text: device.fingerprint });
        card.createSpan({ cls: "labos-device-kind", text: device.kind });
        card.addEventListener("click", () => {
          this.selectedDeviceId = device.resource_id;
          void this.refresh();
        });
      }

      if (visible.length === 0) {
        list.createDiv({ cls: "labos-muted", text: "No matching devices." });
      }
    };
    search.addEventListener("input", draw);
    draw();
  }

  private renderRegisterDevice(container: HTMLElement): void {
    const details = container.createEl("details", { cls: "labos-device-form" });
    details.createEl("summary", { text: "Register device" });
    const form = details.createDiv({ cls: "labos-stack" });

    const fingerprint = form.createEl("input", {
      cls: "labos-input",
      attr: { placeholder: "Fingerprint / serial / asset / JTAG ID" },
    });
    const alias = form.createEl("input", {
      cls: "labos-input",
      attr: { placeholder: "Alias, e.g. Zynq #2" },
    });
    const kind = form.createEl("select", { cls: "labos-select" });
    for (const value of DEVICE_KINDS) {
      kind.createEl("option", { value, text: value });
    }

    const add = form.createEl("button", { text: "Add device" });
    add.addEventListener("click", () => {
      const fp = fingerprint.value.trim();
      const name = alias.value.trim();
      if (!fp || !name) {
        new Notice("Fingerprint and alias are required.");
        return;
      }
      void this.act(async () => {
        const device = await this.plugin.getBackend().addDevice({
          fingerprint: fp,
          alias: name,
          kind: kind.value as DeviceKind,
        });
        this.selectedDeviceId = device.resource_id;
        new Notice("Device registered: " + device.alias);
      });
    });
  }

  private renderDeviceDetail(
    container: HTMLElement,
    device: DeviceResource,
    session: SessionState | null,
    record: SessionRecordResult | null,
    devices: DeviceResource[],
  ): void {
    const section = container.createDiv({ cls: "labos-section labos-stack" });
    const back = section.createEl("button", { cls: "labos-back", text: "← Devices" });
    back.addEventListener("click", () => {
      this.selectedDeviceId = null;
      void this.refresh();
    });

    const hero = section.createDiv({ cls: "labos-device-hero" });
    hero.createEl("h2", { text: device.alias.toUpperCase() });
    hero.createDiv({ cls: "labos-device-fingerprint", text: device.fingerprint });
    hero.createDiv({ cls: "labos-device-kind", text: device.kind });

    this.renderEditIdentity(section, device);

    const activeIds = activeResourceIds(record);
    const isActive = activeIds.has(device.resource_id);

    const workCard = section.createDiv({ cls: "labos-device-panel" });
    workCard.createEl("strong", { text: "CURRENT WORK" });
    if (session && isActive) {
      workCard.createDiv({ text: "In use · " + session.project });
      if (session.label) {
        workCard.createDiv({ cls: "labos-muted", text: session.label });
      }
    } else if (session) {
      workCard.createDiv({
        cls: "labos-muted",
        text: "Not currently associated with " + session.project + ".",
      });
      const use = workCard.createEl("button", { text: "Use in current work" });
      use.addEventListener("click", () => {
        void this.act(async () => {
          await this.plugin.getBackend().useDevice(device.resource_id);
        });
      });
    } else {
      workCard.createDiv({ cls: "labos-muted", text: "No active session." });
      const start = workCard.createEl("button", { text: "Start work with this device" });
      start.addEventListener("click", () => {
        this.preselectedStartDeviceIds = new Set([device.resource_id]);
        this.page = "today";
        this.selectedDeviceId = null;
        void this.refresh();
      });
    }

    const power = section.createDiv({ cls: "labos-device-panel" });
    power.createEl("strong", { text: "POWER" });
    power.createDiv({ cls: "labos-empty-value", text: "Not recorded" });
    power.createDiv({
      cls: "labos-muted",
      text: "No approved voltage, current limit, polarity, or Power Profile is stored yet.",
    });

    const working = section.createDiv({ cls: "labos-device-panel" });
    working.createEl("strong", { text: "LAST KNOWN WORKING" });
    working.createDiv({ cls: "labos-empty-value", text: "Not indexed yet" });
    working.createDiv({
      cls: "labos-muted",
      text: "LabOS will derive cross-session device state from recorded checkpoints in Phase D.",
    });

    const latest = section.createDiv({ cls: "labos-device-panel" });
    latest.createEl("strong", { text: "LATEST STATE" });
    latest.createDiv({ cls: "labos-empty-value", text: "Not indexed yet" });
    latest.createDiv({
      cls: "labos-muted",
      text: "No physical state is inferred from missing evidence.",
    });

    if (session && isActive && record) {
      this.renderDeviceCurrentEvidence(section, device, record);

      const capture = section.createEl("textarea", {
        cls: "labos-textarea",
        attr: { placeholder: "Note about " + device.alias + "..." },
      });
      const actions = section.createDiv({ cls: "labos-actions" });
      const note = actions.createEl("button", { text: "Add note" });
      note.addEventListener("click", () => {
        void this.captureNote(capture);
      });
      const good = actions.createEl("button", { text: "✓ Working" });
      good.addEventListener("click", () => {
        void this.captureCheckpoint("working", capture);
      });
      const bad = actions.createEl("button", { text: "✗ Broken" });
      bad.addEventListener("click", () => {
        void this.captureCheckpoint("broken", capture);
      });
    }

    const context = section.createDiv({ cls: "labos-device-panel" });
    context.createEl("strong", { text: "IDENTITY" });
    context.createDiv({
      cls: "labos-muted",
      text:
        "LabOS ID " +
        device.resource_id +
        " · created " +
        eventDateTime(device.created_at),
    });
    context.createDiv({
      cls: "labos-warning",
      text:
        "LabOS only knows physical state that was explicitly recorded or approved. " +
        "Absence of a recorded change is not proof that a physical setting remained unchanged.",
    });

    void devices;
  }

  private renderEditIdentity(container: HTMLElement, device: DeviceResource): void {
    const details = container.createEl("details", { cls: "labos-device-form" });
    details.createEl("summary", { text: "Edit identity" });
    const form = details.createDiv({ cls: "labos-stack" });

    const alias = form.createEl("input", { cls: "labos-input" });
    alias.value = device.alias;
    const fingerprint = form.createEl("input", { cls: "labos-input" });
    fingerprint.value = device.fingerprint;
    const kind = form.createEl("select", { cls: "labos-select" });
    for (const value of DEVICE_KINDS) {
      const option = kind.createEl("option", { value, text: value });
      option.selected = device.kind === value;
    }

    const save = form.createEl("button", { text: "Save identity" });
    save.addEventListener("click", () => {
      void this.act(async () => {
        await this.plugin.getBackend().editDevice(device.resource_id, {
          alias: alias.value.trim(),
          fingerprint: fingerprint.value.trim(),
          kind: kind.value as DeviceKind,
        });
        new Notice("Device identity updated.");
      });
    });
  }

  private renderDeviceCurrentEvidence(
    container: HTMLElement,
    device: DeviceResource,
    record: SessionRecordResult,
  ): void {
    const block = container.createDiv({ cls: "labos-device-panel" });
    block.createEl("strong", { text: "EVIDENCE IN CURRENT WORK" });

    const byEvent = record.record.resource_context?.by_event ?? {};
    const relevant = record.record.events.filter((event) =>
      (byEvent[event.id] ?? []).some(
        (resource) => resource.resource_id === device.resource_id,
      ),
    );

    if (relevant.length === 0) {
      block.createDiv({ cls: "labos-muted", text: "No evidence yet." });
      return;
    }

    for (const event of relevant.slice(-8).reverse()) {
      const row = block.createDiv({ cls: "labos-event" });
      const head = row.createDiv({ cls: "labos-event-head" });
      head.createSpan({
        cls: "labos-event-kind",
        text: event.type.replaceAll("_", " "),
      });
      head.createSpan({ cls: "labos-event-time", text: eventTime(event.timestamp) });
      row.createDiv({ text: eventText(event) });
    }
  }

  private renderReports(
    container: HTMLElement,
    session: SessionState | null,
    record: SessionRecordResult | null,
  ): void {
    const section = container.createDiv({ cls: "labos-section labos-stack" });
    section.createEl("h2", { text: "Reports" });
    section.createDiv({
      cls: "labos-muted",
      text:
        "Reports are derived from deterministic Session Records. They never replace raw evidence.",
    });

    this.renderReportControls(
      section,
      session?.session_id,
      session ? "Generate current report" : "Generate last report",
    );

    if (record) {
      this.renderCoverage(section, record);
    }
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
      text: String(p.current) + "/" + String(p.total) + " · " + p.message,
    });
    if (this.reportTask) {
      button.setText("Cancel · " + p.stage);
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
      new Notice("Attached: " + file.name);
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
        "LabOS report ready · " + statusText + " · run " + result.run_id,
        10000,
      );

      await new Promise((resolveDelay) => window.setTimeout(resolveDelay, 250));
      const file = this.app.vault.getFileByPath(vaultPath);
      if (file) {
        await this.app.workspace.getLeaf(false).openFile(file);
      } else {
        new Notice("Report saved at: " + vaultPath, 10000);
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
        text: event.type.replaceAll("_", " "),
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
      await this.refresh();
    }
  }
}
