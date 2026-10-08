export type LogStream = "stdout" | "stderr";

export interface TerminalStreamFilters {
  stdout: boolean;
  stderr: boolean;
}

const STORAGE_KEY = "runny-terminal-stream-filters";

export const DEFAULT_STREAM_FILTERS: TerminalStreamFilters = {
  stdout: true,
  stderr: true,
};

export function loadStreamFilters(): TerminalStreamFilters {
  if (typeof window === "undefined") return { ...DEFAULT_STREAM_FILTERS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STREAM_FILTERS };
    const parsed = JSON.parse(raw) as Partial<TerminalStreamFilters>;
    return {
      stdout: typeof parsed.stdout === "boolean" ? parsed.stdout : true,
      stderr: typeof parsed.stderr === "boolean" ? parsed.stderr : true,
    };
  } catch {
    return { ...DEFAULT_STREAM_FILTERS };
  }
}

export function saveStreamFilters(filters: TerminalStreamFilters): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // ignore quota / private mode
  }
}

export function lineVisible(
  stream: string | undefined,
  filters: TerminalStreamFilters
): boolean {
  if (stream === "stderr") return filters.stderr;
  // Treat unknown / missing as stdout.
  return filters.stdout;
}
