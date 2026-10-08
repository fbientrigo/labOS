// Lookup table from a stable id to the note's current path. No Obsidian imports: testable in Node.
// Keys are "note:<labos-id>" for connected notes and "log:<stable id>" for daily logs.

export type IndexData = Record<string, string>;

export class NoteIndex {
  private map = new Map<string, string>();

  constructor(data: IndexData = {}) {
    for (const [key, path] of Object.entries(data)) this.map.set(key, path);
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, path: string): void {
    this.map.set(key, path);
  }

  /** A moved or renamed note keeps its id, so only the path changes. Folder moves are handled too. */
  rename(oldPath: string, newPath: string): void {
    const folder = oldPath.endsWith("/") ? oldPath : oldPath + "/";
    for (const [key, path] of this.map) {
      if (path === oldPath) this.map.set(key, newPath);
      else if (path.startsWith(folder)) this.map.set(key, newPath.replace(/\/?$/, "/") + path.slice(folder.length));
    }
  }

  removePath(path: string): void {
    const folder = path.endsWith("/") ? path : path + "/";
    for (const [key, value] of this.map) if (value === path || value.startsWith(folder)) this.map.delete(key);
  }

  /** Replace every entry of one kind ("note:" or "log:") with fresh results from a scan. */
  replaceKind(prefix: string, entries: Array<[string, string]>): void {
    for (const key of Array.from(this.map.keys())) if (key.startsWith(prefix)) this.map.delete(key);
    for (const [key, path] of entries) this.map.set(prefix + key, path);
  }

  toJSON(): IndexData {
    return Object.fromEntries(this.map);
  }
}
