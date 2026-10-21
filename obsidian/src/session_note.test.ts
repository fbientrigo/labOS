import { test } from "node:test";
import assert from "node:assert/strict";
import { approximateTime, entryBlock, entryIdAtLine, entryText, findEmbeds, insertionPrefix, isImagePath, splitEntries } from "./session_note";
import { NoteIndex } from "./note_index";

test("time is rounded down to five minutes and zero padded", () => {
  assert.equal(approximateTime(new Date(2026, 9, 8, 1, 12)), "01:10");
  assert.equal(approximateTime(new Date(2026, 9, 8, 14, 59)), "14:55");
  assert.equal(approximateTime(new Date(2026, 9, 8, 0, 4)), "00:00");
});

test("entries are found by hidden id only, whatever the visible time says", () => {
  const first = entryBlock("evt-1", new Date(2026, 9, 8, 1, 12));
  const second = entryBlock("evt-2", new Date(2026, 9, 8, 1, 31)).replace("~01:30", "later, I edited this");
  const note = "---\nlabos-id: x\n---\nintro\n" + first + "DMA works\n![[a.png]]\n\n" + second + "drops after 70 s\n";
  const entries = splitEntries(note);
  assert.deepEqual(entries.map((e) => e.id), ["evt-1", "evt-2"]);
  assert.equal(entries[0]!.body.includes("DMA works"), true);
  assert.equal(entries[0]!.body.includes("drops"), false);
  assert.equal(entries[1]!.body.trim(), "drops after 70 s");
});

test("a note without entries yields none, and user text above the first entry is ignored", () => {
  assert.deepEqual(splitEntries("just a normal note\n> [!info] x"), []);
});

test("embed-only lines leave the text and travel as links", () => {
  assert.equal(entryText("DMA works\n![[scope.png]]\n\nsee [[other note]]\n"), "DMA works\n\nsee [[other note]]");
  assert.equal(entryText("![[only.png]]"), "");
  assert.equal(entryText("DMA works\n![scope](LabOS/Attachments/scope.png)\nNext observation"), "DMA works\nNext observation");
});

test("entryIdAtLine maps a line to its entry", () => {
  const entries = splitEntries(entryBlock("a", new Date()) + "x\n" + entryBlock("b", new Date()) + "y");
  assert.equal(entryIdAtLine(entries, entries[0]!.bodyStart), "a");
  assert.equal(entryIdAtLine(entries, entries[1]!.bodyStart), "b");
  assert.equal(entryIdAtLine(entries, 999), null);
});

test("insertion prefix keeps the callout on its own line", () => {
  assert.equal(insertionPrefix(""), "");
  assert.equal(insertionPrefix("text"), "\n\n");
  assert.equal(insertionPrefix("text\n"), "\n");
  assert.equal(insertionPrefix("text\n\n"), "");
});

test("index follows renames, folder moves and deletes without rescanning", () => {
  const index = new NoteIndex({ "note:a": "Notes/261008.md", "note:b": "Sprint 1/x.md", "log:d": "LabOS/Logs/2026-10-08.md" });
  index.rename("Notes/261008.md", "Archive/2026-10/261008.md");
  assert.equal(index.get("note:a"), "Archive/2026-10/261008.md");
  index.rename("Sprint 1", "Archive/Sprint 1");
  assert.equal(index.get("note:b"), "Archive/Sprint 1/x.md");
  index.removePath("Archive");
  assert.equal(index.get("note:a"), undefined);
  assert.equal(index.get("log:d"), "LabOS/Logs/2026-10-08.md");
});

test("replaceKind swaps one kind and survives a JSON round trip", () => {
  const index = new NoteIndex({ "note:a": "a.md", "log:d": "d.md" });
  index.replaceKind("note:", [["z", "z.md"]]);
  assert.equal(index.get("note:a"), undefined);
  assert.equal(index.get("note:z"), "z.md");
  assert.equal(new NoteIndex(index.toJSON()).get("log:d"), "d.md");
});

test("embeds are found in wiki and markdown form; remote images are skipped", () => {
  const body = "a ![[scope 1.png]] b ![[note#Heading]] ![alt](shots/a%20b.png) ![web](https://x.io/y.png) ![[scope 1.png|300]]";
  assert.deepEqual(findEmbeds(body), ["scope 1.png", "note", "shots/a b.png"]);
  assert.equal(isImagePath("a/B.PNG"), true);
  assert.equal(isImagePath("a/note.md"), false);
});
