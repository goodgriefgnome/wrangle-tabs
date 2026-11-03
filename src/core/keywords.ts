const STOP = new Set([
  "the", "and", "for", "with", "things", "stuff", "about", "from", "into", "that", "this",
  "tabs", "www", "com", "org", "net", "https", "http", "html", "htm", "php", "index",
]);

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Text describing a tab for keyword matching: title, host and path. */
export function tabText(title: string, url: string): string {
  try {
    const u = new URL(url);
    return `${title} ${u.hostname} ${u.pathname}`;
  } catch {
    return title;
  }
}

/** How many words of a group's name and hint appear (as prefixes) in a tab's text. */
export function keywordScore(groupText: string, text: string): number {
  const hay = words(text);
  return words(groupText).filter((w) => hay.some((h) => h.startsWith(w) || (h.length >= 4 && w.startsWith(h)))).length;
}
