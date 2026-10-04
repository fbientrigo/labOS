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

import { renderDeviceKnowledge } from "./device_knowledge";
import type LabOSPlugin from "./main";
import type {
  DeviceKind,
  DeviceKnowledge,
  DeviceResource,
  DoctorResult,
  LabOSEvent,
  LabOSBackend,
  ReportMode,
  ReportProgress,
  ReportTask,
  SessionRecordResult,
  SessionState,
  SetupHistoryItem,
  SessionChoice,
  SetupSnapshot,
} from "./types";

export const VIEW_TYPE_LABOS = "labos-active-session";

type LabOSPage = "today" | "setup" | "devices" | "reports";

const DEVICE_KINDS: DeviceKind[] = [
  "som",
  "soc",
  "carrier",
  "module",
  "programmer",
  "cable",
  "computer",
  "board",
  "scope",
  "psu",
  "daq",
  "detector",
  "other",
];

function kindLabel(kind: string): string {
  if (kind === "som") return "System on Module (SoM)";
  if (kind === "soc") return "System on Chip (SoC)";
  return kind;
}

function payloadString(event: LabOSEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value : "";
}

function eventText(event: LabOSEvent): string {
  if (event.type === "note") {
    return payloadString(event, "text");
  }
  if (event.type === "measurement") {
    const target = payloadString(event, "target") || "setup";
    const current = event.payload.current;
    const unit = payloadString(event, "unit");
    const voltage = event.payload.voltage;
    return `${target}: ${String(current ?? "")} ${unit}${typeof voltage === "number" ? " · " + String(voltage) + " V" : ""}${payloadString(event, "text") ? " · " + payloadString(event, "text") : ""}`;
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
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function eventDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleString([], { dateStyle: "short", timeStyle: "medium", hour12: false });
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
  private reportControls: {
    button: HTMLButtonElement;
    progress: HTMLElement;
    idleLabel: string;
  } | null = null;
  private doctorResult: DoctorResult | null = null;
  private page: LabOSPage = "today";
  private selectedDeviceId: string | null = null;
  private preselectedStartDeviceIds = new Set<string>();
  private deviceRegistryError: string | null = null;
  private selectedDay = new Date().toLocaleDateString("en-CA");
  private followsToday = true;
  private daySearch = "";
  private dayTag = "";
  private dayOffset = 0;
  private setupSaveQueue: Promise<void> = Promise.resolve();
  private currentWorkTag = "";
  private daySession = "";
  private pendingImages: Array<{ title: string; path: string; kind: string }> = [];
  private dayTagColors = new Map<string, string>();
  private history: SetupHistoryItem[] = [];
  private sessionChoices: SessionChoice[] = [];
  private historicalSessionSelect: HTMLSelectElement | null = null;
  private historicalSetupSelect: HTMLSelectElement | null = null;
  private selectedCardId: string | null = null;

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
    this.registerInterval(window.setInterval(() => {
      if (this.followsToday && this.selectedDay !== new Date().toLocaleDateString("en-CA")) void this.refresh();
    }, 60_000));
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const { contentEl } = this;
    this.reportControls = null;
    contentEl.empty();
    contentEl.addClass("labos-view");

    this.renderHeader(contentEl);
    this.renderNavigation(contentEl);
    this.renderPendingMarkdown(contentEl);
    this.renderDoctorStatus(contentEl);

    try {
      const backend = this.plugin.getBackend();
      if (this.followsToday) {
        const today = new Date().toLocaleDateString("en-CA");
        if (today !== this.selectedDay) this.dayOffset = 0;
        this.selectedDay = today;
      }
      const [session, events, setup, tags, colorSuggestions, assetMap, history, sessionChoices] = await Promise.all([
        backend.status(),
        backend.day(this.selectedDay, { limit: 100, offset: this.dayOffset, tag: this.dayTag || undefined, search: this.daySearch || undefined, sessionId: this.daySession || undefined }),
        backend.setup(),
        backend.tags(this.selectedDay),
        backend.tags("*"),
        backend.assetMap(),
        backend.setupHistory(),
        backend.sessions(),
      ]);
      this.history = history;
      this.sessionChoices = sessionChoices;

      let devices: DeviceResource[] = [];
      this.deviceRegistryError = null;
      try {
        devices = await backend.devices();
      } catch (error) {
        this.deviceRegistryError =
          error instanceof Error ? error.message : String(error);
      }

      const measurementTargets = ["setup", ...devices.map((device) => device.alias)];
      if (this.page === "today") {
        for (const device of devices) {
          try {
            const profileKnowledge = await backend.deviceKnowledge(device.resource_id);
            for (const profile of profileKnowledge.power_profiles) measurementTargets.push(...profile.rails.map((rail) => device.alias + " / " + rail.label));
          } catch { /* Power profiles are optional context. */ }
        }
      }

      if (this.deviceRegistryError) {
        contentEl.createDiv({
          cls: "labos-warning",
          text:
            "Device registry unavailable. Evidence capture remains available. " +
            this.deviceRegistryError,
        });
      }

      let record: SessionRecordResult | null = null;
      if (session) {
        try {
          record = await backend.record(session.session_id);
        } catch {
          // Capture remains usable if a derived view is temporarily unavailable.
        }
      }

      let knowledge: DeviceKnowledge | null = null;
      let knowledgeError: string | null = null;
      if (this.page === "devices" && this.selectedDeviceId) {
        try {
          knowledge = await backend.deviceKnowledge(this.selectedDeviceId);
        } catch (error) {
          knowledgeError = error instanceof Error ? error.message : String(error);
        }
      }

      if (this.page === "today") {
        this.renderToday(contentEl, session, record, devices, events, setup, tags, colorSuggestions, assetMap, measurementTargets);
      } else if (this.page === "setup") {
        this.renderSetup(contentEl, session !== null, devices, setup);
      } else if (this.page === "devices") {
        this.renderDevices(
          contentEl,
          session,
          record,
          devices,
          knowledge,
          knowledgeError,
        );
      } else {
        this.renderReports(contentEl, session, record);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      contentEl.createDiv({ cls: "labos-error", text: message });
    }
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "labos-header labos-topbar" });

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
      mark.createSpan({ cls: "labos-memory-core-segment segment-" + String(index) });
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
  }

  private renderNavigation(container: HTMLElement): void {
    const nav = container.createDiv({ cls: "labos-nav" });
    for (const [page, label] of [
      ["today", "Logs"],
      ["setup", "Setup"],
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
    setup: { devices: Array<Record<string, unknown>>; connections: Array<Record<string, unknown>> },
    tags: Array<{ name: string; color: string }>,
    colorSuggestions: Array<{ name: string; color: string }>,
    assetMap: Record<string, string>,
    measurementTargets: string[],
  ): void {
    this.dayTagColors = new Map(tags.map((item) => [item.name, item.color]));
    if (session) {
      this.renderActiveSession(container, session, record, devices, measurementTargets, tags);
      if (record) {
        this.renderCoverage(container, record);
      }
    } else {
      this.renderStart(container, devices, setup);
    }
    this.renderDayControls(container, events, tags, colorSuggestions);
    if (!session) {
      const quick = container.createDiv({ cls: "labos-section labos-stack" });
      quick.createEl("h3", { text: "Quick note" });
      this.renderHistoricalControls(quick);
      const input = quick.createEl("textarea", { cls: "labos-textarea", attr: { placeholder: "Observation (works without a session)" } });
      const occurrence = quick.createEl("input", { cls: "labos-input", attr: { type: "datetime-local", "aria-label": "Occurrence date and time" } });
      occurrence.value = this.defaultOccurrence(this.selectedDay);
      const preview = quick.createDiv({ cls: "labos-image-previews" });
      input.addEventListener("paste", (event) => void this.pasteImages(event, preview));
      const tag = this.createWorkTagSelector(quick, tags);
      const save = quick.createEl("button", { text: "Capture note" });
      save.addEventListener("click", () => void this.captureNote(input, tag.value, occurrence.value, this.historicalSessionSelect?.value, this.selectedHistoricalSetup()));
    }
    this.renderTimeline(container, events, session, setup, assetMap);
  }

  private renderPendingMarkdown(container: HTMLElement): void {
    if (!this.plugin.hasPendingLogUpdates) return;
    const row = container.createDiv({ cls: "labos-warning labos-actions", text: "Evidence is saved; a daily Markdown log update needs retry." });
    const retry = row.createEl("button", { text: "Retry log update" });
    retry.addEventListener("click", () => void this.plugin.retryDailyLogs());
  }

  private async captureWithMarkdown(input: Parameters<LabOSBackend["capture"]>[0]): Promise<void> {
    const event = await this.plugin.getBackend().capture(input);
    const logUpdated = await this.plugin.writeDailyLogForEvent(event);
    if (!logUpdated) new Notice("Evidence saved; daily Markdown log needs an update. Use Retry log update.", 10000);
  }

  private saveSetupSnapshot(setup: SetupSnapshot): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(setup)) as SetupSnapshot;
    new Notice("Saving setup…");
    const save = this.setupSaveQueue.catch(() => undefined).then(async () => {
      await this.plugin.getBackend().saveSetup(snapshot);
      new Notice("Setup saved.");
    });
    this.setupSaveQueue = save;
    return save;
  }

  private createWorkTagSelector(parent: HTMLElement, tags: Array<{ name: string; color: string }>): HTMLSelectElement {
    const select = parent.createEl("select", { cls: "labos-select", attr: { "aria-label": "Current work tag" } });
    select.createEl("option", { value: "", text: "No work tag" });
    for (const tag of tags) select.createEl("option", { value: tag.name, text: tag.name });
    select.value = this.currentWorkTag;
    select.addEventListener("change", () => { this.currentWorkTag = select.value; });
    return select;
  }

  private defaultOccurrence(day: string): string {
    const now = new Date();
    return `${day}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
  private renderDayControls(container: HTMLElement, entries: LabOSEvent[], tagDefinitions: Array<{ name: string; color: string }>, colorSuggestions: Array<{ name: string; color: string }>): void {
    const row = container.createDiv({ cls: "labos-actions labos-section" });
    const prev = row.createEl("button", { text: "‹ Previous" });
    prev.addEventListener("click", () => { const date = new Date(this.selectedDay + "T12:00:00"); date.setDate(date.getDate() - 1); this.selectedDay = date.toLocaleDateString("en-CA"); this.followsToday = false; this.dayOffset = 0; void this.refresh(); });
    const picker = row.createEl("input", { attr: { type: "date" } }); picker.value = this.selectedDay;
    picker.addEventListener("change", () => { this.selectedDay = picker.value; this.followsToday = false; this.dayOffset = 0; void this.refresh(); });
    const next = row.createEl("button", { text: "Next ›" });
    next.addEventListener("click", () => { const date = new Date(this.selectedDay + "T12:00:00"); date.setDate(date.getDate() + 1); this.selectedDay = date.toLocaleDateString("en-CA"); this.followsToday = false; this.dayOffset = 0; void this.refresh(); });
    const today = row.createEl("button", { text: "Today" });
    today.addEventListener("click", () => { this.followsToday = true; this.selectedDay = new Date().toLocaleDateString("en-CA"); this.dayOffset = 0; void this.refresh(); });
    const search = row.createEl("input", { cls: "labos-input", attr: { placeholder: "Search this day" } }); search.value = this.daySearch;
    search.addEventListener("change", () => { this.daySearch = search.value.trim(); this.dayOffset = 0; void this.refresh(); });
    const tag = row.createEl("select", { cls: "labos-select" });
    tag.createEl("option", { value: "", text: "All tags" });
    for (const value of Array.from(new Set([...tagDefinitions.map((item) => item.name), ...colorSuggestions.map((item) => item.name), ...entries.map((event) => String(event.payload.tag ?? ""))].filter(Boolean)))) tag.createEl("option", { value, text: value });
    tag.value = this.dayTag; tag.addEventListener("change", () => { this.dayTag = tag.value; this.dayOffset = 0; void this.refresh(); });
    const session = row.createEl("select", { cls: "labos-select" });
    session.createEl("option", { value: "", text: "All sessions" });
    for (const item of this.sessionChoices) session.createEl("option", { value: item.session_id, text: (item.project ?? "Session") + " · " + item.started_at });
    session.value = this.daySession; session.addEventListener("change", () => { this.daySession = session.value; this.dayOffset = 0; void this.refresh(); });
    const tagName = row.createEl("input", { cls: "labos-input", attr: { placeholder: "Define tag" } });
    const color = row.createEl("input", { cls: "labos-input", attr: { type: "text", placeholder: "#3388cc", title: "Tag color in HEX", list: "labos-tag-colors" } }); color.value = tagDefinitions[0]?.color ?? "#3388cc";
    const colorOptions = row.createEl("datalist", { attr: { id: "labos-tag-colors" } });
    for (const value of Array.from(new Set(colorSuggestions.map((item) => item.color)))) colorOptions.createEl("option", { value });
    tagName.setAttribute("list", "labos-tag-names");
    const tagNames = row.createEl("datalist", { attr: { id: "labos-tag-names" } });
    for (const value of Array.from(new Set(colorSuggestions.map((item) => item.name)))) tagNames.createEl("option", { value });
    tagName.addEventListener("change", () => {
      const suggestion = [...colorSuggestions].reverse().find((item) => item.name === tagName.value.trim());
      if (suggestion) color.value = suggestion.color;
    });
    const defineTag = row.createEl("button", { text: "Set tag color" });
    defineTag.addEventListener("click", () => { if (!tagName.value.trim() || !/^#[0-9a-f]{6}$/i.test(color.value)) { new Notice("Enter a tag name and six-digit HEX color."); return; } void this.act(async () => this.plugin.getBackend().setTag(this.selectedDay, tagName.value.trim(), color.value)); });
    if (this.dayTag) {
      const retag = row.createEl("button", { text: "Bulk retag filtered entries" });
      retag.addEventListener("click", () => { const next = window.prompt("New tag name", ""); if (next !== null) void this.act(async () => this.plugin.getBackend().retag(this.selectedDay, this.dayTag, next)); });
    }
    const older = row.createEl("button", { text: "Older entries" }); older.disabled = entries.length < 100;
    older.addEventListener("click", () => { this.dayOffset += 100; void this.refresh(); });
    if (this.dayOffset > 0) { const newer = row.createEl("button", { text: "Newer entries" }); newer.addEventListener("click", () => { this.dayOffset = Math.max(0, this.dayOffset - 100); void this.refresh(); }); }
  }

  private renderSetup(container: HTMLElement, active: boolean, devices: DeviceResource[], setup: { devices: Array<Record<string, unknown>>; connections: Array<Record<string, unknown>> }): void {
    const section = container.createDiv({ cls: "labos-section labos-stack" });
    section.createEl("h2", { text: "Hardware setup" });
    section.createDiv({ cls: "labos-muted", text: "Drag cards to arrange them. Connect two device names below; wiring is saved as one complete snapshot." });
    if (!active) { section.createDiv({ cls: "labos-warning", text: "Setup edits require an active session. The last recorded setup remains visible." }); }
    const canvas = section.createDiv({ cls: "labos-setup-canvas" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "labos-setup-wires");
    canvas.appendChild(svg);
    const cards = new Map<string, HTMLElement>();
    for (const [index, item] of setup.devices.entries()) {
      const card = canvas.createDiv({ cls: "labos-setup-card" });
      const id = String(item.resource_id ?? item.id ?? index);
      card.dataset.id = id;
      cards.set(id, card);
      if (this.selectedCardId === id) card.addClass("labos-setup-selected");
      card.style.left = String(item.x ?? 16 + index * 150) + "px";
      card.style.top = String(item.y ?? 16) + "px";
      card.createEl("strong", { text: String(item.alias ?? item.name ?? id) });
      card.createDiv({ cls: "labos-muted", text: String(item.kind ?? "device") });
      const activation = card.createEl("select", { cls: "labos-select" });
      for (const value of ["unknown", "active", "inactive"]) activation.createEl("option", { value, text: value });
      activation.value = String(item.activation ?? "unknown");
      activation.disabled = !active;
      activation.addEventListener("change", () => { item.activation = activation.value; void this.act(async () => this.saveSetupSnapshot(setup)); });
      const mode = card.createEl("input", { cls: "labos-input", attr: { placeholder: "Operating mode (optional)" } });
      mode.value = String(item.mode ?? ""); mode.disabled = !active;
      mode.addEventListener("change", () => { item.mode = mode.value; void this.act(async () => this.saveSetupSnapshot(setup)); });
      card.addEventListener("click", () => { this.selectedCardId = id; for (const node of cards.values()) node.toggleClass("labos-setup-selected", node === card); });
      card.addEventListener("pointerdown", (event) => { if (!active || (event.target instanceof Element && event.target.closest("button,input,select"))) return; const rect = card.getBoundingClientRect(); const dx = event.clientX - rect.left; const dy = event.clientY - rect.top; const startX = item.x ?? Number.parseInt(card.style.left); const startY = item.y ?? Number.parseInt(card.style.top); card.setPointerCapture(event.pointerId); const move = (e: PointerEvent) => { const bounds = canvas.getBoundingClientRect(); card.style.left = Math.max(0, e.clientX - bounds.left - dx) + "px"; card.style.top = Math.max(0, e.clientY - bounds.top - dy) + "px"; this.drawSetupWires(svg, setup, cards); }; const cleanup = () => { card.removeEventListener("pointermove", move); card.removeEventListener("pointerup", end); card.removeEventListener("pointercancel", cancel); }; const end = () => { cleanup(); item.x = Number.parseInt(card.style.left); item.y = Number.parseInt(card.style.top); void this.act(async () => this.saveSetupSnapshot(setup)); }; const cancel = () => { cleanup(); card.style.left = String(startX) + "px"; card.style.top = String(startY) + "px"; this.drawSetupWires(svg, setup, cards); }; card.addEventListener("pointermove", move); card.addEventListener("pointerup", end, { once: true }); card.addEventListener("pointercancel", cancel, { once: true }); });
      const handle = card.createEl("button", { cls: "labos-setup-handle", text: "●", attr: { type: "button", title: "Drag to connect" } });
      handle.disabled = !active;
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault(); event.stopPropagation();
        const move = (e: PointerEvent) => { const source = card.getBoundingClientRect(); const bounds = canvas.getBoundingClientRect(); this.drawSetupWires(svg, setup, cards); const line = document.createElementNS("http://www.w3.org/2000/svg", "line"); line.setAttribute("x1", String(source.right - bounds.left)); line.setAttribute("y1", String(source.top + source.height / 2 - bounds.top)); line.setAttribute("x2", String(e.clientX - bounds.left)); line.setAttribute("y2", String(e.clientY - bounds.top)); line.setAttribute("class", "labos-setup-wire-preview"); svg.appendChild(line); };
        const cancel = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", cancel); this.drawSetupWires(svg, setup, cards); };
        const finish = (e: PointerEvent) => { cancel(); const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".labos-setup-card"); if (!target || target === card || !target.dataset.id) return; const fromPort = window.prompt("Source endpoint / port", ""); if (fromPort === null) return; const toPort = window.prompt("Destination endpoint / port", ""); if (toPort === null) return; void this.act(async () => { setup.connections.push({ id: String(Date.now()), from: id, to: target.dataset.id, from_port: fromPort, to_port: toPort }); await this.saveSetupSnapshot(setup); }); };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish, { once: true }); window.addEventListener("pointercancel", cancel, { once: true });
      });
    }
    this.drawSetupWires(svg, setup, cards);
    const controls = section.createDiv({ cls: "labos-actions" });
    const from = controls.createEl("select", { cls: "labos-select" }); const to = controls.createEl("select", { cls: "labos-select" });
    for (const device of devices) for (const select of [from, to]) select.createEl("option", { value: device.resource_id, text: device.alias });
    const connect = controls.createEl("button", { text: "Connect" });
    connect.disabled = !active;
    connect.addEventListener("click", () => {
      if (from.value === to.value) { new Notice("Choose two different devices."); return; }
      if (![from.value, to.value].every((id) => setup.devices.some((item) => String(item.resource_id ?? item.id) === id))) {
        new Notice("Add both devices to the setup before connecting them."); return;
      }
      const fromPort = window.prompt("Endpoint label / port on first device", "");
      if (fromPort === null) return;
      const toPort = window.prompt("Endpoint label / port on second device", "");
      if (toPort === null) return;
      void this.act(async () => { setup.connections.push({ id: String(Date.now()), from: from.value, to: to.value, from_port: fromPort, to_port: toPort }); await this.saveSetupSnapshot(setup); });
    });
    const add = controls.createEl("button", { text: "Add device" }); add.disabled = !active;
    add.addEventListener("click", () => {
      const device = devices.find((candidate) => candidate.resource_id === from.value);
      if (!device) return;
      if (setup.devices.some((item) => String(item.resource_id ?? item.id) === device.resource_id)) {
        new Notice("This device is already in the setup."); return;
      }
      void this.act(async () => { setup.devices.push({ resource_id: device.resource_id, fingerprint: device.fingerprint, alias: device.alias, kind: device.kind, x: 16 + setup.devices.length * 150, y: 16, activation: "unknown" }); await this.saveSetupSnapshot(setup); });
    });
    const replace = controls.createEl("button", { text: "Replace device" }); replace.disabled = !active;
    replace.addEventListener("click", () => {
      const oldId = window.prompt("Identity of the device to replace");
      const device = devices.find((candidate) => candidate.resource_id === from.value);
      const previous = setup.devices.find((item) => String(item.resource_id ?? item.id) === oldId || String(item.alias) === oldId);
      if (!oldId || !device || !previous) return;
      if (setup.devices.some((item) => item !== previous && String(item.resource_id ?? item.id) === device.resource_id)) {
        new Notice("The replacement device is already in the setup."); return;
      }
      void this.act(async () => { const newId = device.resource_id; const replacement = { ...previous, resource_id: newId, fingerprint: device.fingerprint, alias: device.alias, kind: device.kind }; setup.devices = setup.devices.map((item) => item === previous ? replacement : item); for (const edge of setup.connections) { if (edge.from === oldId || edge.from === previous.resource_id) edge.from = newId; if (edge.to === oldId || edge.to === previous.resource_id) edge.to = newId; } await this.saveSetupSnapshot(setup); });
    });
    const remove = controls.createEl("button", { text: "Remove selected" }); remove.disabled = !active;
    remove.addEventListener("click", () => { const selected = this.selectedCardId; if (selected) void this.act(async () => { setup.devices = setup.devices.filter((device) => String(device.resource_id ?? device.id) !== selected); setup.connections = setup.connections.filter((edge) => edge.from !== selected && edge.to !== selected); this.selectedCardId = null; await this.saveSetupSnapshot(setup); }); });
    const wires = section.createDiv({ cls: "labos-stack" });
    for (const edge of setup.connections) {
      const line = wires.createDiv({ cls: "labos-connection" });
      const label = line.createSpan({ text: String(edge.from) + "." + String(edge.from_port ?? "") + " ↔ " + String(edge.to) + "." + String(edge.to_port ?? "") });
      label.addEventListener("click", () => { if (!active) return; const a = window.prompt("First endpoint label", String(edge.from_port ?? "")); if (a === null) return; const b = window.prompt("Second endpoint label", String(edge.to_port ?? "")); if (b === null) return; edge.from_port = a; edge.to_port = b; void this.act(async () => this.saveSetupSnapshot(setup)); });
      const disconnect = line.createEl("button", { text: "Disconnect" }); disconnect.disabled = !active;
      disconnect.addEventListener("click", () => void this.act(async () => { setup.connections = setup.connections.filter((candidate) => candidate !== edge); await this.saveSetupSnapshot(setup); }));
    }
  }

  private drawSetupWires(svg: SVGSVGElement, setup: { connections: Array<Record<string, unknown>> }, cards: Map<string, HTMLElement>): void {
    svg.replaceChildren();
    svg.setAttribute("width", String(svg.parentElement?.clientWidth ?? 0));
    svg.setAttribute("height", String(svg.parentElement?.clientHeight ?? 0));
    for (const edge of setup.connections) {
      const from = cards.get(String(edge.from));
      const to = cards.get(String(edge.to));
      if (!from || !to) continue;
      const x1 = Number.parseFloat(from.style.left) + from.offsetWidth;
      const y1 = Number.parseFloat(from.style.top) + from.offsetHeight / 2;
      const x2 = Number.parseFloat(to.style.left);
      const y2 = Number.parseFloat(to.style.top) + to.offsetHeight / 2;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(x1)); line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2)); line.setAttribute("y2", String(y2));
      line.setAttribute("class", "labos-setup-wire"); svg.appendChild(line);
    }
  }

  private renderStart(container: HTMLElement, devices: DeviceResource[], lastSetup: { devices: Array<Record<string, unknown>>; connections: Array<Record<string, unknown>> }): void {
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

    const carryLabel = section.createEl("label", { cls: "labos-device-choice" });
    const carrySetup = carryLabel.createEl("input", { type: "checkbox" });
    carryLabel.createSpan({ text: "Use the last recorded hardware setup for this session" });

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
          carrySetup.checked ? lastSetup : { devices: [], connections: [] },
        );
        const carriedIds = new Set(carrySetup.checked ? lastSetup.devices.map((item) => String(item.resource_id ?? item.id)) : []);
        const failures: string[] = [];
        for (const resourceId of selected) {
          if (carriedIds.has(resourceId)) continue;
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
    measurementTargets: string[],
    tags: Array<{ name: string; color: string }>,
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
    this.renderHistoricalControls(section);
    const imagePreviews = section.createDiv({ cls: "labos-image-previews" });
    capture.addEventListener("paste", (event) => void this.pasteImages(event, imagePreviews));
    const workTag = section.createEl("input", { cls: "labos-input", attr: { placeholder: "Work tag (optional)" } });
    const captureAt = section.createEl("input", { cls: "labos-input", attr: { type: "datetime-local" } });

    const actions = section.createDiv({ cls: "labos-actions" });
    const noteButton = actions.createEl("button", { text: "Add note" });
    noteButton.addEventListener("click", () => {
      void this.captureNote(capture, workTag.value, captureAt.value, this.historicalSessionSelect?.value, this.selectedHistoricalSetup());
    });

    const measure = section.createDiv({ cls: "labos-device-panel labos-stack" });
    measure.createEl("strong", { text: "Current measurement" });
    const target = measure.createEl("input", { cls: "labos-input", attr: { placeholder: "Whole setup, device, or named rail", list: "labos-measure-targets" } });
    const targetList = measure.createEl("datalist", { attr: { id: "labos-measure-targets" } });
    for (const value of measurementTargets) targetList.createEl("option", { value });
    target.value = "setup";
    const currentInput = measure.createEl("input", { cls: "labos-input", attr: { type: "number", min: "0", step: "any", placeholder: "Current" } });
    const unit = measure.createEl("select", { cls: "labos-select" }); unit.createEl("option", { value: "mA", text: "mA" }); unit.createEl("option", { value: "A", text: "A" });
    const voltage = measure.createEl("input", { cls: "labos-input", attr: { type: "number", step: "any", placeholder: "Voltage (optional)" } });
    const measurement = measure.createEl("textarea", { cls: "labos-textarea", attr: { placeholder: "Measurement note" } });
    const measurePreview = measure.createDiv({ cls: "labos-image-previews" });
    measurement.addEventListener("paste", (event) => void this.pasteImages(event, measurePreview));
    const captureMeasurement = measure.createEl("button", { text: "Capture measurement" });
    captureMeasurement.addEventListener("click", () => void this.act(async () => { const value = Number(currentInput.value); if (!currentInput.value || !Number.isFinite(value)) throw new Error("Enter a valid current value."); const activeFile = this.app.workspace.getActiveFile(); const links = [...(activeFile ? [{ title: activeFile.basename, path: activeFile.path }] : []), ...this.pendingImages]; const occurrence = captureAt.value || (!this.followsToday ? this.defaultOccurrence(this.selectedDay) : undefined); await this.captureWithMarkdown({ kind: "measurement", text: measurement.value, tag: workTag.value || undefined, target: target.value || "setup", current: value, unit: unit.value as "A" | "mA", voltage: voltage.value ? Number(voltage.value) : undefined, occurredAt: occurrence ? new Date(occurrence).toISOString() : undefined, links, sessionId: this.historicalSessionSelect?.value || undefined, setup: this.selectedHistoricalSetup() }); this.pendingImages = []; currentInput.value = ""; voltage.value = ""; measurement.value = ""; }));

    const working = actions.createEl("button", { text: "✓ Working" });
    working.addEventListener("click", () => {
      void this.captureCheckpoint("working", capture, workTag.value, captureAt.value);
    });

    const broken = actions.createEl("button", { text: "✗ Broken" });
    broken.addEventListener("click", () => {
      void this.captureCheckpoint("broken", capture, workTag.value, captureAt.value);
    });

    capture.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.captureNote(capture, workTag.value, captureAt.value, this.historicalSessionSelect?.value, this.selectedHistoricalSetup());
      }
    });

    const attachActions = section.createDiv({ cls: "labos-actions" });
    const current = attachActions.createEl("button", {
      text: "Link current note",
    });
    current.addEventListener("click", () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) {
        new Notice("No active vault file.");
        return;
      }
      void this.linkVaultFile(file);
    });

    const choose = attachActions.createEl("button", { text: "Link vault file" });
    choose.addEventListener("click", () => {
      new VaultFilePicker(this.app, (file) => {
        void this.linkVaultFile(file);
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
    knowledge: DeviceKnowledge | null,
    knowledgeError: string | null,
  ): void {
    const selected = this.selectedDeviceId
      ? devices.find((device) => device.resource_id === this.selectedDeviceId)
      : null;

    if (selected) {
      this.renderDeviceDetail(
        container,
        selected,
        session,
        record,
        knowledge,
        knowledgeError,
      );
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
      kind.createEl("option", { value, text: kindLabel(value) });
    }
    kind.createEl("option", { value: "custom", text: "Custom kind…" });
    const customKind = form.createEl("input", { cls: "labos-input", attr: { placeholder: "Custom kind" } });

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
          kind: kind.value === "custom" ? customKind.value.trim() : kind.value as DeviceKind,
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
    knowledge: DeviceKnowledge | null,
    knowledgeError: string | null,
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

    this.renderApprovedKnowledge(
      section,
      device,
      knowledge,
      knowledgeError,
    );

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

    if (record) {
      this.renderDeviceCurrentEvidence(section, device, record);
    }

    if (session && isActive && record) {
      section.createDiv({
        cls: "labos-muted",
        text:
          "Notes and checkpoints use the complete active resource context. " +
          "If other devices are active, this evidence is attributable to them too.",
      });

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

  }

  private renderApprovedKnowledge(
    container: HTMLElement,
    device: DeviceResource,
    knowledge: DeviceKnowledge | null,
    knowledgeError: string | null,
  ): void {
    renderDeviceKnowledge(container, knowledge, knowledgeError, {
      approveFact: (input) =>
        this.act(async () => {
          await this.plugin.getBackend().approveDeviceFact(device.resource_id, input);
        }),
      editFact: (factId, input) =>
        this.act(async () => {
          await this.plugin
            .getBackend()
            .editDeviceFact(device.resource_id, factId, input);
        }),
      approvePowerProfile: (input) =>
        this.act(async () => {
          await this.plugin
            .getBackend()
            .approvePowerProfile(device.resource_id, input);
        }),
      editPowerProfile: (profileId, input) =>
        this.act(async () => {
          await this.plugin
            .getBackend()
            .editPowerProfile(device.resource_id, profileId, input);
        }),
    });
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
    this.reportControls = { button, progress, idleLabel: label };
    this.updateProgressDisplay();

    button.addEventListener("click", () => {
      if (this.reportTask) {
        button.setText("Cancelling…");
        void this.reportTask.cancel();
        return;
      }
      void this.generateReport(mode.value as ReportMode, sessionId);
    });

    block.createDiv({
      cls: "labos-event-time",
      text: modeDescription(this.plugin.settings.reportMode),
    });
  }

  private updateProgressDisplay(): void {
    const controls = this.reportControls;
    if (!controls) {
      return;
    }
    controls.progress.empty();
    if (!this.reportProgress) {
      controls.button.setText(
        this.reportTask ? "Cancel report" : controls.idleLabel,
      );
      return;
    }
    const p = this.reportProgress;
    controls.progress.createDiv({
      text: String(p.current) + "/" + String(p.total) + " · " + p.message,
    });
    controls.button.setText(
      this.reportTask ? "Cancel · " + p.stage : controls.idleLabel,
    );
  }

  private async captureNote(textarea: HTMLTextAreaElement, tag?: string, occurredAt?: string, sessionId?: string, setup?: SetupSnapshot): Promise<void> {
    const text = textarea.value.trim();
    if (!text) {
      return;
    }
    await this.act(async () => {
      const activeFile = this.app.workspace.getActiveFile();
      const links = [
        ...(activeFile ? [{ title: activeFile.basename, path: activeFile.path }] : []),
        ...this.pendingImages,
      ];
      const occurrence = occurredAt || (!this.followsToday ? this.defaultOccurrence(this.selectedDay) : undefined);
      await this.captureWithMarkdown({ text, tag: tag || undefined, occurredAt: occurrence ? new Date(occurrence).toISOString() : undefined, links, sessionId: sessionId || undefined, setup });
      this.pendingImages = [];
      textarea.value = "";
    });
  }

  private renderHistoricalControls(container: HTMLElement): void {
    const row = container.createDiv({ cls: "labos-actions" });
    const session = row.createEl("select", { cls: "labos-select" });
    session.createEl("option", { value: "", text: "No historical session" });
    for (const item of this.sessionChoices) session.createEl("option", { value: item.session_id, text: (item.project ?? "Session") + " · " + item.started_at });
    const setup = row.createEl("select", { cls: "labos-select" });
    setup.createEl("option", { value: "", text: "No setup selected" });
    this.history.forEach((item, index) => setup.createEl("option", { value: String(index), text: item.timestamp + " · " + item.event_id.slice(-6) }));
    this.historicalSessionSelect = session;
    this.historicalSetupSelect = setup;
  }

  private selectedHistoricalSetup(): SetupSnapshot | undefined {
    const value = this.historicalSetupSelect?.value;
    return value ? this.history[Number(value)]?.setup : undefined;
  }

  private async pasteImages(event: ClipboardEvent, preview: HTMLElement): Promise<void> {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    const activeFile = this.app.workspace.getActiveFile();
    for (const file of files) {
      try {
        const path = await this.app.fileManager.getAvailablePathForAttachment(file.name, activeFile?.path);
        await this.app.vault.createBinary(path, await file.arrayBuffer());
        this.pendingImages.push({ title: file.name, path, kind: "image" });
        const image = preview.createEl("img", { cls: "labos-paste-preview", attr: { src: URL.createObjectURL(file), alt: file.name } });
        image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice("Could not save pasted image: " + message, 8000);
      }
    }
  }

  private async captureCheckpoint(
    state: "working" | "broken",
    textarea: HTMLTextAreaElement,
    tag?: string,
    occurredAt?: string,
  ): Promise<void> {
    const text = textarea.value.trim();
    await this.act(async () => {
      if (this.historicalSessionSelect?.value && !occurredAt) throw new Error("Choose an occurrence date/time before selecting a historical session.");
      const file = this.app.workspace.getActiveFile();
      const links = [...(file ? [{ title: file.basename, path: file.path }] : []), ...this.pendingImages];
      const event = await this.plugin.getBackend().checkpoint(state, text || undefined, {
        tag: tag || undefined,
        occurredAt: occurredAt ? new Date(occurredAt).toISOString()
          : !this.followsToday ? new Date(this.defaultOccurrence(this.selectedDay)).toISOString() : undefined,
        links,
        sessionId: this.historicalSessionSelect?.value || undefined,
        setup: (occurredAt || !this.followsToday) ? this.selectedHistoricalSetup() : undefined,
      });
      const logUpdated = await this.plugin.writeDailyLogForEvent(event);
      textarea.value = "";
      this.pendingImages = [];
      new Notice(!logUpdated
        ? "Checkpoint saved; daily log update failed. Use Retry log update."
        : state === "working" ? "Marked working." : "Marked broken.");
    });
  }

  private async linkVaultFile(file: TFile): Promise<void> {
    await this.act(async () => {
      const event = await this.plugin.getBackend().capture({
        text: "",
        links: [{ title: file.basename, path: file.path, kind: isPhoto(file) ? "image" : "note" }],
      });
      const logUpdated = await this.plugin.writeDailyLogForEvent(event);
      new Notice(logUpdated ? "Linked: " + file.name : "Linked, but the daily log update failed. Use Retry log update.");
    });
  }

  private async generateReport(
    mode: ReportMode,
    sessionId: string | undefined,
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
        this.updateProgressDisplay();
      },
    );
    this.reportTask = task;
    this.updateProgressDisplay();

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
      this.updateProgressDisplay();
      await this.refresh();
    }
  }

  private renderTimeline(
    container: HTMLElement,
    events: LabOSEvent[],
    session: SessionState | null,
    currentSetup: SetupSnapshot,
    assetMap: Record<string, string>,
  ): void {
    const section = container.createDiv({ cls: "labos-section" });
    section.createEl("h3", { text: this.selectedDay + " · Daily log" });

    const visible = events;

    if (visible.length === 0) {
      section.createDiv({
        cls: "labos-event-time",
        text: "No captured evidence yet.",
      });
      return;
    }

    for (const event of visible) {
      const row = section.createDiv({ cls: "labos-event" });
      const tagged = String(event.effective_payload?.tag ?? event.payload.tag ?? "");
      const definition = tagged ? this.dayTagColors.get(tagged) : undefined;
      if (definition) row.style.borderLeft = "3px solid " + definition;
      const head = row.createDiv({ cls: "labos-event-head" });
      head.createSpan({
        cls: "labos-event-kind",
        text: event.type.replaceAll("_", " "),
      });
      head.createSpan({
        cls: "labos-event-time",
        text: eventTime(String(event.payload.occurred_at ?? event.timestamp)),
      });
      const effective = (event as LabOSEvent & { effective_payload?: Record<string, unknown> }).effective_payload;
      const shown = effective ? { ...event, payload: effective } : event;
      row.createDiv({ text: eventText(shown) });
      if (event.type === "measurement") {
        const oldSetup = shown.payload.setup as SetupSnapshot | null | undefined;
        const changed = oldSetup ? JSON.stringify(oldSetup) !== JSON.stringify(currentSetup) : true;
        row.createDiv({ cls: "labos-event-time", text: changed ? "Original wiring context · not the current setup" : "Measured with the current setup" });
        if (oldSetup) {
          const details = row.createEl("details"); details.createEl("summary", { text: "Setup at measurement" });
          details.createEl("pre", { text: JSON.stringify(oldSetup, null, 2) });
        }
      }
      const links = Array.isArray(shown.payload.links) ? shown.payload.links as Array<{ title?: string; path?: string; kind?: string }> : [];
      for (const link of links) {
        if (!link.path) continue;
        let resolvedPath = link.path;
        const visited = new Set<string>();
        while (!visited.has(resolvedPath)) {
          const nextPath = assetMap[resolvedPath];
          if (!nextPath || nextPath === resolvedPath) break;
          visited.add(resolvedPath);
          resolvedPath = nextPath;
        }
        const file = this.app.vault.getFileByPath(resolvedPath);
        if (!file) { row.createDiv({ cls: "labos-warning", text: "Missing linked asset: " + (link.title ?? resolvedPath) }); continue; }
        if (link.kind === "image") row.createEl("img", { cls: "labos-paste-preview", attr: { src: this.app.vault.getResourcePath(file), alt: link.title ?? file.name } });
        const open = row.createEl("button", { text: "Open " + (link.title ?? file.name) });
        open.addEventListener("click", () => void this.app.workspace.getLeaf(false).openFile(file));
      }
      if (["note", "checkpoint", "measurement"].includes(event.type)) {
        const edit = row.createEl("button", { text: "Revise" });
        edit.addEventListener("click", () => { const oldText = String(shown.payload.text ?? ""); const value = window.prompt("Update entry text", oldText); if (value !== null && value !== oldText) void this.act(async () => this.plugin.getBackend().revise(event.id, { text: value })); });
        if (event.revision_history?.length) { const history = row.createEl("details"); history.createEl("summary", { text: "Revision history · " + String(event.revision_history.length) }); for (const revision of event.revision_history) history.createDiv({ text: revision.timestamp + " · " + JSON.stringify(revision.payload.changes) }); }
      }
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
