import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { collectGroupScripts } from "../../shared/group-scripts.js";
import type { Session, SessionStep } from "../../shared/session.js";
import type { PackageManager } from "../types.js";
import { getRunCommand } from "./detector.js";
import { processManager } from "./process-manager.js";

type SessionListener = (session: Session) => void;

function sessionsDir(rootPath: string): string {
  return path.join(rootPath, ".runny", "sessions");
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function cloneSession(session: Session): Session {
  return structuredClone(session);
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private listeners = new Set<SessionListener>();
  private cancelling = new Set<string>();
  private packageManager: PackageManager = "npm";
  private rootPath = "";

  setRoot(rootPath: string) {
    this.rootPath = rootPath;
    ensureDir(sessionsDir(rootPath));
  }

  setPackageManager(pm: PackageManager) {
    this.packageManager = pm;
  }

  onUpdate(listener: SessionListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): Session[] {
    return Array.from(this.sessions.values())
      .map(cloneSession)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    return s ? cloneSession(s) : undefined;
  }

  activeForGroup(packageName: string, groupPath: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (
        s.packageName === packageName &&
        s.groupPath === groupPath &&
        (s.status === "queued" || s.status === "running")
      ) {
        return cloneSession(s);
      }
    }
    return undefined;
  }

  /**
   * Start a sequential soft-CI session for a colon group.
   * Collects npm-run commands from package scripts under `groupPath`.
   */
  startGroup(opts: {
    packageName: string;
    packagePath: string;
    groupPath: string;
    scripts: Record<string, string>;
    failFast?: boolean;
  }): Session {
    const entries = Object.entries(opts.scripts).filter(
      ([name]) => !name.startsWith("---")
    ) as [string, string][];
    const collected = collectGroupScripts(entries, opts.groupPath);
    if (collected.length === 0) {
      throw new Error(`No scripts found under group "${opts.groupPath}"`);
    }

    return this.startSteps({
      packageName: opts.packageName,
      packagePath: opts.packagePath,
      groupPath: opts.groupPath,
      steps: collected.map(([scriptName]) => ({
        packageName: opts.packageName,
        packagePath: opts.packagePath,
        scriptName,
      })),
      failFast: opts.failFast,
    });
  }

  /**
   * Start a sequential session from an explicit script list
   * (favourite groups may span packages).
   */
  startSteps(opts: {
    packageName: string;
    packagePath: string;
    groupPath: string;
    steps: Array<{
      packageName: string;
      packagePath: string;
      scriptName: string;
    }>;
    failFast?: boolean;
  }): Session {
    const existing = this.activeForGroup(opts.packageName, opts.groupPath);
    if (existing) {
      throw new Error(
        `Session already running for ${opts.packageName} / ${opts.groupPath}`
      );
    }

    if (opts.steps.length === 0) {
      throw new Error("No scripts to run");
    }

    const runCmd = getRunCommand(this.packageManager);
    const steps: SessionStep[] = opts.steps.map((step) => ({
      scriptName: step.scriptName,
      packageName: step.packageName,
      packagePath: step.packagePath,
      command: `${runCmd} ${step.scriptName}`,
      status: "pending",
      exitCode: null,
      startedAt: null,
      endedAt: null,
    }));

    const session: Session = {
      id: randomUUID(),
      packageName: opts.packageName,
      packagePath: opts.packagePath,
      groupPath: opts.groupPath,
      mode: "sequential",
      failFast: opts.failFast !== false,
      status: "queued",
      steps,
      currentIndex: 0,
      startedAt: Date.now(),
      endedAt: null,
    };

    this.sessions.set(session.id, session);
    this.persist(session);
    this.emit(session);

    void this.runSequential(session.id);
    return cloneSession(session);
  }

  cancel(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.status !== "queued" && session.status !== "running") {
      return cloneSession(session);
    }

    this.cancelling.add(id);
    const current = session.steps[session.currentIndex];
    if (current?.status === "running") {
      const pkgName = current.packageName ?? session.packageName;
      const procId = processManager.makeId(pkgName, current.scriptName);
      processManager.stop(procId);
    }

    for (const step of session.steps) {
      if (step.status === "pending" || step.status === "running") {
        step.status = "skipped";
        step.endedAt = Date.now();
      }
    }
    session.status = "cancelled";
    session.endedAt = Date.now();
    this.persist(session);
    this.emit(session);
    return cloneSession(session);
  }

  private async runSequential(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = "running";
    this.persist(session);
    this.emit(session);

    for (let i = 0; i < session.steps.length; i++) {
      if (this.cancelling.has(sessionId)) break;

      session.currentIndex = i;
      const step = session.steps[i];
      step.status = "running";
      step.startedAt = Date.now();
      this.persist(session);
      this.emit(session);

      const pkgName = step.packageName ?? session.packageName;
      const pkgPath = step.packagePath ?? session.packagePath;
      const { exitCode, status } = await processManager.runAndWait(
        pkgName,
        pkgPath,
        step.scriptName
      );

      if (this.cancelling.has(sessionId)) {
        // cancel() already finalized
        break;
      }

      step.exitCode = exitCode;
      step.endedAt = Date.now();
      const passed = status === "stopped" && exitCode === 0;
      step.status = passed ? "passed" : "failed";
      this.persist(session);
      this.emit(session);

      if (!passed && session.failFast) {
        for (let j = i + 1; j < session.steps.length; j++) {
          session.steps[j].status = "skipped";
          session.steps[j].endedAt = Date.now();
        }
        session.status = "failed";
        session.endedAt = Date.now();
        this.persist(session);
        this.emit(session);
        this.cancelling.delete(sessionId);
        return;
      }
    }

    if (this.cancelling.has(sessionId)) {
      this.cancelling.delete(sessionId);
      return;
    }

    const anyFailed = session.steps.some((s) => s.status === "failed");
    session.status = anyFailed ? "failed" : "passed";
    session.endedAt = Date.now();
    this.persist(session);
    this.emit(session);
  }

  private emit(session: Session) {
    const snap = cloneSession(session);
    this.listeners.forEach((fn) => fn(snap));
  }

  private persist(session: Session) {
    if (!this.rootPath) return;
    const dir = sessionsDir(this.rootPath);
    ensureDir(dir);
    const file = path.join(dir, `${session.id}.json`);
    fs.writeFileSync(file, JSON.stringify(session, null, 2), "utf-8");
  }
}

export const sessionManager = new SessionManager();
