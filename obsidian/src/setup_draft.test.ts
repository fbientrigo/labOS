import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SetupEditor, addDevice, removeDevice, moveDevice, connect, disconnect, replaceDevice,
  refreshPorts, portsChanged, setActivation, toSnapshot, type SetupDoc, type SetupPort,
} from "./setup_draft";

const dev = (id: string, alias = id) => ({ resource_id: id, fingerprint: "fp-" + id, alias, kind: "board" });
const eth = (id: string, label = "Ethernet"): SetupPort => ({ port_id: id, label, kind: "network", direction: "bidirectional" });

function editor(doc: Partial<SetupDoc> = { devices: [], connections: [] }) {
  return new SetupEditor(doc, "evt_base");
}

test("edits do not save; commit saves exactly once with the whole snapshot", async () => {
  const ed = editor();
  addDevice(ed.draft, dev("a")); addDevice(ed.draft, dev("b"));
  moveDevice(ed.draft, "a", 50, 60);
  connect(ed.draft, { resource_id: "a", label: "J1" }, { resource_id: "b", label: "P2" });
  const calls: Array<[SetupDoc, string]> = [];
  assert.equal(calls.length, 0);
  assert.equal(await ed.commit(async (snap, base) => { calls.push([snap, base]); }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![1], "evt_base");
  assert.equal(calls[0]![0].devices.length, 2);
  assert.equal(calls[0]![0].connections.length, 1);
});

test("concurrent commits produce one save", async () => {
  const ed = editor(); addDevice(ed.draft, dev("a"));
  let count = 0;
  const save = async () => { count += 1; await new Promise((r) => setTimeout(r, 10)); };
  const [x, y] = await Promise.all([ed.commit(save), ed.commit(save)]);
  assert.equal(count, 1);
  assert.deepEqual([x, y].sort(), [false, true]);
});

test("failed commit keeps draft dirty and allows retry", async () => {
  const ed = editor(); addDevice(ed.draft, dev("a"));
  await assert.rejects(ed.commit(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(ed.dirty, true);
  assert.equal(ed.committing, false);
  assert.equal(await ed.commit(async () => undefined), true);
});

test("clean editor does not commit", async () => {
  assert.equal(await editor().commit(async () => { throw new Error("no"); }), false);
});

test("discard restores base; base never shares references with draft", () => {
  const ed = editor({ devices: [{ ...dev("a"), x: 1, y: 2 }], connections: [] });
  moveDevice(ed.draft, "a", 99, 99);
  setActivation(ed.draft, "a", "active");
  assert.equal(ed.dirty, true);
  assert.equal(ed.base.devices[0]!.x, 1);
  ed.discard();
  assert.equal(ed.dirty, false);
  assert.deepEqual(ed.draft, ed.base);
});

test("moving back to the original position is not dirty", () => {
  const ed = editor({ devices: [{ ...dev("a"), x: 10, y: 20 }], connections: [] });
  moveDevice(ed.draft, "a", 5, 5); moveDevice(ed.draft, "a", 10, 20);
  assert.equal(ed.dirty, false);
});

test("addDevice rejects duplicates; removeDevice drops only touching edges", () => {
  const d: SetupDoc = { devices: [], connections: [] };
  assert.equal(addDevice(d, dev("a")), true);
  assert.equal(addDevice(d, dev("a")), false);
  addDevice(d, dev("b")); addDevice(d, dev("c"));
  connect(d, { resource_id: "a", label: "x" }, { resource_id: "b", label: "y" });
  connect(d, { resource_id: "b", label: "y" }, { resource_id: "c", label: "z" });
  assert.equal(removeDevice(d, "a"), 1);
  assert.equal(d.devices.length, 2);
  assert.equal(d.connections.length, 1);
  assert.equal(d.connections[0]!.to, "c");
});

test("port-to-port connect serializes ids and labels; rejects bad input", () => {
  const d: SetupDoc = { devices: [], connections: [] };
  addDevice(d, dev("z"), [eth("p1"), eth("p2", "UART TX"), eth("p3", "UART RX")]);
  addDevice(d, dev("l"), [eth("q1")]);
  const r = connect(d, { resource_id: "z", port_id: "p1" }, { resource_id: "l", port_id: "q1" });
  assert.equal(r.ok, true);
  const edge = d.connections[0]!;
  assert.match(String(edge.id), /^conn_[0-9a-f]{12}$/);
  assert.deepEqual([edge.from, edge.from_port, edge.from_port_id, edge.to, edge.to_port, edge.to_port_id], ["z", "Ethernet", "p1", "l", "Ethernet", "q1"]);
  assert.equal(connect(d, { resource_id: "l", port_id: "q1" }, { resource_id: "z", port_id: "p1" }).ok, false); // reversed duplicate
  assert.equal(connect(d, { resource_id: "z", port_id: "nope" }, { resource_id: "l", port_id: "q1" }).ok, false);
  assert.equal(connect(d, { resource_id: "z", port_id: "p1" }, { resource_id: "z", port_id: "p1" }).ok, false);
  assert.equal(connect(d, { resource_id: "z", port_id: "p2" }, { resource_id: "z", port_id: "p3" }).ok, true); // loopback
  assert.equal(connect(d, { resource_id: "z", port_id: "p1" }, { resource_id: "missing", port_id: "x" }).ok, false);
});

test("disconnect removes only that edge", () => {
  const d: SetupDoc = { devices: [], connections: [] };
  addDevice(d, dev("a")); addDevice(d, dev("b"));
  connect(d, { resource_id: "a", label: "1" }, { resource_id: "b", label: "1" });
  connect(d, { resource_id: "a", label: "2" }, { resource_id: "b", label: "2" });
  disconnect(d, d.connections[0]!);
  assert.equal(d.connections.length, 1);
  assert.equal(d.connections[0]!.from_port, "2");
});

test("replaceDevice remaps by label and reports dropped edges", () => {
  const d: SetupDoc = { devices: [], connections: [] };
  addDevice(d, dev("old"), [eth("o1"), eth("o2", "JTAG")]);
  addDevice(d, dev("lap"), [eth("l1")]);
  connect(d, { resource_id: "old", port_id: "o1" }, { resource_id: "lap", port_id: "l1" });
  connect(d, { resource_id: "old", port_id: "o2" }, { resource_id: "lap", port_id: "l1" });
  const res = replaceDevice(d, "old", dev("new"), [eth("n1", "ethernet")]);
  assert.deepEqual(res, { ok: true, dropped: 1 });
  assert.equal(d.connections.length, 1);
  assert.equal(d.connections[0]!.from, "new");
  assert.equal(d.connections[0]!.from_port_id, "n1");
  assert.equal(d.devices.some((x) => x.resource_id === "old"), false);
  assert.equal(replaceDevice(d, "new", dev("lap")).ok, false);
});

test("refreshPorts updates labels by id and keeps connected removed ports", () => {
  const d: SetupDoc = { devices: [], connections: [] };
  addDevice(d, dev("a"), [eth("p1", "Ethernet"), eth("p2", "JTAG")]);
  addDevice(d, dev("b"), [eth("q1")]);
  connect(d, { resource_id: "a", port_id: "p1" }, { resource_id: "b", port_id: "q1" });
  connect(d, { resource_id: "a", port_id: "p2" }, { resource_id: "b", port_id: "q1" });
  const current = [eth("p1", "ETH0")];
  assert.equal(portsChanged(d.devices[0]!, current), true);
  const orphans = refreshPorts(d, "a", current);
  assert.deepEqual(orphans, ["p2"]);
  assert.equal(d.connections[0]!.from_port, "ETH0");
  assert.equal(d.connections.length, 2);
  assert.equal(d.devices[0]!.ports!.some((p) => p.port_id === "p2"), true);
});

test("legacy snapshot round-trips unchanged and stays clean", () => {
  const legacy = { devices: [{ ...dev("a"), x: 1, y: 2, activation: "unknown" }, { ...dev("b"), x: 3, y: 4 }], connections: [{ id: "1700000000000", from: "a", to: "b", from_port: "J1", to_port: "P2" }] };
  const ed = editor(legacy);
  assert.equal(ed.dirty, false);
  assert.deepEqual(toSnapshot(ed.draft), { ...legacy, setup_schema: 2 }); // only additive marker; legacy fields untouched
});

test("snapshot ports keep only descriptor fields", () => {
  const d: SetupDoc = { devices: [], connections: [] };
  addDevice(d, dev("a"), [{ port_id: "p1", label: "Ethernet", kind: "network", direction: "bidirectional", connector: null, notes: "secret", approved_at: "t" } as SetupPort]);
  assert.deepEqual(d.devices[0]!.ports, [{ port_id: "p1", label: "Ethernet", kind: "network", direction: "bidirectional" }]);
});

test("rebase only when clean; stale detection only when dirty", () => {
  const ed = editor();
  assert.equal(ed.isStale("evt_other"), false);
  addDevice(ed.draft, dev("a"));
  assert.equal(ed.isStale("evt_other"), true);
  assert.equal(ed.rebase({ devices: [], connections: [] }, "evt_other"), false);
  ed.discard();
  assert.equal(ed.rebase({ devices: [dev("z")], connections: [] }, "evt_other"), true);
  assert.equal(ed.baseEventId, "evt_other");
  assert.equal(ed.draft.devices.length, 1);
});
