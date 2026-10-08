import type { PackageInfo, PackageManager } from "../types.js";
import { discoverPackages } from "./discovery.js";

/** Mutable package list shared by routers (refreshed after package.json edits). */
export class PackageStore {
  packages: PackageInfo[] = [];

  constructor(
    private rootDir: string,
    private pm: PackageManager
  ) {}

  async refresh(): Promise<PackageInfo[]> {
    this.packages = await discoverPackages(this.rootDir, this.pm);
    return this.packages;
  }

  find(packageName: string): PackageInfo | undefined {
    return this.packages.find((p) => p.name === packageName);
  }
}
