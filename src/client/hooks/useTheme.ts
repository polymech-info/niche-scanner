import { useEffect } from "react";
import { useStore } from "../store/app";

export function useTheme() {
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return theme;
}
