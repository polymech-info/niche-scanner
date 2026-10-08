import { compileCapabilities } from "../../src/lib/capability-refresh.js";

const { outputPath, snapshot } = await compileCapabilities();
process.stdout.write(
  `${outputPath} (${snapshot.capabilities.length} capabilities, ${snapshot.workflows.length} workflows)\n`
);
