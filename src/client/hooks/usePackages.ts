import { useEffect, useState } from "react";
import {
  fetchConfig,
  fetchPackages,
  fetchSessions,
  fetchStatuses,
} from "../lib/api";
import {
  fetchUserConfig,
  migrateLocalStorageUserConfig,
  saveUserConfig,
} from "../lib/user-config";
import { useStore } from "../store/scripts";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadWithRetry(attempts = 30, delayMs = 200) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const [config, packages, statuses, userConfig, sessions] =
        await Promise.all([
          fetchConfig(),
          fetchPackages(),
          fetchStatuses(),
          fetchUserConfig(),
          fetchSessions(),
        ]);
      if (!Array.isArray(packages)) {
        throw new Error("Invalid /api/packages response");
      }
      return { config, packages, statuses, userConfig, sessions };
    } catch (err) {
      lastError = err;
    }
    await sleep(delayMs);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to reach Runny API");
}

export function useInitialize() {
  const setConfig = useStore((s) => s.setConfig);
  const setPackages = useStore((s) => s.setPackages);
  const initFromStatuses = useStore((s) => s.initFromStatuses);
  const applyUserConfig = useStore((s) => s.applyUserConfig);
  const setSessions = useStore((s) => s.setSessions);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadWithRetry()
      .then(async ({ config, packages, statuses, userConfig, sessions }) => {
        if (cancelled) return;
        setConfig(config);
        setPackages(packages);
        initFromStatuses(statuses);
        setSessions(sessions);

        const migrated = migrateLocalStorageUserConfig(userConfig);
        if (migrated) {
          const saved = await saveUserConfig(migrated);
          if (cancelled) return;
          applyUserConfig(saved);
        } else {
          applyUserConfig(userConfig);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [setConfig, setPackages, initFromStatuses, applyUserConfig, setSessions]);

  return { error };
}
