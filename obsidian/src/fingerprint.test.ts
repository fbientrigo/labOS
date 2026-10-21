import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprintTargets } from "./fingerprint";

test("empty setting means the feature is off", () => {
  assert.deepEqual(fingerprintTargets("", false), []);
  assert.deepEqual(fingerprintTargets("  \n\r\n  ", false), []);
});

test("one path per line, trimmed, blanks dropped, duplicates removed", () => {
  assert.deepEqual(
    fingerprintTargets("C:\\a\\x.elf\r\n  C:\\a\\x.bit  \n\nC:\\a\\x.elf\n", false),
    ["C:\\a\\x.elf", "C:\\a\\x.bit"],
  );
});

test("historical checkpoints are never fingerprinted", () => {
  assert.deepEqual(fingerprintTargets("C:\\a\\x.elf", true), []);
});
