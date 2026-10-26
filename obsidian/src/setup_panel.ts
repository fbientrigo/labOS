import { App, FuzzySuggestModal, Notice } from "obsidian";

import type LabOSPlugin from "./main";
import { SetupEditor, type SetupPort, portsChanged, refreshPorts, addDevice, connect, deviceId, disconnect, findDevice, moveDevice, removeDevice, replaceDevice, setActivation, setEdgeLabels, setMode, linksOf, bindEdgePort, type SetupConnection, type SetupDoc } from "./setup_draft";
import type { DeviceResource, SetupSnapshot } from "./types";
class SetupDevicePicker extends FuzzySuggestModal<DeviceResource> {
  constructor(
    app: App,
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


/** Owns the setup draft and its interactive editor UI. */
export class SetupPanel {
  private setupEditor: SetupEditor | null = null;
  private setupRoot: HTMLElement | null = null;
  private selectedEdge: SetupConnection | null = null;
  private setupCtx: { active: boolean; devices: DeviceResource[]; latestEventId: string; knownPorts: Map<string, SetupPort[]> } | null = null;
  private selectedCardId: string | null = null;

  constructor(private readonly plugin: LabOSPlugin, private readonly refreshView: () => Promise<void>) {}

  private get app(): App { return this.plugin.app; }
  render(container: HTMLElement, active: boolean, devices: DeviceResource[], setup: SetupSnapshot, latestEventId: string, knownPorts: Map<string, SetupPort[]>): void {
    const persisted = setup as unknown as Partial<SetupDoc>;
    if (!this.setupEditor) this.setupEditor = new SetupEditor(persisted, latestEventId);
    else this.setupEditor.rebase(persisted, latestEventId);
    this.setupCtx = { active, devices, latestEventId, knownPorts };
    this.setupRoot = container.createDiv({ cls: "labos-section labos-stack" });
    this.drawSetup();
  }

  /** Synchronous local redraw of the setup page from the draft. Never touches the backend. */
  private drawSetup(): void {
    const root = this.setupRoot;
    const ctx = this.setupCtx;
    const editor = this.setupEditor;
    if (!root || !ctx || !editor) return;
    const draft = editor.draft;
    root.empty();
    if (this.selectedCardId && !findDevice(draft, this.selectedCardId)) this.selectedCardId = null;

    const head = root.createDiv({ cls: "labos-setup-head" });
    head.createEl("h2", { text: "Hardware setup" });
    const bar = head.createDiv({ cls: "labos-setup-commitbar" });
    const stale = editor.isStale(ctx.latestEventId);
    if (editor.dirty) bar.createSpan({ cls: "labos-setup-dirty", text: "● Unsaved changes" });
    const discard = bar.createEl("button", { text: "Discard changes" });
    discard.disabled = !editor.dirty || editor.committing;
    discard.addEventListener("click", () => { editor.discard(); this.drawSetup(); });
    const commit = bar.createEl("button", { cls: "mod-cta", text: editor.committing ? "Committing…" : "Commit setup" });
    commit.disabled = !editor.dirty || !ctx.active || editor.committing || stale;
    commit.addEventListener("click", () => void this.commitSetup());

    root.createDiv({ cls: "labos-muted", text: "Edits here are a local draft. Nothing is recorded until you press Commit setup." });
    if (!ctx.active) root.createDiv({ cls: "labos-warning", text: "Start a session to commit setup changes. You can still prepare a draft." });
    if (stale) root.createDiv({ cls: "labos-warning", text: "The recorded setup changed since you started editing. Discard changes to continue from the latest setup." });

    const canvas = root.createDiv({ cls: "labos-setup-canvas" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "labos-setup-wires");
    canvas.appendChild(svg);
    const cards = new Map<string, HTMLElement>();
    const handles = new Map<string, HTMLElement>();
    const handleKey = (resourceId: string, portId: string | undefined): string => resourceId + "|" + (portId ?? "");

    for (const [index, item] of draft.devices.entries()) {
      const id = deviceId(item) || String(index);
      const card = canvas.createDiv({ cls: "labos-setup-card" });
      card.dataset.id = id;
      cards.set(id, card);
      if (this.selectedCardId === id) card.addClass("labos-setup-selected");
      card.style.left = String(item.x ?? 16 + index * 150) + "px";
      card.style.top = String(item.y ?? 16) + "px";
      card.createEl("strong", { text: String(item.alias ?? item.name ?? id) });
      card.createDiv({ cls: "labos-muted", text: String(item.kind ?? "device") });
      const current = ctx.knownPorts.get(id);
      if (current && portsChanged(item, current)) {
        const update = card.createEl("button", { cls: "labos-setup-portsupdate", text: "Device ports changed · Update", attr: { type: "button", title: "Adopt the device's current port definitions in this draft" } });
        update.addEventListener("click", (event) => {
          event.stopPropagation();
          const orphans = refreshPorts(draft, id, current);
          if (orphans.length) new Notice(String(orphans.length) + " connected port(s) no longer exist in the device definition and were kept.");
          this.drawSetup();
        });
      }
      const color = this.plugin.settings.deviceColors[id];
      if (color) card.style.borderLeft = "5px solid " + color;
      // A device without defined ports gets one unlabeled connection dot, never an invented port name.
      const ports: Array<{ port_id?: string; label: string }> = item.ports && item.ports.length ? item.ports : [{ label: "" }];
      for (const port of ports) {
        const row = card.createDiv({ cls: "labos-setup-port" });
        if (port.label) row.createSpan({ cls: "labos-setup-port-label", text: port.label });
        const handle = row.createEl("button", { cls: "labos-setup-handle", text: "●", attr: { type: "button", title: port.label ? "Drag to another port to connect: " + port.label : "Drag to another device to connect" } });
        handle.dataset.resource = id;
        handle.dataset.port = port.port_id ?? "";
        handles.set(handleKey(id, port.port_id), handle);
        handle.addEventListener("pointerdown", (event) => this.startConnectDrag(event, canvas, svg, cards, handles, id, port));
      }
      for (const link of linksOf(draft, id)) {
        const own = link.ownPort ? link.ownPort + " " : "";
        const far = link.otherPort ? " · " + link.otherPort : "";
        card.createDiv({ cls: "labos-setup-link", text: own + "→ " + link.otherAlias + far });
      }
      card.addEventListener("click", () => {
        if (this.selectedCardId === id) return;
        this.selectedCardId = id;
        this.drawSetup();
      });
      card.addEventListener("pointerdown", (event) => this.startCardDrag(event, card, canvas, svg, cards, handles, id));
    }
    this.drawSetupWires(canvas, svg, draft, cards, handles);

    const controls = root.createDiv({ cls: "labos-actions" });
    const add = controls.createEl("button", { text: "+ Add device" });
    add.addEventListener("click", () => {
      const available = ctx.devices.filter((device) => !findDevice(draft, device.resource_id));
      if (!ctx.devices.length) { new Notice("No registered devices. Register one on the Devices page first."); return; }
      if (!available.length) { new Notice("Every registered device is already in the setup."); return; }
      new SetupDevicePicker(this.app, available, (device) => {
        if (addDevice(draft, device, ctx.knownPorts.get(device.resource_id))) this.drawSetup();
      }, "Add a device to the setup...").open();
    });

    const selected = this.selectedCardId ? findDevice(draft, this.selectedCardId) : undefined;
    if (selected) {
      const selectedId = deviceId(selected);
      const bar2 = root.createDiv({ cls: "labos-setup-selectedbar" });
      bar2.createEl("strong", { text: "Selected: " + String(selected.alias ?? selectedId) });
      const activation = bar2.createEl("select", { cls: "labos-select" });
      for (const value of ["unknown", "active", "inactive"]) activation.createEl("option", { value, text: value });
      activation.value = String(selected.activation ?? "unknown");
      activation.addEventListener("change", () => { setActivation(draft, selectedId, activation.value); this.drawSetup(); });
      const colorInput = bar2.createEl("input", { attr: { type: "color", title: "Device color", "aria-label": "Device color" } });
      colorInput.value = this.plugin.settings.deviceColors[selectedId] ?? "#3388cc";
      colorInput.addEventListener("change", () => {
        this.plugin.settings.deviceColors[selectedId] = colorInput.value;
        void this.plugin.saveData(this.plugin.settings).then(() => this.drawSetup());
      });
      const mode = bar2.createEl("input", { cls: "labos-input", attr: { placeholder: "Operating mode (optional)" } });
      mode.value = String(selected.mode ?? "");
      mode.addEventListener("change", () => { setMode(draft, selectedId, mode.value); this.drawSetup(); });
      const replace = bar2.createEl("button", { text: "Replace device" });
      replace.addEventListener("click", () => {
        const available = ctx.devices.filter((device) => !findDevice(draft, device.resource_id));
        if (!available.length) { new Notice("No other registered device is available."); return; }
        new SetupDevicePicker(this.app, available, (device) => {
          const result = replaceDevice(draft, selectedId, device, ctx.knownPorts.get(device.resource_id));
          if (!result.ok) { new Notice("Could not replace this device."); return; }
          if (result.dropped) new Notice(String(result.dropped) + " connection(s) could not be kept and were removed from the draft.");
          this.selectedCardId = device.resource_id;
          this.drawSetup();
        }, "Replace " + String(selected.alias ?? selectedId) + " with...").open();
      });
      const remove = bar2.createEl("button", { text: "Remove from setup" });
      remove.title = "Removes it from this setup only. The device stays registered in LabOS.";
      remove.addEventListener("click", () => {
        const dropped = removeDevice(draft, selectedId);
        this.selectedCardId = null;
        if (dropped) new Notice(String(dropped) + " connection(s) removed with the device.");
        this.drawSetup();
      });
    } else if (draft.devices.length) {
      root.createDiv({ cls: "labos-muted", text: "Click a device to replace it, remove it from this setup, or change its state." });
    }

    if (this.selectedEdge && !draft.connections.includes(this.selectedEdge)) this.selectedEdge = null;
    if (this.selectedEdge) this.renderWireForm(root, draft, this.selectedEdge, ctx.knownPorts);
    else if (draft.connections.length) root.createDiv({ cls: "labos-muted", text: "Click a wire to name its ports or disconnect it." });
  }

  private renderWireForm(root: HTMLElement, draft: SetupDoc, edge: SetupConnection, knownPorts: Map<string, SetupPort[]>): void {
    const nameOf = (rid: string): string => String(findDevice(draft, rid)?.alias ?? rid);
    const form = root.createDiv({ cls: "labos-setup-selectedbar labos-wireform" });
    form.createEl("strong", { text: nameOf(edge.from) + " ↔ " + nameOf(edge.to) });
    const inputs: Array<{ side: "from" | "to"; input: HTMLInputElement }> = [];
    for (const side of ["from", "to"] as const) {
      const input = form.createEl("input", { cls: "labos-input", attr: { placeholder: "Port on " + nameOf(edge[side]), "aria-label": "Port on " + nameOf(edge[side]) } });
      input.value = String((side === "from" ? edge.from_port : edge.to_port) ?? "");
      input.disabled = (side === "from" ? edge.from_port_id : edge.to_port_id) !== undefined;
      inputs.push({ side, input });
    }
    const saveLabel = form.createEl("label");
    const save = saveLabel.createEl("input", { attr: { type: "checkbox" } });
    save.checked = true;
    saveLabel.createSpan({ text: " Save as device ports" });
    const apply = form.createEl("button", { text: "Apply" });
    apply.addEventListener("click", () => void this.applyWireNames(draft, edge, inputs, save.checked, knownPorts));
    const remove = form.createEl("button", { text: "Disconnect" });
    remove.addEventListener("click", () => { disconnect(draft, edge); this.selectedEdge = null; this.drawSetup(); });
  }

  private async applyWireNames(
    draft: SetupDoc, edge: SetupConnection,
    inputs: Array<{ side: "from" | "to"; input: HTMLInputElement }>, saveToDevices: boolean,
    knownPorts: Map<string, SetupPort[]>,
  ): Promise<void> {
    try {
      for (const { side, input } of inputs) {
        const name = input.value.trim();
        if (!name || input.disabled) continue;
        if (!saveToDevices) {
          setEdgeLabels(edge, side === "from" ? name : String(edge.from_port ?? ""), side === "to" ? name : String(edge.to_port ?? ""));
          continue;
        }
        const resourceId = edge[side];
        const existing = (knownPorts.get(resourceId) ?? []).find((port) => port.label.toLowerCase() === name.toLowerCase());
        const port = existing ?? await this.plugin.getBackend().addDevicePort(resourceId, { label: name, kind: "other", direction: "unknown" });
        bindEdgePort(draft, edge, side, port);
      }
      this.selectedEdge = null;
      await this.refreshView();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  private async commitSetup(): Promise<void> {
    const editor = this.setupEditor;
    if (!editor) return;
    try {
      const pending = editor.commit((snapshot, baseEventId) => this.plugin.getBackend().saveSetup(snapshot, baseEventId));
      this.drawSetup();
      const saved = await pending;
      if (saved) {
        this.setupEditor = null;
        new Notice("Setup committed.");
        await this.refreshView();
        return;
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
    this.drawSetup();
  }

  private startCardDrag(event: PointerEvent, card: HTMLElement, canvas: HTMLElement, svg: SVGSVGElement, cards: Map<string, HTMLElement>, handles: Map<string, HTMLElement>, id: string): void {
    if (event.target instanceof Element && event.target.closest("button,input,select")) return;
    const editor = this.setupEditor;
    if (!editor) return;
    const rect = card.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    const startLeft = card.style.left;
    const startTop = card.style.top;
    let moved = false;
    card.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => {
      const bounds = canvas.getBoundingClientRect();
      moved = true;
      card.style.left = Math.max(0, e.clientX - bounds.left + canvas.scrollLeft - dx) + "px";
      card.style.top = Math.max(0, e.clientY - bounds.top + canvas.scrollTop - dy) + "px";
      this.drawSetupWires(canvas, svg, editor.draft, cards, handles);
    };
    const cleanup = (): void => {
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", end);
      card.removeEventListener("pointercancel", cancel);
    };
    const end = (): void => {
      cleanup();
      if (!moved) return;
      moveDevice(editor.draft, id, Number.parseFloat(card.style.left), Number.parseFloat(card.style.top));
      this.drawSetup();
    };
    const cancel = (): void => {
      cleanup();
      card.style.left = startLeft;
      card.style.top = startTop;
      this.drawSetupWires(canvas, svg, editor.draft, cards, handles);
    };
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", cancel);
  }

  private startConnectDrag(event: PointerEvent, canvas: HTMLElement, svg: SVGSVGElement, cards: Map<string, HTMLElement>, handles: Map<string, HTMLElement>, id: string, port: { port_id?: string; label: string }): void {
    event.preventDefault();
    event.stopPropagation();
    const editor = this.setupEditor;
    if (!editor) return;
    const source = event.currentTarget as HTMLElement;
    const move = (e: PointerEvent): void => {
      const bounds = canvas.getBoundingClientRect();
      const from = source.getBoundingClientRect();
      this.drawSetupWires(canvas, svg, editor.draft, cards, handles);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(from.left + from.width / 2 - bounds.left + canvas.scrollLeft));
      line.setAttribute("y1", String(from.top + from.height / 2 - bounds.top + canvas.scrollTop));
      line.setAttribute("x2", String(e.clientX - bounds.left + canvas.scrollLeft));
      line.setAttribute("y2", String(e.clientY - bounds.top + canvas.scrollTop));
      line.setAttribute("class", "labos-setup-wire-preview");
      svg.appendChild(line);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", abort);
    };
    const abort = (): void => { stop(); this.drawSetupWires(canvas, svg, editor.draft, cards, handles); };
    const finish = (e: PointerEvent): void => {
      stop();
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".labos-setup-handle");
      if (!target || target === source || !target.dataset.resource) { this.drawSetupWires(canvas, svg, editor.draft, cards, handles); return; }
      const toPort = target.dataset.port || undefined;
      const result = connect(
        editor.draft,
        { resource_id: id, port_id: port.port_id, label: port.port_id === undefined ? "" : undefined },
        { resource_id: target.dataset.resource, port_id: toPort, label: toPort === undefined ? "" : undefined },
      );
      if (!result.ok) new Notice(result.reason);
      this.drawSetup();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", abort);
  }

  private drawSetupWires(canvas: HTMLElement, svg: SVGSVGElement, draft: SetupDoc, cards: Map<string, HTMLElement>, handles: Map<string, HTMLElement>): void {
    svg.replaceChildren();
    svg.setAttribute("width", String(canvas.scrollWidth));
    svg.setAttribute("height", String(canvas.scrollHeight));
    const bounds = canvas.getBoundingClientRect();
    const anchor = (resourceId: string, portId: string | undefined): { x: number; y: number } | null => {
      const handle = handles.get(resourceId + "|" + (portId ?? ""));
      const target = handle ?? cards.get(resourceId);
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      return { x: rect.left + rect.width / 2 - bounds.left + canvas.scrollLeft, y: rect.top + rect.height / 2 - bounds.top + canvas.scrollTop };
    };
    for (const edge of draft.connections) {
      const a = anchor(edge.from, edge.from_port_id);
      const b = anchor(edge.to, edge.to_port_id);
      if (!a || !b) continue;
      const color = this.plugin.settings.deviceColors[edge.from];
      const coords = { x1: String(a.x), y1: String(a.y), x2: String(b.x), y2: String(b.y) };
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      for (const [key, value] of Object.entries(coords)) line.setAttribute(key, value);
      line.setAttribute("class", "labos-setup-wire" + (edge === this.selectedEdge ? " labos-setup-wire-selected" : ""));
      if (color) line.style.stroke = color;
      svg.appendChild(line);
      // Wide invisible line: the visible wire is too thin to click.
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "line");
      for (const [key, value] of Object.entries(coords)) hit.setAttribute(key, value);
      hit.setAttribute("class", "labos-setup-wire-hit");
      hit.addEventListener("click", () => { this.selectedEdge = edge; this.drawSetup(); });
      svg.appendChild(hit);
    }
  }

}
