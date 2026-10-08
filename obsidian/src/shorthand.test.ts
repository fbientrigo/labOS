import assert from "node:assert/strict";
import { test } from "node:test";
import { parseShorthand } from "./shorthand";

test("plain text is a note, even when it mentions units", () => {
  assert.deepEqual(parseShorthand("set 5 mA limit"), { ok: true, kind: "note", text: "set 5 mA limit", tag: undefined });
});

test("#tag is extracted and kept in the text", () => {
  assert.deepEqual(parseShorthand("scope drift #tuning"), { ok: true, kind: "note", text: "scope drift #tuning", tag: "tuning" });
});

test("checkpoints", () => {
  assert.deepEqual(parseShorthand("!ok board boots"), { ok: true, kind: "checkpoint", state: "working", text: "board boots", tag: undefined });
  assert.deepEqual(parseShorthand("!broken #psu no output"), { ok: true, kind: "checkpoint", state: "broken", text: "#psu no output", tag: "psu" });
  assert.equal((parseShorthand("!fail") as { state: string }).state, "broken");
});

test("unknown command stays a note", () => {
  assert.equal(parseShorthand("!whatever").ok && (parseShorthand("!whatever") as { kind: string }).kind, "note");
});

test("measurement with current only defaults to setup", () => {
  assert.deepEqual(parseShorthand("!m 12mA"), {
    ok: true, kind: "measurement", text: "", tag: undefined, target: "setup", current: 12, unit: "mA", voltage: undefined,
  });
});

test("measurement with spaced unit, voltage, quoted target and note", () => {
  assert.deepEqual(parseShorthand('!m 0.3 A 3.3V @"board / 5V rail" idle #bringup'), {
    ok: true, kind: "measurement", text: "idle #bringup", tag: "bringup", target: "board / 5V rail", current: 0.3, unit: "A", voltage: 3.3,
  });
});

test("bare @target", () => {
  const result = parseShorthand("!m 40mA @laser warm");
  assert.ok(result.ok && result.kind === "measurement");
  assert.equal(result.target, "laser");
  assert.equal(result.text, "warm");
});

test("!m without current is an error", () => {
  assert.deepEqual(parseShorthand("!m 3.3V idle"), { ok: false, error: "Measurement needs a current, e.g. !m 12mA" });
});
