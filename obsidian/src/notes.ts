import { Editor, MarkdownView, Modal, Notice, TFile, normalizePath } from "obsidian";

import type LabOSPlugin from "./main";
import { NoteIndex } from "./note_index";
import { duplicateEntryIds, entryBlock, entryText, findEmbeds, hasNoteLinkEvent, insertionPrefix, isImagePath, splitEntries } from "./session_note";
import type { LabOSEvent, NoteSyncEntry } from "./types";

const ID_KEY = "labos-id";
const SESSIONS_KEY = "labos-sessions";
const PROJECT_KEY = "labos-project";
const LOG_FOLDER = "LabOS/Logs";
const TEMPLATE_PATH = "LabOS/Templates/session-note.md";
const LOG_ID_MARKER = /<!--\s*labos-log-id:([a-f0-9-]+)\s*-->/i;

/**
 * Session Notes: ordinary Markdown notes that carry a LabOS id in their frontmatter.
 * The id lives in the note, so moving or archiving the note never breaks the connection.
 */
export class SessionNotes {
  readonly index: NoteIndex;
  private persistTimer: number | null = null;

  constructor(private readonly plugin: LabOSPlugin) {
    this.index = new NoteIndex(plugin.settings.noteIndex);
  }

  private get app(): LabOSPlugin["app"] {
    return this.plugin.app;
  }

  // ---- reading connection state (cache only, no file reads) ----

  noteId(file: TFile): string | null {
    const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[ID_KEY];
    return typeof value === "string" && value ? value : null;
  }

  sessionsOf(file: TFile): string[] {
    const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[SESSIONS_KEY];
    return Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];
  }

  /** Connected notes, optionally only those that belong to a session. */
  connectedNotes(sessionId?: string): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) =>
      this.noteId(file) !== null && (!sessionId || this.sessionsOf(file).includes(sessionId)));
  }

  // ---- connect ----

  async connect(file: TFile): Promise<string> {
    const session = await this.plugin.getBackend().status();
    const existing = this.noteId(file);
    const already = existing !== null && (!session || this.sessionsOf(file).includes(session.session_id));
    if (already && existing) {
      this.remember("note:" + existing, file.path);
      const events = await this.plugin.getBackend().recent(1000);
      if (!hasNoteLinkEvent(events, file.path, session?.session_id)) {
        const event = await this.plugin.getBackend().capture({ text: "", links: [{ title: file.basename, path: file.path, kind: "note" }] });
        await this.plugin.writeDailyLogForEvent(event);
        await this.plugin.refreshViews();
      }
      return existing;
    }
    let id = existing ?? crypto.randomUUID();
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      id = typeof frontmatter[ID_KEY] === "string" && frontmatter[ID_KEY] ? String(frontmatter[ID_KEY]) : id;
      frontmatter[ID_KEY] = id;
      if (session) {
        const sessions = Array.isArray(frontmatter[SESSIONS_KEY]) ? (frontmatter[SESSIONS_KEY] as unknown[]).map(String) : [];
        if (!sessions.includes(session.session_id)) sessions.push(session.session_id);
        frontmatter[SESSIONS_KEY] = sessions;
        if (!frontmatter[PROJECT_KEY]) frontmatter[PROJECT_KEY] = session.project;
      }
    });
    this.remember("note:" + id, file.path);
    // The session learns about the note too: one ordinary linked event.
    const event = await this.plugin.getBackend().capture({ text: "", links: [{ title: file.basename, path: file.path, kind: "note" }] });
    await this.plugin.writeDailyLogForEvent(event);
    await this.plugin.refreshViews();
    return id;
  }

  async connectActive(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") { new Notice("Open a Markdown note first."); return; }
    await this.connect(file);
    new Notice("Connected: " + file.basename);
  }

  // ---- entries ----

  async newEntry(editor: Editor, file: TFile | null): Promise<void> {
    if (!file) { new Notice("Open a note first."); return; }
    await this.connect(file);
    const event = await this.plugin.getBackend().capture({ text: "", links: [{ title: file.basename, path: file.path, kind: "note" }] });
    const before = editor.getRange({ line: 0, ch: 0 }, editor.getCursor());
    editor.replaceSelection(insertionPrefix(before) + entryBlock(event.id, new Date()));
    await this.plugin.writeDailyLogForEvent(event);
  }

  /** Optional: mirror a quick-box note into the session note in the same format. */
  async appendQuick(event: LabOSEvent, text: string): Promise<void> {
    if (!this.plugin.settings.copyQuickToNote || !text) return;
    const session = await this.plugin.getBackend().status();
    const active = this.app.workspace.getActiveFile();
    const target = active && this.noteId(active) ? active : this.connectedNotes(session?.session_id)[0];
    if (!target) return;
    await this.app.vault.process(target, (data) => data.replace(/\s*$/, "") + "\n\n" + entryBlock(event.id, new Date()) + text + "\n");
  }

  // ---- sync ----

  async sync(file: TFile | null): Promise<void> {
    if (!file) { new Notice("Open a session note first."); return; }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    // Prefer the live editor text: the file on disk can lag a few seconds behind typing.
    const text = view?.file?.path === file.path ? view.editor.getValue() : await this.app.vault.read(file);
    const entries = splitEntries(text);
    if (!entries.length) { new Notice("No LabOS entries in this note. Use 'New entry' to add one."); return; }
    const duplicates = duplicateEntryIds(entries);
    if (duplicates.length) {
      new Notice("LabOS sync stopped: duplicate entry IDs found (" + duplicates.join(", ") + "). Remove copied callouts or use 'New entry' to create a unique ID.", 10000);
      return;
    }
    const hostLink = { title: file.basename, path: file.path, kind: "note" };
    const payload: NoteSyncEntry[] = entries.map((entry) => ({
      id: entry.id,
      text: entryText(entry.body),
      links: [hostLink, ...findEmbeds(entry.body).map((target) => {
        const resolved = this.app.metadataCache.getFirstLinkpathDest(target, file.path);
        return resolved
          ? { title: resolved.basename, path: resolved.path, kind: isImagePath(resolved.path) ? "image" : "note" }
          : { title: target, path: target, kind: isImagePath(target) ? "image" : "note" };
      })],
    }));
    const backend = this.plugin.getBackend();
    const preview = await backend.syncEntries(payload);
    if (preview.changed.length) {
      const details = preview.changed_details.map((item) =>
        `${item.entry_id}\nBefore: ${JSON.stringify(item.before, null, 2)}\nAfter: ${JSON.stringify(item.after, null, 2)}`).join("\n\n");
      const approved = await new Promise<boolean>((resolve) => {
        const modal = new Modal(this.app);
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          modal.close();
          resolve(value);
        };
        modal.titleEl.setText("Review note changes");
        modal.contentEl.createEl("p", { text: "These edits will revise existing LabOS evidence:" });
        modal.contentEl.createEl("pre", { text: details });
        const actions = modal.contentEl.createDiv({ cls: "modal-button-container" });
        actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => finish(false));
        actions.createEl("button", { text: "Apply reviewed changes", cls: "mod-cta" }).addEventListener("click", () => finish(true));
        modal.onClose = () => { if (!settled) { settled = true; resolve(false); } };
        modal.open();
      });
      if (!approved) return;
    }
    const result = preview.changed.length
      ? await backend.syncEntries(payload, true, preview.expected)
      : preview;
    if (result.status === "conflict") {
      new Notice("LabOS sync stopped: an entry changed after review. Sync again to review the current version.", 10000);
      return;
    }
    const parts = [`${result.changed.length} updated`, `${result.unchanged.length} unchanged`];
    if (result.unknown.length) parts.push(`${result.unknown.length} not in LabOS`);
    new Notice("LabOS sync: " + parts.join(", "));
    await this.plugin.refreshViews();
  }

  // ---- session note creation ----

  async createSessionNote(): Promise<void> {
    const now = new Date();
    const stamp = String(now.getFullYear()).slice(2) + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
    const folder = normalizePath(this.plugin.settings.notesFolder || "LabOS/Notes");
    const path = normalizePath(folder + "/" + stamp + ".md");
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(folder))) await this.app.vault.createFolder(folder);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      const template = this.app.vault.getAbstractFileByPath(TEMPLATE_PATH);
      const content = template instanceof TFile ? await this.app.vault.read(template) : "";
      file = await this.app.vault.create(path, content);
    }
    if (!(file instanceof TFile)) return;
    await this.connect(file);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async open(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  // ---- index ----

  /** Remember one path. Cheap: runs from rename/change listeners, never scans the vault. */
  remember(key: string, path: string): void {
    if (this.index.get(key) === path) return;
    this.index.set(key, path);
    this.schedulePersist();
  }

  onRename(oldPath: string, newPath: string): void {
    this.index.rename(oldPath, newPath);
    this.schedulePersist();
  }

  onDelete(path: string): void {
    this.index.removePath(path);
    this.schedulePersist();
  }

  onMetadata(file: TFile): void {
    const id = this.noteId(file);
    if (id) this.remember("note:" + id, file.path);
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.plugin.settings.noteIndex = this.index.toJSON();
      void this.plugin.saveData(this.plugin.settings);
    }, 800);
  }

  /** The one full scan. Runs only when asked: menu, command, or the optional startup setting. */
  async rebuild(): Promise<number> {
    const files = this.app.vault.getMarkdownFiles();
    const notes: Array<[string, string]> = [];
    for (const file of files) {
      const id = this.noteId(file);
      if (id) notes.push([id, file.path]);
    }
    this.index.replaceKind("note:", notes);
    const logs = await this.scanLogs();
    this.plugin.settings.noteIndex = this.index.toJSON();
    await this.plugin.saveData(this.plugin.settings);
    return notes.length + logs;
  }

  /** Daily logs hold their id in the body, so only the LabOS log folder is read. */
  private async scanLogs(): Promise<number> {
    const entries: Array<[string, string]> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(LOG_FOLDER + "/")) continue;
      const match = LOG_ID_MARKER.exec(await this.app.vault.cachedRead(file));
      if (match) entries.push([match[1]!, file.path]);
    }
    this.index.replaceKind("log:", entries);
    return entries.length;
  }

  /** Vault-relative path for a daily log: from the index, else the default location. */
  async logPath(stableId: string, day: string): Promise<string> {
    const known = this.index.get("log:" + stableId);
    if (known && this.app.vault.getAbstractFileByPath(known) instanceof TFile) return known;
    if (known) {
      await this.scanLogs(); // the indexed path is stale; the log folder is small and cheap to rescan
      const refreshed = this.index.get("log:" + stableId);
      if (refreshed) return refreshed;
    }
    return normalizePath(LOG_FOLDER + "/" + day + ".md");
  }
}
