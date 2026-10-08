import { create } from "zustand";

const THEME_KEY = "phrases-theme";

function defaultTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

interface AppState {
  theme: "light" | "dark";
  running: boolean;
  error: string | null;
  sidebarWidth: number;
  query: string;
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;
  setRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  setSidebarWidth: (width: number) => void;
  setQuery: (query: string) => void;
}

export const useStore = create<AppState>((set, get) => ({
  theme: defaultTheme(),
  running: false,
  error: null,
  sidebarWidth: 280,
  query: "",
  setTheme: (theme) => {
    window.localStorage.setItem(THEME_KEY, theme);
    set({ theme });
  },
  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    get().setTheme(theme);
  },
  setRunning: (running) => set({ running }),
  setError: (error) => set({ error }),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  setQuery: (query) => set({ query }),
}));
