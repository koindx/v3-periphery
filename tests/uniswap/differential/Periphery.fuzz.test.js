// Differential fuzzing of the periphery: random sequences of position manager operations (mint,
// increase, decrease, collect, burn, by the owner or not) and router swaps (exact input / output,
// single and multi hop, price limits) run on KoinDX (the compiled manager, router and v3-core
// pools in the Koinos VM emulator) and on the Uniswap reference (the published
// NonfungiblePositionManager, SwapRouter, factory and pool bytecode in an EVM, tests/uniswap/evm).
// After every operation both must agree on the outcome (success, or failure with the same
// reason), the returned amounts, the positions of every NFT, the pools and the token balances.
//
// PERIPHERY_FUZZ_RUNS (default 3) sequences of PERIPHERY_FUZZ_OPS (default 50) operations,
// starting with the seed PERIPHERY_FUZZ_SEED (default 1). A failure reports the seed and the
// operation.
const { TransactionError } = require("../../vm/koinos-vm");
const { UniswapEVM, EvmRevert } = require("../evm/uniswap-evm");
const { completeFixture } = require("../shared/fixtures");
const { encodePriceSqrt, FeeAmount, TICK_SPACINGS, getMinTick, getMaxTick, MaxUint64, MIN_SQRT_RATIO, MAX_SQRT_RATIO } = require("../shared/utilities");

const NPM = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
const SWAP_ROUTER = require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json");

const RUNS = Number(process.env.PERIPHERY_FUZZ_RUNS || 3);
const OPS = Number(process.env.PERIPHERY_FUZZ_OPS || 50);
const FIRST_SEED = Number(process.env.PERIPHERY_FUZZ_SEED || 1);

const FEE = FeeAmount.MEDIUM;
const SPACING = TICK_SPACINGS[FEE];
const MaxUint256 = (1n << 256n) - 1n;
const DEADLINE = 1n << 40n; // seconds (Uniswap), far in the future

/** mulberry32 */
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (list) => list[int(0, list.length - 1)],
    chance: (p) => next() < p,
    amount: (maxExp) => {
      const value = BigInt(Math.floor(10 ** (next() * maxExp)));
      return value > 0n ? value : 1n;
    },
  };
}

// revert reasons: KoinDX and Uniswap → common names
const KOINDX_REASONS = {
  NOT_APPROVED: "Not approved",
  NOT_CLEARED: "Not cleared",
  INVALID_TOKEN_ID: "Invalid token ID",
  PRICE_SLIPPAGE_CHECK: "Price slippage check",
  TOO_LITTLE_RECEIVED: "Too little received",
  TOO_MUCH_REQUESTED: "Too much requested",
  INVALID_AMOUNT_IN: "AS",
  INVALID_AMOUNT_OUT: "AS",
  LIQUIDITY_SUB: "LS",
  // Koinos: an amount above 2^64 can't be paid (Uniswap fails on the balance, which is u64 here)
  AMOUNT_OVERFLOW: "BALANCE",
  // Uniswap: require without a reason
  ZERO_LIQUIDITY: "",
  INSUFFICIENT_LIQUIDITY: "",
  INVALID_AMOUNTS: "",
  INSUFFICIENT_OUTPUT_AMOUNT: "",
  INVALID_SWAP_DELTAS: "",
  TICK_NOT_SPACED: "",
  DIVISION_BY_ZERO: "",
};

function koindxReason(message) {
  if (message.includes("insufficient balance")) return "BALANCE";
  const reason = message.replace(/^KOINDX: /, "");
  return reason in KOINDX_REASONS ? KOINDX_REASONS[reason] : reason;
}

function uniswapReason(message) {
  if (message === "reverted without a reason") return "";
  if (message === "STF" || message === "insufficient balance" || message === "insufficient allowance") return "BALANCE";
  if (message === "ERC721: owner query for nonexistent token" || message === "ERC721: operator query for nonexistent token") return "Invalid token ID";
  return message;
}

const big = (v) => (v && v._isBigNumber ? BigInt(v.toString()) : typeof v === "number" ? BigInt(v) : BigInt(v));

/** KoinDX in the Koinos VM emulator */
function koindxDriver() {
  const fixture = completeFixture();
  const { wallet, other, tokens, nft, router } = fixture;
  const who = (name) => (name === "other" ? other : wallet);
  const pools = [
    fixture.createPool(tokens[0].address, tokens[1].address, FEE, encodePriceSqrt(1, 1)),
    fixture.createPool(tokens[1].address, tokens[2].address, FEE, encodePriceSqrt(1, 1)),
  ];
  const id = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
  };
  const run = (fn, result) => {
    // Koinos tokens (KCS-4) decrement every allowance, also the max u64: the accounts approve the
    // manager and the router again, like the unlimited allowance of the reference (2^256 - 1)
    fixture.approve(nft);
    fixture.approve(router);
    try {
      const { result: r } = fn();
      return { ok: true, result: result(r) };
    } catch (e) {
      if (!(e instanceof TransactionError)) throw e;
      return Object.defineProperty({ ok: false, reason: koindxReason(e.message) }, "message", { value: e.message });
    }
  };
  const amounts = (r) => ({ amount0: big(r.amount0), amount1: big(r.amount1) });
  return {
    mint: (pool, recipient, tickLower, tickUpper, amount0Desired, amount1Desired) =>
      run(
        () =>
          nft.send(wallet, "mint", {
            from: wallet.address,
            recipient: who(recipient).address,
            token0: tokens[pool].address,
            token1: tokens[pool + 1].address,
            fee: FEE,
            tickLower,
            tickUpper,
            amount0Desired: amount0Desired.toString(),
            amount1Desired: amount1Desired.toString(),
            amount0Min: "0",
            amount1Min: "0",
            deadline: "9999999999999",
          }),
        (r) => ({ tokenId: Number(Buffer.from(r.tokenId, "base64").readBigUInt64BE()), liquidity: big(r.liquidity), ...amounts(r) })
      ),
    increaseLiquidity: (tokenId, amount0Desired, amount1Desired) =>
      run(
        () =>
          nft.send(wallet, "increase_liquidity", {
            from: wallet.address,
            tokenId: id(tokenId),
            amount0Desired: amount0Desired.toString(),
            amount1Desired: amount1Desired.toString(),
            amount0Min: "0",
            amount1Min: "0",
            deadline: "9999999999999",
          }),
        (r) => ({ liquidity: big(r.liquidity), ...amounts(r) })
      ),
    decreaseLiquidity: (from, tokenId, liquidity) =>
      run(
        () => nft.send(who(from), "decrease_liquidity", { from: who(from).address, tokenId: id(tokenId), liquidity: liquidity.toString(), amount0Min: "0", amount1Min: "0", deadline: "9999999999999" }),
        amounts
      ),
    collect: (from, tokenId, amount0Max, amount1Max) =>
      run(
        () => nft.send(who(from), "collect", { from: who(from).address, tokenId: id(tokenId), recipient: who(from).address, amount0Max: amount0Max.toString(), amount1Max: amount1Max.toString() }),
        amounts
      ),
    burn: (from, tokenId) => run(() => nft.send(who(from), "burn", { tokenId: id(tokenId), from: who(from).address }), () => ({})),
    exactInputSingle: (tokenIn, tokenOut, amountIn, limit) =>
      run(
        () =>
          router.send(wallet, "exact_input_single", {
            from: wallet.address,
            recipient: other.address,
            tokenIn: tokens[tokenIn].address,
            tokenOut: tokens[tokenOut].address,
            fee: FEE,
            amountIn: amountIn.toString(),
            amountOutMinimum: "0",
            sqrtPriceLimitX96: limit ? limit.toString() : "",
            deadline: "9999999999999",
          }),
        (r) => ({ amount: big(r.amountOut) })
      ),
    exactOutputSingle: (tokenIn, tokenOut, amountOut, limit) =>
      run(
        () =>
          router.send(wallet, "exact_output_single", {
            from: wallet.address,
            recipient: other.address,
            tokenIn: tokens[tokenIn].address,
            tokenOut: tokens[tokenOut].address,
            fee: FEE,
            amountOut: amountOut.toString(),
            amountInMaximum: MaxUint64.toString(),
            sqrtPriceLimitX96: limit ? limit.toString() : "",
            deadline: "9999999999999",
          }),
        (r) => ({ amount: big(r.amountIn) })
      ),
    exactInput: (path, amountIn) =>
      run(
        () =>
          router.send(wallet, "exact_input", {
            from: wallet.address,
            recipient: other.address,
            tokens: path.map((i) => tokens[i].address),
            fees: path.slice(1).map(() => FEE),
            amountIn: amountIn.toString(),
            amountOutMinimum: "0",
            deadline: "9999999999999",
          }),
        (r) => ({ amount: big(r.amountOut) })
      ),
    exactOutput: (path, amountOut) =>
      run(
        () =>
          router.send(wallet, "exact_output", {
            from: wallet.address,
            recipient: other.address,
            tokens: path.map((i) => tokens[i].address),
            fees: path.slice(1).map(() => FEE),
            amountOut: amountOut.toString(),
            amountInMaximum: MaxUint64.toString(),
            deadline: "9999999999999",
          }),
        (r) => ({ amount: big(r.amountIn) })
      ),
    state(tokenIds) {
      const positions = tokenIds.map((tokenId) => {
        try {
          const p = nft.read("positions", { tokenId: id(tokenId) });
          return {
            owner: nft.read("owner_of", { tokenId: id(tokenId) }).value === wallet.address ? "wallet" : "other",
            pool: p.token0 === tokens[0].address ? 0 : 1,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            liquidity: big(p.liquidity),
            feeGrowthInside0LastX128: big(p.feeGrowthInside0LastX128),
            feeGrowthInside1LastX128: big(p.feeGrowthInside1LastX128),
            tokensOwed0: big(p.tokensOwed0),
            tokensOwed1: big(p.tokensOwed1),
          };
        } catch (e) {
          if (!(e instanceof TransactionError)) throw e;
          return koindxReason(e.message);
        }
      });
      return {
        positions,
        pools: pools.map((pool) => {
          const s = pool.slot0();
          return { sqrtPriceX96: s.sqrtPriceX96, tick: s.tick, liquidity: pool.liquidity(), feeGrowthGlobal0X128: pool.feeGrowthGlobal0X128(), feeGrowthGlobal1X128: pool.feeGrowthGlobal1X128() };
        }),
        balances: [wallet.address, other.address, pools[0].address, pools[1].address, router.address, nft.address].map((a) => tokens.map((t) => t.balanceOf(a))),
      };
    },
  };
}

/** the Uniswap reference */
async function uniswapDriver() {
  // no block gas limit: a swap through many empty words of the tick bitmap runs to the end
  const uni = await UniswapEVM.create({ tokenSupply: MaxUint64, gasLimit: 10n ** 10n });
  const tokens = [uni.token0, uni.token1, uni.token2];
  const WETH9 = uni.factory.address; // not used
  const npm = await uni.deploy("NonfungiblePositionManager", NPM.abi, NPM.bytecode, [uni.factory.address, WETH9, WETH9]);
  const router = await uni.deploy("SwapRouter", SWAP_ROUTER.abi, SWAP_ROUTER.bytecode, [uni.factory.address, WETH9]);
  for (const token of tokens) {
    await token.send("approve", [npm.address, MaxUint256]);
    await token.send("approve", [router.address, MaxUint256]);
  }
  const pools = [await uni.createPool(FEE, SPACING, tokens[0], tokens[1]), await uni.createPool(FEE, SPACING, tokens[1], tokens[2])];
  for (const pool of pools) await pool.initialize(encodePriceSqrt(1, 1));
  const who = (name) => (name === "other" ? uni.other : uni.wallet);
  const run = async (fn, result) => {
    try {
      const { result: r } = await fn();
      return { ok: true, result: result(r) };
    } catch (e) {
      if (!(e instanceof EvmRevert)) throw e;
      return { ok: false, reason: uniswapReason(e.message) };
    }
  };
  const amounts = (r) => ({ amount0: big(r.amount0), amount1: big(r.amount1) });
  const encodePath = (path) => "0x" + path.map((i, n) => tokens[i].address.slice(2) + (n < path.length - 1 ? FEE.toString(16).padStart(6, "0") : "")).join("");
  return {
    mint: (pool, recipient, tickLower, tickUpper, amount0Desired, amount1Desired) =>
      run(
        () =>
          npm.send("mint", [
            {
              token0: tokens[pool].address,
              token1: tokens[pool + 1].address,
              fee: FEE,
              tickLower,
              tickUpper,
              amount0Desired,
              amount1Desired,
              amount0Min: 0,
              amount1Min: 0,
              recipient: who(recipient).address,
              deadline: DEADLINE,
            },
          ]),
        (r) => ({ tokenId: Number(r.tokenId.toString()), liquidity: big(r.liquidity), ...amounts(r) })
      ),
    increaseLiquidity: (tokenId, amount0Desired, amount1Desired) =>
      run(
        () => npm.send("increaseLiquidity", [{ tokenId, amount0Desired, amount1Desired, amount0Min: 0, amount1Min: 0, deadline: DEADLINE }]),
        (r) => ({ liquidity: big(r.liquidity), ...amounts(r) })
      ),
    decreaseLiquidity: (from, tokenId, liquidity) =>
      run(() => npm.send("decreaseLiquidity", [{ tokenId, liquidity, amount0Min: 0, amount1Min: 0, deadline: DEADLINE }], who(from)), amounts),
    collect: (from, tokenId, amount0Max, amount1Max) =>
      run(() => npm.send("collect", [{ tokenId, recipient: who(from).address, amount0Max, amount1Max }], who(from)), amounts),
    burn: (from, tokenId) => run(() => npm.send("burn", [tokenId], who(from)), () => ({})),
    exactInputSingle: (tokenIn, tokenOut, amountIn, limit) =>
      run(
        () =>
          router.send("exactInputSingle", [
            { tokenIn: tokens[tokenIn].address, tokenOut: tokens[tokenOut].address, fee: FEE, recipient: uni.other.address, deadline: DEADLINE, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: limit || 0n },
          ]),
        (r) => ({ amount: big(r.amountOut) })
      ),
    exactOutputSingle: (tokenIn, tokenOut, amountOut, limit) =>
      run(
        () =>
          router.send("exactOutputSingle", [
            {
              tokenIn: tokens[tokenIn].address,
              tokenOut: tokens[tokenOut].address,
              fee: FEE,
              recipient: uni.other.address,
              deadline: DEADLINE,
              amountOut,
              amountInMaximum: MaxUint64,
              sqrtPriceLimitX96: limit || 0n,
            },
          ]),
        (r) => ({ amount: big(r.amountIn) })
      ),
    exactInput: (path, amountIn) =>
      run(
        () => router.send("exactInput", [{ path: encodePath(path), recipient: uni.other.address, deadline: DEADLINE, amountIn, amountOutMinimum: 0 }]),
        (r) => ({ amount: big(r.amountOut) })
      ),
    exactOutput: (path, amountOut) =>
      run(
        () => router.send("exactOutput", [{ path: encodePath([...path].reverse()), recipient: uni.other.address, deadline: DEADLINE, amountOut, amountInMaximum: MaxUint64 }]),
        (r) => ({ amount: big(r.amountIn) })
      ),
    async state(tokenIds) {
      const positions = [];
      for (const tokenId of tokenIds) {
        try {
          const p = await npm.call("positions", [tokenId]);
          const owner = await npm.call("ownerOf", [tokenId]);
          positions.push({
            owner: owner.toLowerCase() === uni.wallet.address.toLowerCase() ? "wallet" : "other",
            pool: p.token0.toLowerCase() === tokens[0].address.toLowerCase() ? 0 : 1,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            liquidity: big(p.liquidity),
            feeGrowthInside0LastX128: big(p.feeGrowthInside0LastX128),
            feeGrowthInside1LastX128: big(p.feeGrowthInside1LastX128),
            tokensOwed0: big(p.tokensOwed0),
            tokensOwed1: big(p.tokensOwed1),
          });
        } catch (e) {
          if (!(e instanceof EvmRevert)) throw e;
          positions.push(uniswapReason(e.message));
        }
      }
      const poolStates = [];
      for (const pool of pools) {
        const s = await pool.slot0();
        poolStates.push({ sqrtPriceX96: s.sqrtPriceX96, tick: s.tick, liquidity: await pool.liquidity(), feeGrowthGlobal0X128: await pool.feeGrowthGlobal0X128(), feeGrowthGlobal1X128: await pool.feeGrowthGlobal1X128() });
      }
      const balances = [];
      for (const a of [uni.wallet.address, uni.other.address, pools[0].address, pools[1].address, router.address, npm.address]) {
        const row = [];
        for (const t of tokens) row.push(await t.balanceOf(a));
        balances.push(row);
      }
      return { positions, pools: poolStates, balances };
    },
  };
}

/** a random operation */
function randomOperation(rand, ctx) {
  const { state, tokenIds } = ctx;
  const align = (tick) => Math.max(getMinTick(SPACING), Math.min(getMaxTick(SPACING), Math.round(tick / SPACING) * SPACING));
  const r = rand.next();
  const someToken = () => (tokenIds.length && !rand.chance(0.05) ? rand.pick(tokenIds) : tokenIds.length + 1);
  const owner = () => (rand.chance(0.9) ? "owner" : rand.pick(["wallet", "other"]));
  const ownerOf = (tokenId) => {
    const p = state.positions[tokenIds.indexOf(tokenId)];
    return p && typeof p === "object" ? p.owner : "wallet";
  };
  if (r < 0.25) {
    const pool = rand.int(0, 1);
    const current = state.pools[pool].tick;
    let lower;
    let upper;
    if (rand.chance(0.25)) [lower, upper] = [getMinTick(SPACING), getMaxTick(SPACING)];
    else {
      lower = align(current + rand.int(-3000, 2000));
      upper = Math.min(getMaxTick(SPACING), lower + rand.int(1, 60) * SPACING);
      if (rand.chance(0.03)) upper = lower; // invalid
    }
    return { op: "mint", args: [pool, rand.pick(["wallet", "other"]), lower, upper, rand.amount(17), rand.amount(17)] };
  }
  if (r < 0.35) return { op: "increaseLiquidity", args: [someToken(), rand.amount(16), rand.amount(16)] };
  if (r < 0.5) {
    const tokenId = someToken();
    const p = state.positions[tokenIds.indexOf(tokenId)];
    const liquidity = p && typeof p === "object" ? p.liquidity : 1n;
    const o = owner();
    return { op: "decreaseLiquidity", args: [o === "owner" ? ownerOf(tokenId) : o, tokenId, rand.pick([liquidity, liquidity / 2n, liquidity + 1n, 0n, liquidity / 3n])] };
  }
  if (r < 0.62) {
    const tokenId = someToken();
    const o = owner();
    const max = () => (rand.chance(0.7) ? MaxUint64 : rand.chance(0.1) ? 0n : rand.amount(12));
    return { op: "collect", args: [o === "owner" ? ownerOf(tokenId) : o, tokenId, max(), max()] };
  }
  if (r < 0.67) {
    const tokenId = someToken();
    const o = owner();
    return { op: "burn", args: [o === "owner" ? ownerOf(tokenId) : o, tokenId] };
  }
  // swaps, sometimes up to 2^64 - 1 (10^19.27)
  let amount = rand.amount(rand.chance(0.8) ? 14 : rand.chance(0.7) ? 16 : 19.3);
  if (amount > MaxUint64) amount = MaxUint64;
  const pool = rand.int(0, 1);
  const zeroForOne = rand.chance(0.5);
  const [tokenIn, tokenOut] = zeroForOne ? [pool, pool + 1] : [pool + 1, pool];
  const limit = () => {
    if (rand.chance(0.7)) return undefined;
    const sqrt = state.pools[pool].sqrtPriceX96;
    const moved = (sqrt * BigInt(zeroForOne ? 1000 - rand.int(1, 50) : 1000 + rand.int(1, 50))) / 1000n;
    return moved > MIN_SQRT_RATIO && moved < MAX_SQRT_RATIO ? moved : undefined;
  };
  if (r < 0.77) return { op: "exactInputSingle", args: [tokenIn, tokenOut, amount, limit()] };
  if (r < 0.87) return { op: "exactOutputSingle", args: [tokenIn, tokenOut, amount, limit()] };
  const path = rand.chance(0.5) ? [0, 1, 2] : [2, 1, 0];
  if (r < 0.94) return { op: "exactInput", args: [path, amount] };
  return { op: "exactOutput", args: [path, amount] };
}

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const describeOp = ({ op, args }) => `${op}(${args.map((a) => (a === undefined ? "default" : Array.isArray(a) ? `[${a}]` : a.toString())).join(", ")})`;

describe("periphery differential fuzzing (KoinDX vs Uniswap)", () => {
  for (let run = 0; run < RUNS; run++) {
    const seed = FIRST_SEED + run;
    it(`seed ${seed}: ${OPS} random operations`, async () => {
      const rand = prng(seed);
      const koindx = koindxDriver();
      const uniswap = await uniswapDriver();
      const tokenIds = [];
      let state = koindx.state(tokenIds);
      const ctx = {
        tokenIds,
        get state() {
          return state;
        },
      };
      const log = [];
      for (let i = 0; i < OPS; i++) {
        const operation = randomOperation(rand, ctx);
        log.push(describeOp(operation));
        const where = `seed ${seed}, operation ${i}: ${describeOp(operation)}\n  previous: ${log.slice(-6, -1).join("; ")}`;
        const expected = await uniswap[operation.op](...operation.args);
        const result = koindx[operation.op](...operation.args);
        // increaseLiquidity of a token that doesn't exist: Uniswap reverts without a reason (pool
        // key of the deleted position), KoinDX with INVALID_TOKEN_ID
        if (operation.op === "increaseLiquidity" && !expected.ok && expected.reason === "" && result.reason === "Invalid token ID") expected.reason = result.reason;
        // an exact output whose input amount exceeds 2^64 - 1 on a pool (more than a Koinos token
        // supply): KoinDX reverts there (AMOUNT_OVERFLOW), Uniswap goes on and reverts later:
        // beyond the liquidity its pool fills it partially and the router reverts without a
        // reason (amountOutReceived != amountOut); on a multi hop path the previous pool reverts
        // with SPL when its price is already at the limit
        if (operation.op.startsWith("exactOutput") && !expected.ok && ["", "SPL"].includes(expected.reason) && result.message === "KOINDX: AMOUNT_OVERFLOW") expected.reason = result.reason;
        if (json(result) !== json(expected)) {
          throw new Error(`${where}\n  KoinDX: ${json(result)} ${result.message || ""}\n  Uniswap: ${json(expected)}`);
        }
        if (operation.op === "mint" && result.ok) tokenIds.push(result.result.tokenId);

        state = koindx.state(tokenIds);
        const expectedState = await uniswap.state(tokenIds);
        try {
          expect(state).toEqual(expectedState);
        } catch (e) {
          throw new Error(`${where}\n${e.message}`);
        }
      }
    }, 600000);
  }
});
