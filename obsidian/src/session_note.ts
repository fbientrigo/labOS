// Pure helpers for Session Notes. No Obsidian imports: testable in Node.
//
// A Session Note entry is a native Obsidian callout whose header carries a hidden comment with the
// event id. LabOS owns the time and the id; the user only writes below the header. Sync reads the
// ids and never the visible time.

export interface NoteEntry {
  id: string;
  /** 0-based line of the callout header. */
  headerLine: number;
  /** 0-based line range of the body, inclusive start, exclusive end. */
  bodyStart: number;
  bodyEnd: number;
  body: string;
}

const HEADER = /^>\s*\[!labos\][^\n]*%%labos:([A-Za-z0-9_-]+)%%/;

/** Local clock time rounded down to 5 minutes, e.g. "01:10". Order is kept by the event id, not this text. */
export function approximateTime(now: Date): string {
  const minutes = Math.floor(now.getMinutes() / 5) * 5;
  return String(now.getHours()).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
}

export function entryHeader(id: string, now: Date): string {
  return "> [!labos] ~" + approximateTime(now) + " %%labos:" + id + "%%";
}

/** Header plus a blank line, ready to insert where the cursor is. */
export function entryBlock(id: string, now: Date): string {
  return entryHeader(id, now) + "\n\n";
}

export function splitEntries(text: string): NoteEntry[] {
  const lines = text.split("\n");
  const headers: Array<{ line: number; id: string }> = [];
  lines.forEach((line, index) => {
    const match = HEADER.exec(line);
    if (match) headers.push({ line: index, id: match[1]! });
  });
  return headers.map((header, position) => {
    const bodyEnd = position + 1 < headers.length ? headers[position + 1]!.line : lines.length;
    return {
      id: header.id,
      headerLine: header.line,
      bodyStart: header.line + 1,
      bodyEnd,
      body: lines.slice(header.line + 1, bodyEnd).join("\n"),
    };
  });
}

/** Entry ids must be unique within a note before sync can safely revise events. */
export function duplicateEntryIds(entries: NoteEntry[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) duplicates.add(entry.id);
    seen.add(entry.id);
  }
  return [...duplicates];
}

/** A prior connection event lets a retry recover after frontmatter was already written. */
export function hasNoteLinkEvent(
  events: Array<{ type: string; session_id: string | null; payload: Record<string, unknown> }>,
  path: string,
  sessionId?: string | null,
): boolean {
  return events.some((event) => event.type === "note" && (sessionId === undefined || event.session_id === sessionId) &&
    Array.isArray(event.payload.links) && event.payload.links.some((link) =>
      !!link && typeof link === "object" && (link as { path?: unknown; kind?: unknown }).path === path &&
      (link as { kind?: unknown }).kind === "note"));
}

const EMBED_ONLY = /^\s*!\[\[[^\]]+\]\]\s*$/;
const MARKDOWN_IMAGE_ONLY = /^\s*!\[[^\]]*\]\([^)]+\)(?:\s+"[^"]*")?\s*$/;

/** Entry text without lines that only embed a file. Embeds travel as links, not as duplicated text. */
export function entryText(body: string): string {
  return body
    .split("\n")
    .filter((line) => !EMBED_ONLY.test(line) && !MARKDOWN_IMAGE_ONLY.test(line))
    .join("\n")
    .trim();
}

export function entryIdAtLine(entries: NoteEntry[], line: number): string | null {
  for (const entry of entries) if (line >= entry.headerLine && line < entry.bodyEnd) return entry.id;
  return null;
}

/** Leading newline needed so the callout starts on its own line. */
export function insertionPrefix(textBeforeCursor: string): string {
  if (textBeforeCursor === "" || textBeforeCursor.endsWith("\n\n")) return "";
  return textBeforeCursor.endsWith("\n") ? "\n" : "\n\n";
}

const WIKI_EMBED = /!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
const MD_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|((?:\\.|[^\s)])+))(?:\s+"[^"]*")?\s*\)/g;

/** Targets of `![[file]]` and `![alt](file)` embeds, in order, without duplicates. */
export function findEmbeds(body: string): string[] {
  const seen: string[] = [];
  for (const [pattern, decode] of [[WIKI_EMBED, false], [MD_IMAGE, true]] as const) {
    for (const match of body.matchAll(new RegExp(pattern.source, "g"))) {
      let target = (match[1] ?? match[2] ?? "").replace(/\\ /g, " ").trim();
      if (decode) {
        if (/^[a-z]+:\/\//i.test(target)) continue;
        try { target = decodeURIComponent(target); } catch { /* keep raw */ }
      }
      if (!seen.includes(target)) seen.push(target);
    }
  }
  return seen;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"]);

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? "");
}
