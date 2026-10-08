export type SessionStepStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

export type SessionStatus = "queued" | "running" | "passed" | "failed" | "cancelled";

export interface SessionStep {
  scriptName: string;
  /** Override when steps span multiple packages (favourite groups). */
  packageName?: string;
  packagePath?: string;
  /** Shell command that will be executed, e.g. `npm run test:unit`. */
  command: string;
  status: SessionStepStatus;
  exitCode: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface Session {
  id: string;
  packageName: string;
  packagePath: string;
  groupPath: string;
  mode: "sequential";
  failFast: boolean;
  status: SessionStatus;
  steps: SessionStep[];
  currentIndex: number;
  startedAt: number;
  endedAt: number | null;
}

export type SessionEvent =
  | { type: "session"; session: Session }
  | { type: "sessions"; sessions: Session[] };
