import { spawn, type ChildProcess } from "child_process";
import treeKill from "tree-kill";
import type { ManagedProcess, PackageManager } from "../types.js";
import { getRunCommand } from "./detector.js";

interface InternalProcess extends ManagedProcess {
  process: ChildProcess;
  logBuffer: Array<{ stream: "stdout" | "stderr"; data: string }>;
}

type LogListener = (
  id: string,
  stream: "stdout" | "stderr",
  data: string
) => void;
type StatusListener = (
  id: string,
  status: ManagedProcess["status"],
  exitCode: number | null
) => void;

const MAX_BUFFER_LINES = 1000;

export class ProcessManager {
  private processes = new Map<string, InternalProcess>();
  private logListeners = new Set<LogListener>();
  private statusListeners = new Set<StatusListener>();
  private packageManager: PackageManager = "npm";

  setPackageManager(pm: PackageManager) {
    this.packageManager = pm;
  }

  makeId(packageName: string, scriptName: string): string {
    return `${packageName}:${scriptName}`;
  }

  private _spawn(
    id: string,
    packageName: string,
    packagePath: string,
    scriptName: string,
    command: string
  ): ManagedProcess {
    const child = spawn(command, {
      cwd: packagePath,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "1" },
    });

    const managed: InternalProcess = {
      id,
      packageName,
      packagePath,
      scriptName,
      command,
      pid: child.pid,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      process: child,
      logBuffer: [],
    };

    this.processes.set(id, managed);

    const appendLog = (stream: "stdout" | "stderr", data: string) => {
      const lines = data.split("\n");
      for (const line of lines) {
        if (line.length === 0) continue;
        managed.logBuffer.push({ stream, data: line });
        if (managed.logBuffer.length > MAX_BUFFER_LINES) {
          managed.logBuffer.shift();
        }
        this.logListeners.forEach((fn) => fn(id, stream, line));
      }
    };

    child.stdout?.on("data", (chunk: Buffer) =>
      appendLog("stdout", chunk.toString())
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      appendLog("stderr", chunk.toString())
    );

    child.on("close", (code) => {
      managed.exitCode = code;
      managed.status = code === 0 ? "stopped" : "errored";
      this.statusListeners.forEach((fn) =>
        fn(id, managed.status, managed.exitCode)
      );
    });

    child.on("error", () => {
      managed.status = "errored";
      managed.exitCode = -1;
      this.statusListeners.forEach((fn) => fn(id, "errored", -1));
    });

    this.statusListeners.forEach((fn) => fn(id, "running", null));

    return {
      id: managed.id,
      packageName: managed.packageName,
      packagePath: managed.packagePath,
      scriptName: managed.scriptName,
      command: managed.command,
      pid: managed.pid,
      status: managed.status,
      exitCode: managed.exitCode,
      startedAt: managed.startedAt,
    };
  }

  runRaw(id: string, cwd: string, command: string): ManagedProcess {
    const existing = this.processes.get(id);
    if (existing && existing.status === "running") {
      this.stop(id);
    }
    return this._spawn(id, id, cwd, id, command);
  }

  run(
    packageName: string,
    packagePath: string,
    scriptName: string
  ): ManagedProcess {
    const id = this.makeId(packageName, scriptName);

    const existing = this.processes.get(id);
    if (existing && existing.status === "running") {
      this.stop(id);
    }

    const runCmd = getRunCommand(this.packageManager);
    const command = `${runCmd} ${scriptName}`;

    return this._spawn(id, packageName, packagePath, scriptName, command);
  }

  /** Run a script and resolve when it exits (passed/errored). */
  runAndWait(
    packageName: string,
    packagePath: string,
    scriptName: string
  ): Promise<{ exitCode: number | null; status: ManagedProcess["status"] }> {
    const id = this.makeId(packageName, scriptName);
    return new Promise((resolve) => {
      const unsub = this.onStatus((sid, status, exitCode) => {
        if (sid !== id || status === "running") return;
        unsub();
        resolve({ exitCode, status });
      });
      this.run(packageName, packagePath, scriptName);
    });
  }

  stop(id: string): boolean {
    const managed = this.processes.get(id);
    if (!managed || managed.status !== "running") return false;

    if (managed.pid) {
      treeKill(managed.pid, "SIGTERM", (err) => {
        if (err) {
          treeKill(managed.pid!, "SIGKILL");
        }
      });
    }
    return true;
  }

  getStatus(id: string): ManagedProcess | undefined {
    const managed = this.processes.get(id);
    if (!managed) return undefined;
    return {
      id: managed.id,
      packageName: managed.packageName,
      packagePath: managed.packagePath,
      scriptName: managed.scriptName,
      command: managed.command,
      pid: managed.pid,
      status: managed.status,
      exitCode: managed.exitCode,
      startedAt: managed.startedAt,
    };
  }

  getAllStatuses(): ManagedProcess[] {
    return Array.from(this.processes.values()).map((p) => ({
      id: p.id,
      packageName: p.packageName,
      packagePath: p.packagePath,
      scriptName: p.scriptName,
      command: p.command,
      pid: p.pid,
      status: p.status,
      exitCode: p.exitCode,
      startedAt: p.startedAt,
    }));
  }

  getLogBuffer(id: string): Array<{ stream: "stdout" | "stderr"; data: string }> {
    return this.processes.get(id)?.logBuffer ?? [];
  }

  onLog(listener: LogListener) {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onStatus(listener: StatusListener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  killAll() {
    for (const [, managed] of this.processes) {
      if (managed.status === "running" && managed.pid) {
        treeKill(managed.pid, "SIGKILL");
      }
    }
  }
}

export const processManager = new ProcessManager();
