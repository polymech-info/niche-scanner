/** Compact relative time for finished-script stamps. */
export function formatTimeAgo(at: number | null | undefined, now = Date.now()): string {
  if (at == null || !Number.isFinite(at)) return "";
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(at).toLocaleDateString();
}
