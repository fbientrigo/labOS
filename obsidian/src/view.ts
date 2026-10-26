import {
  FileSystemAdapter,
  FuzzySuggestModal,
  ItemView,
  Menu,
  Modal,
  Notice,
  normalizePath,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { relative } from "path";

import { renderDeviceKnowledge } from "./device_knowledge";
import { parseShorthand, type Shorthand } from "./shorthand";
import { ScopedDrafts } from "./scoped_drafts";
import type LabOSPlugin from "./main";
import { SetupPanel } from "./setup_panel";
import type { SetupPort } from "./setup_draft";
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

/** Rare tag chores live here so the day view stays compact. */
class TagsModal extends Modal {
  constructor(app: LabOSView["app"], private readonly plugin: LabOSPlugin, private readonly day: string, private readonly done: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Tags · " + this.day });
    const color = contentEl.createDiv({ cls: "labos-actions" });
    const name = color.createEl("input", { cls: "labos-input labos-grow", attr: { placeholder: "Tag name", "aria-label": "Tag name" } });
    const hex = color.createEl("input", { attr: { type: "color", "aria-label": "Tag color" } });
    hex.value = "#3388cc";
    const set = color.createEl("button", { text: "Set color" });
    set.addEventListener("click", () => {
      if (!name.value.trim()) { new Notice("Enter a tag name."); return; }
      void this.plugin.getBackend().setTag(this.day, name.value.trim(), hex.value).then(() => { this.done(); this.close(); }, (error: unknown) => new Notice(error instanceof Error ? error.message : String(error), 8000));
    });
    contentEl.createEl("h4", { text: "Rename a tag across this whole day (ignores list filters)" });
    const rename = contentEl.createDiv({ cls: "labos-actions" });
    const from = rename.createEl("input", { cls: "labos-input labos-grow", attr: { placeholder: "Old tag", "aria-label": "Old tag" } });
    const to = rename.createEl("input", { cls: "labos-input labos-grow", attr: { placeholder: "New tag", "aria-label": "New tag" } });
    const go = rename.createEl("button", { text: "Retag" });
    go.addEventListener("click", () => {
      if (!from.value.trim() || !to.value.trim()) { new Notice("Enter both tag names."); return; }
      void this.plugin.getBackend().retag(this.day, from.value.trim(), to.value.trim()).then(async () => {
        const updated = await this.plugin.writeDailyLogForDay(this.day);
        if (!updated) new Notice("Tags saved; daily Markdown log needs an update. Use Retry log update.", 8000);
        this.done(); this.close();
      }, (error: unknown) => new Notice(error instanceof Error ? error.message : String(error), 8000));
    });
  }

  onClose(): void {
    this.contentEl.empty();
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
  private refreshGeneration = 0;
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
  private setupPanel: SetupPanel;
  private currentWorkTag = "";
  private daySession = "";
  private dayTagColors = new Map<string, string>();
  private history: SetupHistoryItem[] = [];
  private sessionChoices: SessionChoice[] = [];
  private historicalSessionSelect: HTMLSelectElement | null = null;
  private historicalSetupSelect: HTMLSelectElement | null = null;
  /** UI state that must survive refresh(), which rebuilds the whole DOM. */
  private openSections = new Map<string, boolean>();
  private drafts = new ScopedDrafts();
  private draftScope = "quick";

  private measurementTargetsCache: { key: string; targets: string[] } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: LabOSPlugin,
  ) {
    super(leaf);
    this.setupPanel = new SetupPanel(plugin, () => this.refresh());
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
    const generation = ++this.refreshGeneration;
    const { contentEl } = this;
    const scrollTop = contentEl.scrollTop;
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
      if (generation !== this.refreshGeneration) return;
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

      const knownPorts = new Map<string, SetupPort[]>();
      if (this.page === "setup") {
        const loaded = await Promise.all(devices.map(async (device) => {
          try { return [device.resource_id, (await backend.deviceKnowledge(device.resource_id)).ports ?? []] as const; } catch { return null; /* Ports are optional context. */ }
        }));
        for (const entry of loaded) if (entry) knownPorts.set(entry[0], [...entry[1]]);
      }

      let measurementTargets = ["setup", ...devices.map((device) => device.alias)];
      if (this.page !== "today") this.measurementTargetsCache = null; // Device edits happen elsewhere; rebuild on return.
      if (this.page === "today") {
        const key = devices.map((device) => device.resource_id + "=" + device.alias).sort().join("|");
        if (this.measurementTargetsCache?.key === key) {
          measurementTargets = this.measurementTargetsCache.targets;
        } else {
          const rails = await Promise.all(devices.map(async (device) => {
            try {
              const profileKnowledge = await backend.deviceKnowledge(device.resource_id);
              return profileKnowledge.power_profiles.flatMap((profile) => profile.rails.map((rail) => device.alias + " / " + rail.label));
            } catch { return []; /* Power profiles are optional context. */ }
          }));
          measurementTargets.push(...rails.flat());
          this.measurementTargetsCache = { key, targets: measurementTargets };
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
        this.setupPanel.render(contentEl, session !== null, devices, setup, history.length ? history[history.length - 1]!.event_id : "", knownPorts);
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
      if (generation !== this.refreshGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      contentEl.createDiv({ cls: "labos-error", text: message });
    }
    if (generation === this.refreshGeneration) contentEl.scrollTop = scrollTop;
  }

  /** `<details>` whose open/closed state survives refresh(). */
  private disclosure(parent: HTMLElement, key: string, summary: string | ((el: HTMLElement) => void), defaultOpen = false, cls = "labos-more"): HTMLDetailsElement {
    const details = parent.createEl("details", { cls });
    details.open = this.openSections.get(key) ?? defaultOpen;
    const head = details.createEl("summary");
    if (typeof summary === "string") head.setText(summary);
    else summary(head);
    details.addEventListener("toggle", () => { this.openSections.set(key, details.open); });
    return details;
  }

  /** Keep an input's text across refresh(); cleared by `this.drafts.delete(key)` after a save. */
  private bindDraft(input: HTMLInputElement | HTMLTextAreaElement, key: string): void {
    const scope = this.draftScope;
    input.dataset.draftScope = scope;
    input.dataset.draftField = key;
    const saved = this.drafts.field(scope, key);
    if (saved !== undefined) input.value = saved;
    input.addEventListener("input", () => { this.drafts.setField(scope, key, input.value); });
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
    const menuButton = headerActions.createEl("button", {
      text: "☰",
      attr: { "aria-label": "LabOS menu", "aria-haspopup": "menu", title: "Tags, notes, setup check" },
    });
    menuButton.addEventListener("click", (event) => {
      const menu = new Menu();
      menu.addItem((item) => item.setTitle("Open today's log").setIcon("book-open").onClick(() => { void this.act(() => this.plugin.openDailyLog()); }));
      menu.addItem((item) => item.setTitle("Write today's log").setIcon("file-pen").onClick(() => { void this.act(() => this.plugin.writeTodayLog()); }));
      menu.addItem((item) => item.setTitle("Rebuild note index").setIcon("database").onClick(() => { void this.act(() => this.plugin.rebuildIndex()); }));
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Tag colors and retag…").setIcon("tag").onClick(() => { new TagsModal(this.app, this.plugin, this.selectedDay, () => void this.refresh()).open(); }));
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Check setup").setIcon("stethoscope").onClick(() => { void this.runDoctor(menuButton); }));
      menu.addItem((item) => item.setTitle("Refresh").setIcon("refresh-cw").onClick(() => { void this.refresh(); }));
      menu.showAtMouseEvent(event);
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
      if (this.page === page) button.setAttribute("aria-current", "page");
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
    this.draftScope = session ? "session:" + session.session_id : "day:" + this.selectedDay;
    if (session) {
      this.renderActiveSession(container, session, record, devices, measurementTargets, tags);
    } else {
      this.renderStart(container, devices, setup);
    }
    this.renderNotes(container, session);
    this.renderDayControls(container, events, tags, colorSuggestions);
    if (!session) {
      const quick = container.createDiv({ cls: "labos-section labos-stack" });
      quick.createEl("h3", { text: "Quick note" });
      this.renderComposer(quick, tags, {
        placeholder: "Observation (works without a session)",
        primaryLabel: "Capture note",
        defaultOccurrence: this.defaultOccurrence(this.selectedDay),
      });
    }
    this.renderTimeline(container, events, session, setup, assetMap);
    this.renderPager(container, events);
  }

  /** One compact row: make or connect a note, sync it, and open the notes of this session. */
  private renderNotes(container: HTMLElement, session: SessionState | null): void {
    const section = container.createDiv({ cls: "labos-section labos-stack" });
    const row = section.createDiv({ cls: "labos-actions" });
    const notes = this.plugin.notes;
    row.createEl("button", { text: "New session note", attr: { title: "Create today's note in your notes folder and connect it" } })
      .addEventListener("click", () => { void this.act(() => notes.createSessionNote()); });
    row.createEl("button", { text: "Connect note", attr: { title: "Connect the open note to this session" } })
      .addEventListener("click", () => { void this.act(() => notes.connectActive()); });
    row.createEl("button", { text: "Sync note", attr: { title: "Save edits made in the open note as LabOS revisions" } })
      .addEventListener("click", () => { void this.act(() => notes.sync(this.app.workspace.getActiveFile())); });
    const connected = notes.connectedNotes(session?.session_id);
    if (session && connected.length) {
      const list = section.createDiv({ cls: "labos-muted" });
      list.createSpan({ text: "Notes: " });
      connected.forEach((file, index) => {
        if (index) list.createSpan({ text: " · " });
        const link = list.createEl("a", { text: file.basename, attr: { title: file.path } });
        link.addEventListener("click", () => { void notes.open(file); });
      });
    }
  }

  private renderPendingMarkdown(container: HTMLElement): void {
    if (!this.plugin.hasPendingLogUpdates) return;
    const row = container.createDiv({ cls: "labos-warning labos-actions", text: "Evidence is saved; a daily Markdown log update needs retry." });
    const retry = row.createEl("button", { text: "Retry log update" });
    retry.addEventListener("click", () => void this.plugin.retryDailyLogs());
  }

  private async captureWithMarkdown(input: Parameters<LabOSBackend["capture"]>[0]): Promise<LabOSEvent> {
    const event = await this.plugin.getBackend().capture(input);
    const logUpdated = await this.plugin.writeDailyLogForEvent(event);
    if (!logUpdated) new Notice("Evidence saved; daily Markdown log needs an update. Use Retry log update.", 10000);
    return event;
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
    const section = container.createDiv({ cls: "labos-section labos-stack" });
    const goToDay = (day: string, follows = false): void => {
      this.selectedDay = day;
      this.followsToday = follows;
      this.dayOffset = 0;
      void this.refresh();
    };
    const shiftDay = (delta: number): void => {
      const date = new Date(this.selectedDay + "T12:00:00");
      date.setDate(date.getDate() + delta);
      goToDay(date.toLocaleDateString("en-CA"));
    };

    const row = section.createDiv({ cls: "labos-actions" });
    row.createEl("button", { text: "‹", attr: { "aria-label": "Previous day" } }).addEventListener("click", () => shiftDay(-1));
    const picker = row.createEl("input", { attr: { type: "date", "aria-label": "Day" } });
    picker.value = this.selectedDay;
    picker.addEventListener("change", () => goToDay(picker.value));
    row.createEl("button", { text: "›", attr: { "aria-label": "Next day" } }).addEventListener("click", () => shiftDay(1));
    row.createEl("button", { text: "Today" }).addEventListener("click", () => goToDay(new Date().toLocaleDateString("en-CA"), true));
    const search = row.createEl("input", { cls: "labos-input labos-grow", attr: { placeholder: "Search this day", "aria-label": "Search this day" } });
    search.value = this.daySearch;
    search.addEventListener("change", () => { this.daySearch = search.value.trim(); this.dayOffset = 0; void this.refresh(); });

    const active = Boolean(this.dayTag || this.daySession);
    const more = this.disclosure(section, "day-filters", active ? "Filters & tags (active)" : "Filters & tags", active);
    const body = more.createDiv({ cls: "labos-stack" });

    const filters = body.createDiv({ cls: "labos-actions" });
    const tag = filters.createEl("select", { cls: "labos-select", attr: { "aria-label": "Filter by tag" } });
    tag.createEl("option", { value: "", text: "All tags" });
    for (const value of Array.from(new Set([...tagDefinitions.map((item) => item.name), ...colorSuggestions.map((item) => item.name), ...entries.map((event) => String(event.payload.tag ?? ""))].filter(Boolean)))) tag.createEl("option", { value, text: value });
    tag.value = this.dayTag;
    tag.addEventListener("change", () => { this.dayTag = tag.value; this.dayOffset = 0; void this.refresh(); });
    const session = filters.createEl("select", { cls: "labos-select", attr: { "aria-label": "Filter by session" } });
    session.createEl("option", { value: "", text: "All sessions" });
    for (const item of this.sessionChoices) session.createEl("option", { value: item.session_id, text: (item.project ?? "Session") + " · " + item.started_at });
    session.value = this.daySession;
    session.addEventListener("change", () => { this.daySession = session.value; this.dayOffset = 0; void this.refresh(); });
  }

  private renderPager(container: HTMLElement, entries: LabOSEvent[]): void {
    if (this.dayOffset === 0 && entries.length < 100) return;
    const row = container.createDiv({ cls: "labos-actions labos-section" });
    if (this.dayOffset > 0) {
      row.createEl("button", { text: "Newer entries" }).addEventListener("click", () => { this.dayOffset = Math.max(0, this.dayOffset - 100); void this.refresh(); });
    }
    const older = row.createEl("button", { text: "Older entries" });
    older.disabled = entries.length < 100;
    older.addEventListener("click", () => { this.dayOffset += 100; void this.refresh(); });
  }

  private renderStart(container: HTMLElement, devices: DeviceResource[], lastSetup: { devices: Array<Record<string, unknown>>; connections: Array<Record<string, unknown>> }): void {
    const outer = container.createDiv({ cls: "labos-section labos-stack" });
    outer.createEl("h3", { text: "Start work" });
    const previous = [...this.sessionChoices].filter((item) => item.project).sort((x, y) => y.started_at.localeCompare(x.started_at))[0];
    if (previous) {
      const again = outer.createEl("button", {
        cls: "mod-cta",
        text: "Continue: " + String(previous.project) + (previous.label ? " · " + previous.label : ""),
        attr: { title: "Same project, directory and last recorded setup" },
      });
      again.addEventListener("click", () => {
        void this.act(async () => {
          await this.plugin.getBackend().start(String(previous.project), previous.label || undefined, previous.cwd || undefined, lastSetup);
          new Notice("LabOS continued: " + String(previous.project));
        });
      });
    }
    const section = this.disclosure(outer, "start-new", previous ? "New work…" : "Start options", !previous).createDiv({ cls: "labos-stack" });

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

    const head = section.createDiv({ cls: "labos-session-head" });
    const title = head.createDiv();
    title.createEl("h3", { text: session.project });
    if (session.label) {
      title.createDiv({ text: session.label });
    }
    title.createDiv({
      cls: "labos-event-time",
      text:
        "Started " +
        new Date(session.started_at).toLocaleString() +
        (session.started_cwd ? " · " + session.started_cwd : ""),
    });
    const end = head.createEl("button", { cls: "mod-warning", text: "End work" });
    end.addEventListener("click", () => {
      void this.act(async () => {
        await this.plugin.getBackend().end();
        new Notice("LabOS session ended.");
      });
    });

    const composer = this.renderComposer(section, tags, {
      placeholder: "Note… (#tag · !ok · !broken · !m 12mA @rail)",
      primaryLabel: "Add note",
      active: true,
    });
    this.renderMeasurement(section, measurementTargets, composer);
    this.renderActiveDevices(section, record, devices);
  }

  /**
   * Note box shared by the active session and the no-session quick note.
   * Common path (text, tag, save) is always visible; date, historical
   * session/setup and vault links sit under "More options".
   */
  private renderComposer(
    parent: HTMLElement,
    tags: Array<{ name: string; color: string }>,
    opts: { placeholder: string; primaryLabel: string; defaultOccurrence?: string; active?: boolean },
  ): { textarea: HTMLTextAreaElement; tag: HTMLSelectElement; occurrence: HTMLInputElement } {
    const textarea = parent.createEl("textarea", {
      cls: "labos-textarea",
      attr: { placeholder: opts.placeholder, "aria-label": "Note text" },
    });
    this.bindDraft(textarea, "note");
    const hint = parent.createDiv({ cls: "labos-muted labos-composer-hint", attr: { "aria-live": "polite" } });
    const preview = parent.createDiv({ cls: "labos-image-previews" });
    const imageScope = this.draftScope;
    this.renderDraftImages(preview, imageScope);
    textarea.addEventListener("paste", (event) => void this.pasteImages(event, preview, imageScope));

    const row = parent.createDiv({ cls: "labos-composer-row" });
    const tag = this.createWorkTagSelector(row, tags);

    const more = this.disclosure(parent, "composer-more", "More options");
    const body = more.createDiv({ cls: "labos-stack" });
    const occurrence = body.createEl("input", {
      cls: "labos-input",
      attr: { type: "datetime-local", "aria-label": "Occurrence date and time" },
    });
    if (opts.defaultOccurrence) occurrence.value = opts.defaultOccurrence;
    this.renderHistoricalControls(body);

    // Shorthand commands (!ok, !broken, !m …) need an active session; #tag works everywhere.
    const parse = (): Shorthand => {
      const parsed = parseShorthand(textarea.value);
      if (opts.active || !parsed.ok || parsed.kind === "note") return parsed;
      return { ok: true, kind: "note", text: textarea.value.trim(), tag: parsed.tag };
    };
    const describe = (parsed: Shorthand): string => {
      if (!parsed.ok) return parsed.error;
      const tagText = parsed.tag ? " · #" + parsed.tag : "";
      if (parsed.kind === "measurement") {
        return "Saves as measurement · " + String(parsed.current) + " " + parsed.unit + (parsed.voltage !== undefined ? " · " + String(parsed.voltage) + " V" : "") + " · @" + parsed.target + tagText;
      }
      if (parsed.kind === "checkpoint") return "Saves as " + (parsed.state === "working" ? "✓ working" : "✗ broken") + tagText;
      return "";
    };
    const updateHint = (): void => { hint.setText(describe(parse())); };
    textarea.addEventListener("input", updateHint);
    updateHint();

    const save = (): void => {
      const parsed = parse();
      if (!parsed.ok) {
        new Notice(parsed.error);
        return;
      }
      const tagValue = parsed.tag ?? tag.value;
      if (parsed.kind === "measurement") {
        const submittedText = textarea.value;
        void this.saveMeasurement(parsed, tagValue, occurrence.value, () => this.clearDraftOf(textarea, submittedText), imageScope);
      } else if (parsed.kind === "checkpoint") {
        void this.captureCheckpoint(parsed.state, textarea, tagValue, occurrence.value, parsed.text, imageScope);
      } else {
        void this.captureNote(textarea, tagValue, occurrence.value, this.historicalSessionSelect?.value, this.selectedHistoricalSetup(), imageScope);
      }
    };
    const primary = row.createEl("button", { cls: "mod-cta", text: opts.primaryLabel });
    primary.addEventListener("click", save);

    if (opts.active) {
      for (const [state, label] of [
        ["working", "✓ Working"],
        ["broken", "✗ Broken"],
      ] as const) {
        const button = row.createEl("button", { text: label });
        button.addEventListener("click", () => {
          void this.captureCheckpoint(state, textarea, tag.value, occurrence.value, undefined, imageScope);
        });
      }
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          save();
        }
      });

      const links = body.createDiv({ cls: "labos-actions" });
      links.createEl("button", { text: "Link current note" }).addEventListener("click", () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active vault file.");
          return;
        }
        void this.linkVaultFile(file);
      });
      links.createEl("button", { text: "Link vault file" }).addEventListener("click", () => {
        new VaultFilePicker(this.app, (file) => {
          void this.linkVaultFile(file);
        }).open();
      });
    }
    return { textarea, tag, occurrence };
  }

  private saveMeasurement(
    m: { text: string; target: string; current: number; unit: "A" | "mA"; voltage?: number },
    tag: string,
    occurrenceValue: string,
    onSaved: () => void,
    imageScope = this.draftScope,
  ): Promise<void> {
    const draftImages = [...this.drafts.images(imageScope)];
    return this.act(async () => {
      const activeFile = this.app.workspace.getActiveFile();
      const links = [...(activeFile ? [{ title: activeFile.basename, path: activeFile.path }] : []), ...draftImages];
      const occurrence = occurrenceValue || (!this.followsToday ? this.defaultOccurrence(this.selectedDay) : undefined);
      await this.captureWithMarkdown({
        kind: "measurement",
        text: m.text,
        tag: tag || undefined,
        target: m.target || "setup",
        current: m.current,
        unit: m.unit,
        voltage: m.voltage,
        occurredAt: occurrence ? new Date(occurrence).toISOString() : undefined,
        links,
        sessionId: this.historicalSessionSelect?.value || undefined,
        setup: this.selectedHistoricalSetup(),
      });
      this.drafts.removeImages(imageScope, draftImages);
      onSaved();
    });
  }

  private renderMeasurement(
    parent: HTMLElement,
    measurementTargets: string[],
    composer: { tag: HTMLSelectElement; occurrence: HTMLInputElement },
  ): void {
    const more = this.disclosure(parent, "measurement", "Record measurement");
    const measure = more.createDiv({ cls: "labos-stack" });
    const target = measure.createEl("input", {
      cls: "labos-input",
      attr: { placeholder: "Whole setup, device, or named rail", list: "labos-measure-targets", "aria-label": "Measurement target" },
    });
    const targetList = measure.createEl("datalist", { attr: { id: "labos-measure-targets" } });
    for (const value of measurementTargets) targetList.createEl("option", { value });
    target.value = "setup";
    this.bindDraft(target, "m.target");

    const grid = measure.createDiv({ cls: "labos-measure-grid" });
    const currentInput = grid.createEl("input", {
      cls: "labos-input",
      attr: { type: "number", min: "0", step: "any", placeholder: "Current", "aria-label": "Current" },
    });
    this.bindDraft(currentInput, "m.current");
    const unit = grid.createEl("select", { cls: "labos-select", attr: { "aria-label": "Current unit" } });
    unit.createEl("option", { value: "mA", text: "mA" });
    unit.createEl("option", { value: "A", text: "A" });
    const measurementScope = this.draftScope;
    unit.value = this.drafts.field(measurementScope, "m.unit") ?? "mA";
    unit.addEventListener("change", () => { this.drafts.setField(measurementScope, "m.unit", unit.value); });
    const voltage = grid.createEl("input", {
      cls: "labos-input",
      attr: { type: "number", step: "any", placeholder: "Voltage (optional)", "aria-label": "Voltage" },
    });
    this.bindDraft(voltage, "m.voltage");

    const note = measure.createEl("textarea", {
      cls: "labos-textarea",
      attr: { placeholder: "Measurement note", "aria-label": "Measurement note" },
    });
    this.bindDraft(note, "m.note");
    const preview = measure.createDiv({ cls: "labos-image-previews" });
    const imageScope = this.draftScope + ":measurement";
    this.renderDraftImages(preview, imageScope);
    note.addEventListener("paste", (event) => void this.pasteImages(event, preview, imageScope));

    const capture = measure.createEl("button", { text: "Capture measurement" });
    capture.addEventListener("click", () => {
      const value = Number(currentInput.value);
      if (!currentInput.value || !Number.isFinite(value)) {
        new Notice("Enter a valid current value.");
        return;
      }
      const submittedFields = [currentInput, voltage, note, target, unit].map((input) => [input, input.value] as const);
      void this.saveMeasurement(
        {
          text: note.value,
          target: target.value,
          current: value,
          unit: unit.value as "A" | "mA",
          voltage: voltage.value ? Number(voltage.value) : undefined,
        },
        composer.tag.value,
        composer.occurrence.value,
        () => { for (const [input, value] of submittedFields) this.clearDraftFieldIfUnchanged(input, value); },
        imageScope,
      );
    });
  }

  private renderActiveDevices(
    container: HTMLElement,
    record: SessionRecordResult | null,
    devices: DeviceResource[],
  ): void {
    const activeSnapshots = record?.record.resource_context?.active_at_end ?? [];
    const activeIds = new Set(activeSnapshots.map((item) => item.resource_id));

    const block = this.disclosure(container, "active-devices", "Devices in this work (" + String(activeSnapshots.length) + ")", activeSnapshots.length === 0);
    const head = block.createDiv({ cls: "labos-actions" });

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
      const deviceDraftKey = "device:" + device.resource_id + ":session:" + session.session_id + ":note";
      capture.dataset.draftScope = "device:" + device.resource_id + ":session:" + session.session_id + ":note";
      capture.dataset.draftField = "text";
      const savedDeviceDraft = this.drafts.field(capture.dataset.draftScope, "text");
      if (savedDeviceDraft !== undefined) capture.value = savedDeviceDraft;
      capture.addEventListener("input", () => this.drafts.setField(capture.dataset.draftScope!, "text", capture.value));
      const actions = section.createDiv({ cls: "labos-actions" });
      const note = actions.createEl("button", { text: "Add note" });
      note.addEventListener("click", () => {
        void this.captureNote(capture, undefined, undefined, undefined, undefined, "device:" + device.resource_id + ":session:" + session.session_id);
      });
      const good = actions.createEl("button", { text: "✓ Working" });
      good.addEventListener("click", () => {
        void this.captureCheckpoint("working", capture, undefined, undefined, undefined, "device:" + device.resource_id + ":session:" + session.session_id);
      });
      const bad = actions.createEl("button", { text: "✗ Broken" });
      bad.addEventListener("click", () => {
        void this.captureCheckpoint("broken", capture, undefined, undefined, undefined, "device:" + device.resource_id + ":session:" + session.session_id);
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
      addPort: (input) =>
        this.act(async () => {
          await this.plugin.getBackend().addDevicePort(device.resource_id, input);
        }),
      editPort: (portId, input) =>
        this.act(async () => {
          await this.plugin.getBackend().editDevicePort(device.resource_id, portId, input);
        }),
      removePort: (portId) =>
        this.act(async () => {
          await this.plugin.getBackend().removeDevicePort(device.resource_id, portId);
        }),
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
    const items = result.record.coverage.items;
    const present = items.filter((item) => item.state === "present").length;
    const section = this.disclosure(container, "coverage", (summary) => {
      summary.createSpan({ text: "Evidence coverage · " + String(present) + "/" + String(items.length) + " recorded " });
      summary.createSpan({
        cls: "labos-event-time",
        text: result.evidence_sha256.slice(0, 12),
        attr: { title: result.evidence_sha256 },
      });
    }, false, "labos-more labos-section");

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

  private clearDraftOf(textarea: HTMLTextAreaElement, expectedValue = textarea.value): void {
    this.clearDraftFieldIfUnchanged(textarea, expectedValue);
  }

  private clearDraftFieldIfUnchanged(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, expectedValue = input.value): void {
    const scope = input.dataset.draftScope;
    const field = input.dataset.draftField;
    if (scope && field) this.drafts.clearFieldIfValue(scope, field, expectedValue);
    if (input.value === expectedValue) input.value = "";
  }

  private async captureNote(textarea: HTMLTextAreaElement, tag?: string, occurredAt?: string, sessionId?: string, setup?: SetupSnapshot, imageScope = this.draftScope): Promise<void> {
    const draftText = textarea.value;
    const text = draftText.trim();
    if (!text) {
      return;
    }
    const draftImages = [...this.drafts.images(imageScope)];
    await this.act(async () => {
      const activeFile = this.app.workspace.getActiveFile();
      const links = [
        ...(activeFile ? [{ title: activeFile.basename, path: activeFile.path }] : []),
        ...draftImages,
      ];
      const occurrence = occurredAt || (!this.followsToday ? this.defaultOccurrence(this.selectedDay) : undefined);
      const event = await this.captureWithMarkdown({ text, tag: tag || undefined, occurredAt: occurrence ? new Date(occurrence).toISOString() : undefined, links, sessionId: sessionId || undefined, setup });
      if (!occurrence && !sessionId) await this.plugin.notes.appendQuick(event, text);
      this.drafts.removeImages(imageScope, draftImages);
      this.clearDraftOf(textarea, draftText);
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

  private async pasteImages(event: ClipboardEvent, preview: HTMLElement, imageScope = this.draftScope): Promise<void> {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    const activeFile = this.app.workspace.getActiveFile();
    for (const file of files) {
      try {
        const path = await this.app.fileManager.getAvailablePathForAttachment(file.name, activeFile?.path);
        await this.app.vault.createBinary(path, await file.arrayBuffer());
        const draftImage = { title: file.name, path, kind: "image" };
        this.drafts.addImage(imageScope, draftImage);
        this.renderDraftImage(preview, imageScope, draftImage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice("Could not save pasted image: " + message, 8000);
      }
    }
  }

  private renderDraftImages(preview: HTMLElement, imageScope: string): void {
    for (const image of this.drafts.images(imageScope)) this.renderDraftImage(preview, imageScope, image);
  }

  private renderDraftImage(preview: HTMLElement, imageScope: string, image: { title: string; path: string; kind: string }): void {
    if (image.kind !== "image") return;
    const file = this.app.vault.getAbstractFileByPath(image.path);
    if (!(file instanceof TFile)) return;
    const item = preview.createDiv({ cls: "labos-image-preview-item" });
    item.createEl("img", { cls: "labos-paste-preview", attr: { src: this.app.vault.getResourcePath(file), alt: image.title } });
    item.createEl("button", { text: "Remove", attr: { type: "button", "aria-label": "Remove " + image.title + " from this entry" } })
      .addEventListener("click", () => { this.drafts.removeImages(imageScope, [image]); item.remove(); });
  }

  private async captureCheckpoint(
    state: "working" | "broken",
    textarea: HTMLTextAreaElement,
    tag?: string,
    occurredAt?: string,
    textOverride?: string,
    imageScope = this.draftScope,
  ): Promise<void> {
    const draftText = textarea.value;
    const text = (textOverride ?? draftText).trim();
    const draftImages = [...this.drafts.images(imageScope)];
    await this.act(async () => {
      if (this.historicalSessionSelect?.value && !occurredAt) throw new Error("Choose an occurrence date/time before selecting a historical session.");
      const file = this.app.workspace.getActiveFile();
      const links = [...(file ? [{ title: file.basename, path: file.path }] : []), ...draftImages];
      const event = await this.plugin.getBackend().checkpoint(state, text || undefined, {
        tag: tag || undefined,
        occurredAt: occurredAt ? new Date(occurredAt).toISOString()
          : !this.followsToday ? new Date(this.defaultOccurrence(this.selectedDay)).toISOString() : undefined,
        links,
        sessionId: this.historicalSessionSelect?.value || undefined,
        setup: (occurredAt || !this.followsToday) ? this.selectedHistoricalSetup() : undefined,
      });
      const historical = Boolean(occurredAt || !this.followsToday || this.historicalSessionSelect?.value);
      const skipped = await this.plugin.fingerprintCheckpoint(event.id, historical);
      const logUpdated = await this.plugin.writeDailyLogForEvent(event);
      this.clearDraftOf(textarea, draftText);
      this.drafts.removeImages(imageScope, draftImages);
      new Notice(!logUpdated
        ? "Checkpoint saved; daily log update failed. Use Retry log update."
        : skipped.length ? "Checkpoint saved; not fingerprinted: " + skipped.join(", ")
        : state === "working" ? "Marked working." : "Marked broken.", skipped.length ? 8000 : undefined);
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
        edit.addEventListener("click", () => { const oldText = String(shown.payload.text ?? ""); const value = window.prompt("Update entry text", oldText); if (value !== null && value !== oldText) void this.act(async () => {
          await this.plugin.getBackend().revise(event.id, { text: value });
          const updated = await this.plugin.writeDailyLogForEvent(event);
          if (!updated) new Notice("Revision saved; daily Markdown log needs an update. Use Retry log update.", 8000);
        }); });
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
