export function generateBacklogFilename(title: string, date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const mins = pad(date.getUTCMinutes());
  const secs = pad(date.getUTCSeconds());

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return `issue-${year}${month}${day}-${hours}${mins}${secs}-${slug || "untitled"}.md`;
}

export function parseBacklogFilename(filename: string): { timestamp: string; slug: string } | null {
  const match = filename.match(/^issue-(\d{8}-\d{6})-(.+)\.md$/);
  if (!match || !match[1] || !match[2]) return null;
  return {
    timestamp: match[1],
    slug: match[2],
  };
}
