// Copies the release builds (wasm + ABI) of the KoinDX v3 core contracts used by the unit tests
// (the periphery works with the factory and the pools of v3-core) into tests/core/.
// usage: node scripts/sync-core.js [path to v3-core] (by default v3-core cloned next to this
// repository). The CI checks that the committed files match the current v3-core sources.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const core = path.resolve(process.argv[2] || path.join(root, "..", "v3-core"));

for (const name of ["factory", "pool"]) {
  const dir = path.join(core, "contracts", name);
  const out = path.join(root, "tests", "core", name);
  fs.mkdirSync(out, { recursive: true });
  const files = [
    [path.join(dir, "build", "release", "contract.wasm"), path.join(out, "contract.wasm")],
    [path.join(dir, "abi", `${name}-abi.json`), path.join(out, `${name}-abi.json`)],
  ];
  for (const [from, to] of files) {
    if (!fs.existsSync(from)) {
      console.error(`${from} not found, build v3-core first (yarn build:release)`);
      process.exit(1);
    }
    fs.copyFileSync(from, to);
  }
  const buildInfo = path.join(dir, "build", "release", "build.json");
  const build = fs.existsSync(buildInfo) ? JSON.parse(fs.readFileSync(buildInfo, "utf8")) : {};
  if (build.debugAbort) {
    console.error(`${name} is a DEBUG_ABORT build: build it with yarn build:release`);
    process.exit(1);
  }
  console.log(`${name}: ${fs.statSync(path.join(out, "contract.wasm")).size} bytes`);
}
