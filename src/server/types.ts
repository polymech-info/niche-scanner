import type { Session } from "../shared/session.js";

export interface PackageInfo {
  name: string;
  path: string;
  relativePath: string;
  scripts: Record<string, string>;
  isRoot: boolean;
}

export interface ManagedProcess {
  id: string;
  packageName: string;
  packagePath: string;
  scriptName: string;
  command: string;
  pid: number | undefined;
  status: "running" | "stopped" | "errored";
  exitCode: number | null;
  startedAt: number;
}

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface AppConfig {
  repoName: string;
  rootPath: string;
  packageManager: PackageManager;
}

export interface WsMessage {
  type:
    | "subscribe"
    | "unsubscribe"
    | "log"
    | "status"
    | "history"
    | "session";
  id?: string;
  stream?: "stdout" | "stderr";
  data?: string;
  status?: ManagedProcess["status"];
  exitCode?: number | null;
  lines?: Array<{ stream: "stdout" | "stderr"; data: string }>;
  session?: Session;
}
