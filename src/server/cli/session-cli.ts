import path from "path";
import fs from "fs";
import { detectPackageManager } from "../services/detector.js";
import { processManager } from "../services/process-manager.js";
import { PackageStore } from "../services/package-store.js";
import { sessionManager } from "../services/session-manager.js";
import type { Session } from "../../shared/session.js";

function printHelp() {
  console.log(`
  Usage: runny session <command>

  Commands:
    run <groupPath> [--package <name>] [--no-fail-fast]
        Run all scripts under a colon group sequentially (soft CI).
        Example: runny session run test:agent

    list
        List recent sessions from .runny/sessions

  Options:
    --package <name>   Package name (default: root / first package)
    --no-fail-fast     Continue after a failing step
`);
}

function resolvePackageName(
  store: PackageStore,
  explicit: string | undefined
): string {
  if (explicit) return explicit;
  const root = store.packages.find((p) => p.isRoot);
  if (root) return root.name;
  if (store.packages[0]) return store.packages[0].name;
  throw new Error("No packages found");
}

function formatSession(session: Session): string {
  const passed = session.steps.filter((s) => s.status === "passed").length;
  const total = session.steps.length;
  return `[${session.status}] ${session.packageName} / ${session.groupPath}  ${passed}/${total}`;
}

export async function runSessionCli(
  args: string[],
  targetDir: string
): Promise<number> {
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printHelp();
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);

  const pm = detectPackageManager(targetDir);
  processManager.setPackageManager(pm);
  sessionManager.setRoot(targetDir);
  sessionManager.setPackageManager(pm);

  const store = new PackageStore(targetDir, pm);
  await store.refresh();

  if (command === "list") {
    const dir = path.join(targetDir, ".runny", "sessions");
    if (!fs.existsSync(dir)) {
      console.log("  No sessions yet.");
      return 0;
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 20);
    for (const file of files) {
      try {
        const session = JSON.parse(
          fs.readFileSync(path.join(dir, file), "utf-8")
        ) as Session;
        console.log(`  ${formatSession(session)}  (${session.id.slice(0, 8)})`);
      } catch {
        // skip bad files
      }
    }
    return 0;
  }

  if (command === "run") {
    const groupPath = rest.find((a) => !a.startsWith("--"));
    if (!groupPath) {
      console.error("  Error: groupPath required. Example: runny session run test");
      return 1;
    }

    const pkgIdx = rest.indexOf("--package");
    const packageName = resolvePackageName(
      store,
      pkgIdx !== -1 ? rest[pkgIdx + 1] : undefined
    );
    const failFast = !rest.includes("--no-fail-fast");

    const pkg = store.find(packageName);
    if (!pkg) {
      console.error(`  Error: Package "${packageName}" not found`);
      return 1;
    }

    console.log(
      `\n  Soft CI session: ${packageName} / ${groupPath} (${failFast ? "fail-fast" : "continue"})\n`
    );

    return await new Promise<number>((resolve) => {
      const unsub = sessionManager.onUpdate((session) => {
        const step = session.steps[session.currentIndex];
        if (session.status === "running" && step?.status === "running") {
          console.log(`  → ${step.command}`);
        }
        if (
          step &&
          (step.status === "passed" || step.status === "failed") &&
          step.endedAt
        ) {
          const mark = step.status === "passed" ? "✓" : "✗";
          console.log(
            `  ${mark} ${step.scriptName} (exit ${step.exitCode ?? "?"})`
          );
        }
        if (
          session.status === "passed" ||
          session.status === "failed" ||
          session.status === "cancelled"
        ) {
          unsub();
          console.log(`\n  ${formatSession(session)}\n`);
          console.log(
            `  Session: ${path.join(targetDir, ".runny", "sessions", `${session.id}.json`)}\n`
          );
          resolve(session.status === "passed" ? 0 : 1);
        }
      });

      try {
        sessionManager.startGroup({
          packageName,
          packagePath: pkg.path,
          groupPath,
          scripts: pkg.scripts,
          failFast,
        });
      } catch (err) {
        unsub();
        console.error(
          `  Error: ${err instanceof Error ? err.message : String(err)}`
        );
        resolve(1);
      }
    });
  }

  console.error(`  Unknown session command: ${command}`);
  printHelp();
  return 1;
}
