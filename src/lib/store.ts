import fs from "fs/promises";
import path from "path";
import type { SearchDocument, SearchSummary } from "../shared/phrases.js";
import { summarize } from "../shared/phrases.js";

export class SearchStore {
  constructor(readonly dir: string) {}

  private fileFor(id: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{1,80}$/i.test(id)) {
      throw new Error(`Invalid search id: ${id}`);
    }
    return path.join(this.dir, `${id}.json`);
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<SearchSummary[]> {
    await this.ensureDir();
    const names = await fs.readdir(this.dir);
    const docs: SearchSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const doc = await this.readFile(path.join(this.dir, name));
        docs.push(summarize(doc));
      } catch {
        // skip corrupt files
      }
    }
    docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return docs;
  }

  async get(id: string): Promise<SearchDocument> {
    return this.readFile(this.fileFor(id));
  }

  async save(doc: SearchDocument): Promise<SearchDocument> {
    await this.ensureDir();
    const file = this.fileFor(doc.id);
    const tmp = `${file}.${process.pid}.tmp`;
    const payload = `${JSON.stringify(doc, null, 2)}\n`;
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, file);
    return doc;
  }

  async delete(id: string): Promise<void> {
    await fs.unlink(this.fileFor(id));
  }

  private async readFile(file: string): Promise<SearchDocument> {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as SearchDocument;
  }
}
