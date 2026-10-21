import assert from "node:assert/strict";
import test from "node:test";
import { ScopedDrafts } from "./scoped_drafts.js";

test("draft fields and pasted images stay within their session, day, device, and form scope", () => {
  const drafts = new ScopedDrafts();
  drafts.setField("session:s1:note", "text", "baseline");
  drafts.setField("session:s1:measurement", "current", "12");
  drafts.setField("session:s2:note", "text", "other work");
  drafts.addImage("session:s1:measurement", { title: "plot.png", path: "plot.png", kind: "image" });

  assert.equal(drafts.field("session:s1:note", "text"), "baseline");
  assert.equal(drafts.field("session:s2:note", "text"), "other work");
  assert.equal(drafts.field("session:s1:measurement", "current"), "12");
  assert.deepEqual(drafts.images("session:s1:measurement").map((image) => image.path), ["plot.png"]);
  assert.deepEqual(drafts.images("session:s1:note"), []);

  drafts.clear("session:s1:measurement");
  assert.equal(drafts.field("session:s1:measurement", "current"), undefined);
  assert.equal(drafts.images("session:s1:measurement").length, 0);
  assert.equal(drafts.field("session:s1:note", "text"), "baseline");
});

test("a completed save clears only the exact field values and images it consumed", () => {
  const drafts = new ScopedDrafts();
  const savedImage = { title: "saved.png", path: "saved.png", kind: "image" };
  const newerImage = { title: "new.png", path: "new.png", kind: "image" };
  drafts.setField("session:s1", "note", "sent text");
  drafts.addImage("session:s1", savedImage);

  drafts.setField("session:s1", "note", "typed during save");
  drafts.addImage("session:s1", newerImage);
  drafts.clearFieldIfValue("session:s1", "note", "sent text");
  drafts.removeImages("session:s1", [savedImage]);

  assert.equal(drafts.field("session:s1", "note"), "typed during save");
  assert.deepEqual(drafts.images("session:s1"), [newerImage]);
});
