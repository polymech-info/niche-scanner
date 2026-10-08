import { captureCapabilities } from "../../src/lib/capability-refresh.js";

const result = await captureCapabilities();
process.stdout.write(`${result.outDir}\n`);
