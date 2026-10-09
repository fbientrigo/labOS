// Pure helper for checkpoint fingerprints. No Obsidian imports: testable in Node.
//
// The files to fingerprint come from one setting, one absolute path per line. A hash taken now says
// nothing about the past, so historical checkpoints get none.

export function fingerprintTargets(setting: string, historical: boolean): string[] {
  if (historical) return [];
  const seen = new Set<string>();
  for (const line of setting.split(/\r?\n/)) {
    const path = line.trim();
    if (path) seen.add(path);
  }
  return Array.from(seen);
}
