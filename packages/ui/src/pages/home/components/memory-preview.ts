export type MemoryPreviewLine = { text: string; added: boolean };

/** Existing file lines stay unmarked. Config lines the file does not already contain are additions. */
export function memoryPreviewLines(before: string, proposed: string): MemoryPreviewLine[] {
  const existingText = before.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const existing = new Set(existingText.split("\n").map((line) => line.trim()).filter(Boolean));
  const additions: string[] = [];
  for (const line of proposed.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (additions.length) additions.push("");
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    if (/^\[ai-memory\]/i.test(trimmed) || /^(INFO|WARN|ERROR)\b/i.test(trimmed) || /^\d{4}-\d{2}-\d{2}T/.test(trimmed)) continue;
    if (existing.has(trimmed)) continue;
    additions.push(line);
  }
  while (additions.at(-1) === "") additions.pop();
  const lines: MemoryPreviewLine[] = [];
  if (existingText) for (const text of existingText.split("\n")) lines.push({ text, added: false });
  if (additions.length) {
    if (lines.length) lines.push({ text: "", added: false });
    for (const text of additions) lines.push({ text, added: true });
  }
  return lines;
}
