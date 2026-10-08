import express from "express";
import { createServer, type Server } from "http";
import path from "path";
import { fileURLToPath } from "url";
import type { Express } from "express";
import { createSearchesRouter } from "./routes/searches.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createOpportunitiesRouter } from "./routes/opportunities.js";
import { createCapabilitiesRouter } from "./routes/capabilities.js";
import { createProductPlanRouter } from "./routes/product-plan.js";
import { opportunityStore } from "./services/opportunity-store.js";
import { loadEnv, resolvedSearchesDir } from "../lib/env.js";
import { ensureLogDirs, log, logFile } from "../lib/log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LISTEN_HOST = "127.0.0.1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeServer(server: Server, ms = 250): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      try {
        server.closeAllConnections?.();
      } catch {
        // ignore
      }
    }),
    sleep(ms),
  ]);
}

async function listenApp(
  app: Express,
  preferredPort: number,
  options: { allowFallback: boolean }
): Promise<{ server: Server; port: number }> {
  const maxPorts = options.allowFallback ? 40 : 1;
  const perPortAttempts = 10;
  let lastError: unknown;

  for (let offset = 0; offset < maxPorts; offset++) {
    const port = preferredPort + offset;
    for (let attempt = 0; attempt < perPortAttempts; attempt++) {
      const server = createServer(app);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            server.removeListener("error", onError);
            server.removeListener("listening", onListening);
            reject(
              Object.assign(new Error(`listen timed out on ${port}`), {
                code: "ETIMEDOUT",
              })
            );
          }, 1000);

          const onError = (err: Error) => {
            clearTimeout(timer);
            server.off("listening", onListening);
            reject(err);
          };
          const onListening = () => {
            clearTimeout(timer);
            server.off("error", onError);
            resolve();
          };

          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, LISTEN_HOST);
        });
        return { server, port };
      } catch (err) {
        lastError = err;
        await closeServer(server);
        const code = (err as NodeJS.ErrnoException).code;
        if (
          code === "EADDRINUSE" ||
          code === "EACCES" ||
          code === "ETIMEDOUT"
        ) {
          await sleep(200);
          continue;
        }
        throw err;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        options.allowFallback
          ? `No free port near ${preferredPort}`
          : `Port ${preferredPort} is busy or listen stalled (stop the old process and retry)`
      );
}

export async function startServer(
  preferredPort: number,
  options: { allowPortFallback?: boolean } = {}
) {
  loadEnv();
  ensureLogDirs();
  const allowFallback = options.allowPortFallback ?? true;
  const dataDir = resolvedSearchesDir();

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(createOpportunitiesRouter());
  app.use(createCapabilitiesRouter());
  app.use(createProductPlanRouter());
  app.use(createSearchesRouter());
  app.use(createSettingsRouter());

  const clientDir = path.join(__dirname, "..", "client");
  app.use(express.static(clientDir));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });

  const { server, port } = await listenApp(app, preferredPort, {
    allowFallback,
  });

  log.info({ port, dataDir, logFile }, "phrases listening");
  console.log(`\n  Phrases is running\n`);
  console.log(`  Local:    http://${LISTEN_HOST}:${port}`);
  console.log(`  Data:     ${dataDir}`);
  console.log(`  Logs:     ${logFile}`);
  console.log(`  SerpAPI:  ${process.env.SERPAPI_KEY ? "key loaded" : "MISSING"}`);
  if (port !== preferredPort) {
    console.log(`  (port ${preferredPort} was in use, using ${port} instead)`);
  }
  console.log("");

  const cleanup = () => {
    opportunityStore.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason.message : String(reason);
    log.error({ err }, "unhandledRejection");
    console.error(`[phrases] unhandledRejection ${err}`);
  });

  return { server, port };
}
