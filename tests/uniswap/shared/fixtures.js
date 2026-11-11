// Port of the Uniswap v3-periphery test fixtures (test/shared/completeFixture.ts): the v3-core
// factory and pools (tests/core, synced by scripts/sync-core.js), 3 sorted test tokens, the
// position manager (nft), the swap router and the quoter of this package, in the Koinos VM
// emulator.
const fs = require("fs");
const path = require("path");
const { KoinosVM } = require("../../vm/koinos-vm");
const { TestToken } = require("../../vm/token");
const { Codec } = require("../../vm/codec");
const { loadContract, ContractClient } = require("./contracts");
const { MaxUint64 } = require("./utilities");

// the factory address compiled in the local build of the periphery (networks.json)
const FACTORY_ADDRESS = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "networks.json"), "utf8")).local.factory;

// Monday, October 5, 2020 9:00:00 AM GMT-05:00
const TEST_TIME = 1601906400;

const CONTRACTS = {};

/** the v3-core contracts (factory, pool) */
function coreContract(name) {
  if (!CONTRACTS[`core:${name}`]) {
    const dir = path.join(__dirname, "..", "..", "core", name);
    const abi = JSON.parse(fs.readFileSync(path.join(dir, `${name}-abi.json`), "utf8"));
    CONTRACTS[`core:${name}`] = { name, abi, codec: new Codec(abi), wasm: fs.readFileSync(path.join(dir, "contract.wasm")) };
  }
  return CONTRACTS[`core:${name}`];
}

/** the contracts of this package (manager, router, quoter), local network build */
function contract(name) {
  if (!CONTRACTS[name]) {
    const loaded = loadContract(name);
    const buildInfo = path.join(__dirname, "..", "..", "..", "contracts", name, "build", "release", "build.json");
    const build = fs.existsSync(buildInfo) ? JSON.parse(fs.readFileSync(buildInfo, "utf8")) : {};
    if (build.network !== undefined && build.network !== "local") throw new Error(`${name} must be built for the local network (yarn build:release --network local)`);
    CONTRACTS[name] = loaded;
  }
  return CONTRACTS[name];
}

class PoolClient extends ContractClient {
  constructor(vm, address) {
    super(vm, address, coreContract("pool"));
  }
  slot0() {
    const s = this.read("slot0");
    return { ...s, sqrtPriceX96: BigInt(s.sqrtPriceX96) };
  }
  liquidity() {
    return BigInt(this.read("liquidity").value);
  }
  feeGrowthGlobal0X128() {
    return BigInt(this.read("fee_growth_global").feeGrowthGlobal0X128);
  }
  feeGrowthGlobal1X128() {
    return BigInt(this.read("fee_growth_global").feeGrowthGlobal1X128);
  }
  positions(owner, tickLower, tickUpper) {
    const p = this.read("positions", { owner: typeof owner === "string" ? owner : owner.address, tickLower, tickUpper });
    return {
      liquidity: BigInt(p.liquidity),
      feeGrowthInside0LastX128: BigInt(p.feeGrowthInside0LastX128),
      feeGrowthInside1LastX128: BigInt(p.feeGrowthInside1LastX128),
      tokensOwed0: BigInt(p.tokensOwed0),
      tokensOwed1: BigInt(p.tokensOwed1),
    };
  }
  ticks(tick) {
    const t = this.read("ticks", { tick });
    return { ...t, liquidityGross: BigInt(t.liquidityGross), liquidityNet: BigInt(t.liquidityNet) };
  }
  increaseObservationCardinalityNext(observationCardinalityNext, from) {
    return this.send(from, "increase_observation_cardinality_next", { observationCardinalityNext });
  }
}

const sortTokens = (a, b) => (a < b ? [a, b] : [b, a]);

/** completeFixture of Uniswap */
function completeFixture() {
  const vm = new KoinosVM({ time: BigInt(TEST_TIME) * 1000n });
  const wallet = vm.account("wallet");
  const other = vm.account("other");

  vm.deployWasm(FACTORY_ADDRESS, coreContract("factory").wasm, { authorizesUploadContract: true });
  const factory = new ContractClient(vm, FACTORY_ADDRESS, coreContract("factory"));
  // Uniswap: the deployer (wallet) owns the factory
  // two-step ownership transfer: proposed, then accepted by the new owner
  factory.send(FACTORY_ADDRESS, "set_owner", { owner: wallet.address });
  factory.send(wallet, "accept_owner", {});

  const tokens = ["A", "B", "C"].map((name) => TestToken.deploy(vm, `token${name}`)).sort((a, b) => (a.address < b.address ? -1 : 1));
  // Uniswap mints 2^255 to the wallet: Koinos tokens are u64
  for (const token of tokens) token.mint(wallet.address, MaxUint64);

  const deploy = (name) => {
    const { address } = vm.account(name);
    vm.deployWasm(address, contract(name).wasm, { authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true });
    return new ContractClient(vm, address, contract(name));
  };
  const nft = deploy("manager");
  const router = deploy("router");
  const quoter = deploy("quoter");

  /**
   * `owners` approve `spender` for all their tokens (Uniswap: token.approve(spender, MaxUint256)):
   * Koinos tokens (KCS-4) only let a contract move the tokens of an account up to its allowance
   */
  function approve(spender, owners = [wallet, other]) {
    const address = typeof spender === "string" ? spender : spender.address;
    for (const token of tokens) for (const owner of owners) token.approve(owner.address, address, MaxUint64);
  }
  // the position manager and the router pay the pools with the tokens of their users
  approve(nft);
  approve(router);

  let poolCounter = 0;
  /**
   * Creates a pool through the factory: the pool bytecode is uploaded in the same transaction (the
   * production flow). With a price, the pool is initialized in the same transaction through the
   * manager (Uniswap: nft.createAndInitializePoolIfNecessary).
   */
  function createPool(tokenA, tokenB, fee, sqrtPriceX96) {
    const poolAccount = vm.account(`pool:${++poolCounter}`);
    const operations = [
      {
        upload: {
          contractId: poolAccount.address,
          bytecode: coreContract("pool").wasm,
          authorizesCallContract: true,
          authorizesTransactionApplication: true,
          authorizesUploadContract: true,
        },
      },
      factory.operation("create_pool", { tokenA, tokenB, fee }),
    ];
    if (sqrtPriceX96 !== undefined) {
      const [token0, token1] = sortTokens(tokenA, tokenB);
      operations.push(nft.operation("initialize_pool_if_necessary", { token0, token1, fee, sqrtPriceX96: sqrtPriceX96.toString() }));
    }
    vm.transaction({ signers: [poolAccount.address, wallet.address], operations });
    return new PoolClient(vm, poolAccount.address);
  }

  /** the pool of a pair (the factory) */
  function getPool(tokenA, tokenB, fee) {
    const address = factory.read("get_pool", { tokenA, tokenB, fee }).value;
    return address ? new PoolClient(vm, address) : null;
  }

  return { vm, wallet, other, factory, tokens, nft, router, quoter, createPool, getPool, approve };
}

module.exports = { completeFixture, coreContract, contract, PoolClient, sortTokens, FACTORY_ADDRESS, TEST_TIME };
