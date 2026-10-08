// Pure draft model for the Hardware Setup editor. No Obsidian imports: testable in Node.
// Nothing here touches the backend except through the injected `save` in SetupEditor.commit().

export interface SetupPort {
  port_id: string;
  label: string;
  kind?: string;
  direction?: string;
  connector?: string | null;
}

export interface SetupDevice {
  resource_id?: string;
  id?: string;
  fingerprint?: string;
  alias?: string;
  kind?: string;
  activation?: string;
  mode?: string;
  x?: number;
  y?: number;
  ports?: SetupPort[];
  [key: string]: unknown;
}

export interface SetupConnection {
  id?: string;
  from: string;
  to: string;
  from_port?: string;
  to_port?: string;
  from_port_id?: string;
  to_port_id?: string;
  [key: string]: unknown;
}

export interface SetupDoc {
  devices: SetupDevice[];
  connections: SetupConnection[];
  setup_schema?: number;
  [key: string]: unknown;
}

/** Immutable snapshot descriptor of a device port: stable id plus the label/kind it had at record time. */
export function descriptor(port: SetupPort): SetupPort {
  const out: SetupPort = { port_id: port.port_id, label: port.label };
  if (port.kind) out.kind = port.kind;
  if (port.direction) out.direction = port.direction;
  if (port.connector) out.connector = port.connector;
  return out;
}

export const SETUP_SCHEMA = 2;

export interface PortRef { resource_id: string; port_id?: string; label?: string }

export const deviceId = (device: SetupDevice): string => String(device.resource_id ?? device.id ?? "");

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

export function normalize(doc: Partial<SetupDoc> | null | undefined): SetupDoc {
  return { ...(doc ?? {}), devices: clone(doc?.devices ?? []), connections: clone(doc?.connections ?? []) };
}

export function isDirty(base: SetupDoc, draft: SetupDoc): boolean {
  return canonical(base) !== canonical(draft);
}

function randomHex(): string {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export const newConnectionId = (): string => "conn_" + randomHex();

export function findDevice(draft: SetupDoc, id: string): SetupDevice | undefined {
  return draft.devices.find((device) => deviceId(device) === id);
}

export function addDevice(draft: SetupDoc, device: { resource_id: string; fingerprint: string; alias: string; kind: string }, ports?: SetupPort[]): boolean {
  if (findDevice(draft, device.resource_id)) return false;
  const entry: SetupDevice = {
    resource_id: device.resource_id, fingerprint: device.fingerprint, alias: device.alias, kind: device.kind,
    x: 16 + draft.devices.length * 150, y: 16, activation: "unknown",
  };
  if (ports && ports.length) entry.ports = ports.map(descriptor);
  draft.devices.push(entry);
  return true;
}

/** Removes the device and every edge touching it. Returns the number of edges dropped. */
export function removeDevice(draft: SetupDoc, id: string): number {
  draft.devices = draft.devices.filter((device) => deviceId(device) !== id);
  const before = draft.connections.length;
  draft.connections = draft.connections.filter((edge) => edge.from !== id && edge.to !== id);
  return before - draft.connections.length;
}

function labelKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Swap a device in place. Keeps layout, activation and mode. Edges are remapped by
 * case-insensitive port label (or kept when the edge has no port); unmatched edges are dropped.
 */
export function replaceDevice(
  draft: SetupDoc, oldId: string,
  replacement: { resource_id: string; fingerprint: string; alias: string; kind: string },
  ports?: SetupPort[],
): { ok: boolean; dropped: number } {
  const previous = findDevice(draft, oldId);
  if (!previous) return { ok: false, dropped: 0 };
  if (replacement.resource_id !== oldId && findDevice(draft, replacement.resource_id)) return { ok: false, dropped: 0 };
  const next: SetupDevice = {
    ...previous,
    resource_id: replacement.resource_id, fingerprint: replacement.fingerprint,
    alias: replacement.alias, kind: replacement.kind,
  };
  delete next.id;
  delete next.ports;
  if (ports && ports.length) next.ports = ports.map(descriptor);
  draft.devices = draft.devices.map((device) => (device === previous ? next : device));
  let dropped = 0;
  const kept: SetupConnection[] = [];
  for (const edge of draft.connections) {
    const edgeCopy = { ...edge };
    let keep = true;
    for (const side of ["from", "to"] as const) {
      if (edgeCopy[side] !== oldId) continue;
      edgeCopy[side] = replacement.resource_id;
      const labelField = side === "from" ? "from_port" : "to_port";
      const idField = side === "from" ? "from_port_id" : "to_port_id";
      const label = String(edgeCopy[labelField] ?? "");
      if (edgeCopy[idField] !== undefined) {
        const match = (next.ports ?? []).find((port) => labelKey(port.label) === labelKey(label));
        if (!match) { keep = false; break; }
        edgeCopy[idField] = match.port_id;
        edgeCopy[labelField] = match.label;
      }
    }
    if (keep) kept.push(edgeCopy); else dropped += 1;
  }
  draft.connections = kept;
  return { ok: true, dropped };
}

export function moveDevice(draft: SetupDoc, id: string, x: number, y: number): void {
  const device = findDevice(draft, id);
  if (!device || !Number.isFinite(x) || !Number.isFinite(y)) return;
  device.x = Math.round(x);
  device.y = Math.round(y);
}

export function setActivation(draft: SetupDoc, id: string, value: string): void {
  const device = findDevice(draft, id);
  if (device) device.activation = value;
}

export function setMode(draft: SetupDoc, id: string, value: string): void {
  const device = findDevice(draft, id);
  if (device) device.mode = value;
}

function portLabel(device: SetupDevice, ref: PortRef): { label: string; port_id?: string } | null {
  if (ref.port_id !== undefined) {
    const port = (device.ports ?? []).find((candidate) => candidate.port_id === ref.port_id);
    return port ? { label: port.label, port_id: port.port_id } : null;
  }
  return { label: ref.label ?? "" };
}

export type ConnectResult = { ok: true; edge: SetupConnection } | { ok: false; reason: string };

/** Create an edge between two endpoints. Never persists. */
export function connect(draft: SetupDoc, from: PortRef, to: PortRef): ConnectResult {
  const a = findDevice(draft, from.resource_id);
  const b = findDevice(draft, to.resource_id);
  if (!a || !b) return { ok: false, reason: "Both devices must be in the setup." };
  const left = portLabel(a, from);
  const right = portLabel(b, to);
  if (!left || !right) return { ok: false, reason: "Unknown port." };
  if (from.resource_id === to.resource_id && (from.port_id === undefined || from.port_id === to.port_id)) {
    return { ok: false, reason: "Choose two different ports." };
  }
  const same = (edge: SetupConnection, x: PortRef, y: PortRef): boolean =>
    edge.from === x.resource_id && edge.to === y.resource_id &&
    (x.port_id === undefined ? edge.from_port_id === undefined && String(edge.from_port ?? "") === (x.label ?? "") : edge.from_port_id === x.port_id) &&
    (y.port_id === undefined ? edge.to_port_id === undefined && String(edge.to_port ?? "") === (y.label ?? "") : edge.to_port_id === y.port_id);
  if (draft.connections.some((edge) => same(edge, from, to) || same(edge, to, from))) {
    return { ok: false, reason: "These ports are already connected." };
  }
  const edge: SetupConnection = { id: newConnectionId(), from: from.resource_id, to: to.resource_id, from_port: left.label, to_port: right.label };
  if (left.port_id !== undefined) edge.from_port_id = left.port_id;
  if (right.port_id !== undefined) edge.to_port_id = right.port_id;
  draft.connections.push(edge);
  return { ok: true, edge };
}

export function disconnect(draft: SetupDoc, edge: SetupConnection): void {
  draft.connections = draft.connections.filter((candidate) => candidate !== edge);
}

export function setEdgeLabels(edge: SetupConnection, fromPort: string, toPort: string): void {
  if (edge.from_port_id === undefined) edge.from_port = fromPort;
  if (edge.to_port_id === undefined) edge.to_port = toPort;
}

/** True when the device's snapshot ports differ from the current device definition. */
export function portsChanged(device: SetupDevice, current: SetupPort[]): boolean {
  const strip = (ports: SetupPort[]) => ports.map(descriptor);
  return canonical(strip(device.ports ?? [])) !== canonical(strip(current));
}

/**
 * Explicitly adopt the current port definitions. Ports still used by an edge but gone from
 * the definition are kept so no edge silently loses its endpoint.
 */
export function refreshPorts(draft: SetupDoc, id: string, current: SetupPort[]): string[] {
  const device = findDevice(draft, id);
  if (!device) return [];
  const used = new Set<string>();
  for (const edge of draft.connections) {
    if (edge.from === id && edge.from_port_id) used.add(edge.from_port_id);
    if (edge.to === id && edge.to_port_id) used.add(edge.to_port_id);
  }
  const next = current.map(descriptor);
  const orphans: string[] = [];
  for (const old of device.ports ?? []) {
    if (used.has(old.port_id) && !next.some((port) => port.port_id === old.port_id)) { next.push(old); orphans.push(old.port_id); }
  }
  device.ports = next;
  for (const edge of draft.connections) {
    const sides: Array<["from" | "to", string, string]> = [["from", "from_port", "from_port_id"], ["to", "to_port", "to_port_id"]];
    for (const [side, labelField, idField] of sides) {
      if (edge[side] !== id || edge[idField] === undefined) continue;
      const port = next.find((candidate) => candidate.port_id === edge[idField]);
      if (port) edge[labelField] = port.label;
    }
  }
  return orphans;
}

export function toSnapshot(draft: SetupDoc): SetupDoc {
  return { ...clone(draft), setup_schema: SETUP_SCHEMA };
}

export type SaveFn = (snapshot: SetupDoc, baseEventId: string) => Promise<void>;

/** Holds the persisted base, the working draft and the commit lifecycle. */
export class SetupEditor {
  base: SetupDoc;
  draft: SetupDoc;
  baseEventId: string;
  committing = false;

  constructor(persisted: Partial<SetupDoc>, baseEventId: string) {
    this.base = normalize(persisted);
    this.draft = clone(this.base);
    this.baseEventId = baseEventId;
  }

  get dirty(): boolean {
    return isDirty(this.base, this.draft);
  }

  discard(): void {
    this.draft = clone(this.base);
  }

  /** Re-base a clean editor on newly loaded persisted state. A dirty editor is left alone. */
  rebase(persisted: Partial<SetupDoc>, baseEventId: string): boolean {
    if (this.dirty || this.committing) return false;
    this.base = normalize(persisted);
    this.draft = clone(this.base);
    this.baseEventId = baseEventId;
    return true;
  }

  isStale(latestEventId: string): boolean {
    return this.dirty && latestEventId !== this.baseEventId;
  }

  /** Exactly one `save` call; concurrent calls return false. Draft is kept on failure. */
  async commit(save: SaveFn): Promise<boolean> {
    if (this.committing || !this.dirty) return false;
    this.committing = true;
    try {
      await save(toSnapshot(this.draft), this.baseEventId);
      return true;
    } finally {
      this.committing = false;
    }
  }
}
