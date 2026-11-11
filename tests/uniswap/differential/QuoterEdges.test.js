// The KoinDX quoter against the Uniswap QuoterV2 bytecode published on npm (run in an EVM), with the
// same pool state, in the cases the ported QuoterV2 tests don't reach (found by the final review):
// - a swap entirely within a region without liquidity: QuoterV2 and the router revert, the quoter
//   too (finding F13: it returned a quote of 0)
// - the initialized ticks crossed by a swap that starts at a negative tick that is not a multiple
//   of the tick spacing: QuoterV2's PoolTicksCounter also counts the initialized tick at the next
//   multiple toward zero, which the swap doesn't cross; KoinDX counts the ticks the swap loop
//   crosses (documented difference, Uniswap only uses it to estimate gas)
const { UniswapEVM, EvmRevert } = require("../evm/uniswap-evm");
const { completeFixture } = require("../shared/fixtures");
const { expectRevert } = require("../shared/contracts");
const { encodePriceSqrt, FeeAmount, TICK_SPACINGS, getMinTick, getMaxTick, MaxUint64 } = require("../shared/utilities");

const NPM = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
const SWAP_ROUTER = require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json");
const QUOTER_V2 = require("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json");

const FEE = FeeAmount.MEDIUM;
const SPACING = TICK_SPACINGS[FEE];
const MaxUint256 = (1n << 256n) - 1n;
const FULL = [getMinTick(SPACING), getMaxTick(SPACING)];

async function uniswapSide(positions) {
  const uni = await UniswapEVM.create({ tokenSupply: MaxUint64, gasLimit: 10n ** 10n });
  const WETH9 = uni.factory.address;
  const npm = await uni.deploy("NonfungiblePositionManager", NPM.abi, NPM.bytecode, [uni.factory.address, WETH9, WETH9]);
  const router = await uni.deploy("SwapRouter", SWAP_ROUTER.abi, SWAP_ROUTER.bytecode, [uni.factory.address, WETH9]);
  const quoter = await uni.deploy("QuoterV2", QUOTER_V2.abi, QUOTER_V2.bytecode, [uni.factory.address, WETH9]);
  for (const token of [uni.token0, uni.token1]) {
    await token.send("approve", [npm.address, MaxUint256]);
    await token.send("approve", [router.address, MaxUint256]);
  }
  const pool = await uni.createPool(FEE, SPACING, uni.token0, uni.token1);
  await pool.initialize(encodePriceSqrt(1, 1));
  for (const [tickLower, tickUpper, amount] of positions) {
    await npm.send("mint", [
      {
        token0: uni.token0.address, token1: uni.token1.address, fee: FEE, tickLower, tickUpper,
        amount0Desired: amount, amount1Desired: amount, amount0Min: 0, amount1Min: 0,
        recipient: uni.wallet.address, deadline: 1n << 40n,
      },
    ]);
  }
  return {
    pool,
    swap0for1: (amountIn) =>
      router.send("exactInputSingle", [
        { tokenIn: uni.token0.address, tokenOut: uni.token1.address, fee: FEE, recipient: uni.wallet.address, deadline: 1n << 40n, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
      ]),
    quote0for1: async (amountIn, sqrtPriceLimitX96 = 0n) => {
      const r = await quoter.callStatic("quoteExactInputSingle", [
        { tokenIn: uni.token0.address, tokenOut: uni.token1.address, amountIn, fee: FEE, sqrtPriceLimitX96 },
      ]);
      return { amountOut: BigInt(r.amountOut.toString()), sqrtPriceX96After: r.sqrtPriceX96After.toString(), initializedTicksCrossed: Number(r.initializedTicksCrossed) };
    },
  };
}

function koindxSide(positions) {
  const fixture = completeFixture();
  const { wallet, tokens, nft, router, quoter } = fixture;
  const pool = fixture.createPool(tokens[0].address, tokens[1].address, FEE, encodePriceSqrt(1, 1));
  for (const [tickLower, tickUpper, amount] of positions) {
    nft.send(wallet, "mint", {
      from: wallet.address, recipient: wallet.address, token0: tokens[0].address, token1: tokens[1].address, fee: FEE,
      tickLower, tickUpper, amount0Desired: amount.toString(), amount1Desired: amount.toString(), amount0Min: "0", amount1Min: "0",
      deadline: "9999999999999",
    });
  }
  const swapArgs = (amountIn, sqrtPriceLimitX96 = "") => ({
    from: wallet.address, recipient: wallet.address, tokenIn: tokens[0].address, tokenOut: tokens[1].address, fee: FEE,
    amountIn: amountIn.toString(), amountOutMinimum: "0", sqrtPriceLimitX96, deadline: "9999999999999",
  });
  return {
    pool,
    swap0for1: (amountIn, limit) => router.send(wallet, "exact_input_single", swapArgs(amountIn, limit)),
    quote0for1: (amountIn, sqrtPriceLimitX96 = "") => {
      const r = quoter.read("quote_exact_input_single", { tokenIn: tokens[0].address, tokenOut: tokens[1].address, fee: FEE, amountIn: amountIn.toString(), sqrtPriceLimitX96 });
      return { amountOut: BigInt(r.amountOut || 0), sqrtPriceX96After: r.sqrtPriceX96After, initializedTicksCrossed: r.initializedTicksCrossed || 0 };
    },
  };
}

describe("quoter edge cases (KoinDX vs Uniswap QuoterV2)", () => {
  it("initialized ticks crossed: swap from a negative tick that is not a multiple of the spacing", async () => {
    // pool of the QuoterV2 tests: tick 0 initialized (createPoolWithZeroTickInitialized)
    const positions = [[...FULL, 1000000n], [-60, 60, 100n], [-120, 120, 100n], [0, 60, 100n], [-120, 0, 100n]];
    const uni = await uniswapSide(positions);
    const kdx = koindxSide(positions);
    // a first swap moves the price from tick 0 to tick -1 (crosses tick 0)
    await uni.swap0for1(10n);
    kdx.swap0for1(10n);
    expect((await uni.pool.slot0()).tick).toEqual(-1);
    expect(kdx.pool.slot0().tick).toEqual(-1);
    // a second swap stays between -60 and -1: it crosses no initialized tick
    const u = await uni.quote0for1(10n);
    const k = kdx.quote0for1(10n);
    expect(k.amountOut).toEqual(u.amountOut);
    expect(k.sqrtPriceX96After).toEqual(u.sqrtPriceX96After);
    expect(u.initializedTicksCrossed).toEqual(1); // PoolTicksCounter: -1 / 60 == 0 in Solidity, counts tick 0
    expect(k.initializedTicksCrossed).toEqual(0); // the swap loop: nothing crossed
  });

  it("a swap entirely within a region without liquidity: QuoterV2, the quoter and the router revert", async () => {
    // the only liquidity is above the price: a 0 -> 1 swap (price down) meets none
    const positions = [[60, 120, 1000000n]];
    const uni = await uniswapSide(positions);
    const kdx = koindxSide(positions);
    const limit = (encodePriceSqrt(1, 1) * 99n) / 100n;
    let uniError = null;
    try {
      await uni.quote0for1(1000n, limit);
    } catch (e) {
      uniError = e;
    }
    expect(uniError).toBeInstanceOf(EvmRevert);
    expectRevert(() => kdx.quote0for1(1000n, limit.toString()), "KOINDX: INVALID_SWAP_DELTAS");
    expectRevert(() => kdx.swap0for1(1000n, limit.toString()), "KOINDX: INVALID_SWAP_DELTAS");
  });
});
