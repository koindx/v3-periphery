// Deploys a periphery contract (release build) to the account of PRIVATE_KEY.
//
// The periphery contracts are deployed overriding their own authority (call contract,
// transaction application and upload contract): the deployer key has no power over them and
// their code can't be modified. This is required by the manager, which owns the liquidity of
// every position in the pools.
//
// usage:
//   CONTRACT=<manager | router | quoter> NETWORK=<network of networks.json> \
//   PRIVATE_KEY=<contract account wif> RPC_URL=<rpc> node scripts/deploy.js
const path = require("path");
const fs = require("fs");
const { Signer, Provider, Contract } = require("koilib");
require("dotenv").config();

const { CONTRACT, NETWORK, PRIVATE_KEY, RPC_URL } = process.env;

async function main() {
  if (!["manager", "router", "quoter"].includes(CONTRACT)) throw new Error("CONTRACT must be manager, router or quoter");
  if (!NETWORK || !PRIVATE_KEY || !RPC_URL) throw new Error("NETWORK, PRIVATE_KEY and RPC_URL are required");

  const dir = path.resolve(__dirname, "..", "contracts", CONTRACT);
  const build = JSON.parse(fs.readFileSync(path.join(dir, "build", "release", "build.json"), "utf8"));
  if (build.network !== NETWORK) {
    throw new Error(`${CONTRACT} was built for the network "${build.network}", run: yarn build:release --network ${NETWORK}`);
  }
  if (build.debugAbort) throw new Error(`${CONTRACT} was built with DEBUG_ABORT=1, rebuild it without it`);

  const abi = JSON.parse(fs.readFileSync(path.join(dir, "abi", `${CONTRACT}-abi.json`), "utf8"));
  abi.koilib_types = abi.types;

  const provider = new Provider(RPC_URL);
  const signer = Signer.fromWif(PRIVATE_KEY);
  signer.provider = provider;

  const contract = new Contract({
    id: signer.address,
    abi,
    provider,
    signer,
    bytecode: fs.readFileSync(path.join(dir, "build", "release", "contract.wasm")),
  });

  console.log(`Deploying ${CONTRACT} (network ${build.network}, factory ${build.factory}) to ${signer.address}...`);
  const { transaction, receipt } = await contract.deploy({
    abi: fs.readFileSync(path.join(dir, "abi", `${CONTRACT}.abi`), "utf8"),
    authorizesCallContract: true,
    authorizesTransactionApplication: true,
    authorizesUploadContract: true,
  });
  console.log(receipt);
  await transaction.wait();
  console.log(`${CONTRACT} deployed at ${signer.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
