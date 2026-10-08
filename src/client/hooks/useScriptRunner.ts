import { useCallback } from "react";
import { runScript, stopScript } from "../lib/api";
import { useStore } from "../store/scripts";

export function useScriptRunner() {
  const setScriptStatus = useStore((s) => s.setScriptStatus);
  const selectScript = useStore((s) => s.selectScript);

  const run = useCallback(
    async (packageName: string, scriptName: string) => {
      const id = `${packageName}:${scriptName}`;
      setScriptStatus(id, "running");
      selectScript(id);
      await runScript(packageName, scriptName);
    },
    [setScriptStatus, selectScript]
  );

  const stop = useCallback(
    async (packageName: string, scriptName: string) => {
      const id = `${packageName}:${scriptName}`;
      await stopScript(id);
    },
    []
  );

  return { run, stop };
}
