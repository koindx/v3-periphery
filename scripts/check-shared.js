// v3-core and v3-periphery are independent repositories, so the code they share is replicated in
// both. This script checks that the replicated files are identical, with v3-core cloned next to
// v3-periphery: `node scripts/check-shared.js [path to v3-core]` (exit code 1 on any difference).
// The CI of v3-periphery runs it against the current v3-core.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const periphery = path.resolve(__dirname, "..");
const core = path.resolve(process.argv[2] || path.join(periphery, "..", "v3-core"));
const roots = { "v3-core": core, "v3-periphery": periphery };
if (!fs.existsSync(path.join(core, "contracts", "pool"))) {
  console.error(`v3-core not found at ${core}: clone it next to v3-periphery or pass its path`);
  process.exit(1);
}

// [file in v3-core, file in v3-periphery]
const SHARED = [
  // math libraries
  ["libraries/U256.ts", "libraries/U256.ts"],
  ["libraries/TickMath.ts", "libraries/TickMath.ts"],
  ["libraries/FixedPoint.ts", "libraries/FixedPoint.ts"],
  ["libraries/SafeCast.ts", "libraries/SafeCast.ts"],
  // Koinos helpers
  ["utils/Contract.ts", "utils/Contract.ts"],
  ["utils/Tokens.ts", "utils/Tokens.ts"],
  ["utils/Keys.ts", "utils/Keys.ts"],
  ["utils/Abort.ts", "utils/Abort.ts"],
  // interfaces of the core contracts used by the periphery
  ["contracts/pool/assembly/proto/pool.proto", "interfaces/pool.proto"],
  ["contracts/factory/assembly/proto/factory.proto", "interfaces/factory.proto"],
  // proto dependencies
  ["proto/koinos/options.proto", "proto/koinos/options.proto"],
  ["proto/koinos/chain/authority.proto", "proto/koinos/chain/authority.proto"],
  ["proto/google/protobuf/descriptor.proto", "proto/google/protobuf/descriptor.proto"],
  // unit test tooling
  ["scripts/build-harness.js", "scripts/build-harness.js"],
  ["tests/harness.js", "tests/harness.js"],
  ["tests/harness/u256.ts", "tests/harness/u256.ts"],
  ["tests/as-bignum.test.js", "tests/as-bignum.test.js"],
  ["tests/reference.js", "tests/reference.js"],
  // Koinos VM emulator and the helpers of the Uniswap test ports
  ["tests/vm/koinos-vm.js", "tests/vm/koinos-vm.js"],
  ["tests/vm/codec.js", "tests/vm/codec.js"],
  ["tests/vm/token.js", "tests/vm/token.js"],
  ["tests/uniswap/shared/contracts.js", "tests/uniswap/shared/contracts.js"],
  ["tests/uniswap/shared/utilities.js", "tests/uniswap/shared/utilities.js"],
  ["tests/uniswap/shared/format.js", "tests/uniswap/shared/format.js"],
  ["tests/uniswap/shared/snapshot.js", "tests/uniswap/shared/snapshot.js"],
  // the Uniswap reference (Uniswap v3 bytecode in an EVM)
  ["tests/uniswap/evm/uniswap-evm.js", "tests/uniswap/evm/uniswap-evm.js"],
  ["tests/uniswap/evm/TestHelpers.sol", "tests/uniswap/evm/TestHelpers.sol"],
  // tooling configuration
  [".eslintrc.js", ".eslintrc.js"],
  ["LICENSE", "LICENSE"],
];

let failed = false;
for (const [coreFile, peripheryFile] of SHARED) {
  const a = path.join(core, coreFile);
  const b = path.join(periphery, peripheryFile);
  if (!fs.existsSync(a) || !fs.existsSync(b)) {
    console.error(`missing: ${fs.existsSync(a) ? "" : `v3-core/${coreFile} `}${fs.existsSync(b) ? "" : `v3-periphery/${peripheryFile}`}`);
    failed = true;
  } else if (!fs.readFileSync(a).equals(fs.readFileSync(b))) {
    console.error(`different: v3-core/${coreFile} <> v3-periphery/${peripheryFile}`);
    failed = true;
  } else {
    console.log(`ok: ${coreFile}${coreFile === peripheryFile ? "" : ` <> ${peripheryFile}`}`);
  }
}

// contracts call each other by entry point (first 4 bytes of the sha256 of the method name):
// every hardcoded entry point must match the method named in its comment (or its constant name)
const ENTRY_POINT_FILES = [
  "v3-core/contracts/pool/assembly/Pool.ts",
  "v3-core/contracts/factory/assembly/Factory.ts",
  "v3-core/utils/Contract.ts",
  "v3-periphery/interfaces/PoolClient.ts",
  "v3-periphery/interfaces/FactoryClient.ts",
  "v3-periphery/utils/Contract.ts",
];
for (const file of ENTRY_POINT_FILES) {
  const [repository, ...rest] = file.split("/");
  const source = fs.readFileSync(path.join(roots[repository], ...rest), "utf8");
  const regex = /const\s+([A-Z_0-9]+)\s*:\s*u32\s*=\s*(0x[0-9a-fA-F]{8});(?:[ \t]*\/\/[ \t]*([a-z_0-9.]+))?/g;
  for (const [, constant, value, comment] of source.matchAll(regex)) {
    const method = (comment || constant.replace(/_ENTRY$/, "").toLowerCase()).split(".").pop();
    const expected = "0x" + crypto.createHash("sha256").update(method).digest("hex").slice(0, 8);
    if (expected !== value.toLowerCase()) {
      console.error(`${file}: ${constant} = ${value} but the entry point of ${method} is ${expected}`);
      failed = true;
    } else {
      console.log(`ok: ${file} ${constant} = ${value} (${method})`);
    }
  }
}

if (failed) {
  console.error("\nshared files must be identical in v3-core and v3-periphery: copy the changes to both");
  process.exit(1);
}
