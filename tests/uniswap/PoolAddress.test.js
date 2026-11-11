// Port of Uniswap v3-periphery test/PoolAddress.spec.ts. Uniswap computes the address of a pool
// with CREATE2 (the hash of the pool bytecode); Koinos has no deterministic deployment, so
// PoolAddress (libraries/PoolAddress.ts) asks the factory: these tests check the lookup through
// the router. Not applicable: POOL_INIT_CODE_HASH, computeAddress, gas.
const { completeFixture } = require("./shared/fixtures");
const { expectRevert } = require("./shared/contracts");
const { encodePriceSqrt, FeeAmount } = require("./shared/utilities");

describe("PoolAddress", () => {
  let fixture;
  beforeEach(() => {
    fixture = completeFixture();
  });

  const quote = (tokenIn, tokenOut, fee) =>
    fixture.quoter.read("quote_exact_input_single", { tokenIn, tokenOut, fee, amountIn: "1000", sqrtPriceLimitX96: "" });

  it("reverts if the pool does not exist", () => {
    const [t0, t1] = fixture.tokens;
    expectRevert(() => quote(t0.address, t1.address, FeeAmount.MEDIUM), "KOINDX: POOL_NOT_FOUND");
  });

  it("finds the pool in both token orders", () => {
    const [t0, t1] = fixture.tokens;
    const pool = fixture.createPool(t0.address, t1.address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
    expect(fixture.getPool(t1.address, t0.address, FeeAmount.MEDIUM).address).toEqual(pool.address);
    // no liquidity, but the pool is found: the quote reverts like QuoterV2 for a swap without
    // liquidity (finding F13), not with POOL_NOT_FOUND
    expectRevert(() => quote(t0.address, t1.address, FeeAmount.MEDIUM), "KOINDX: INVALID_SWAP_DELTAS");
    expectRevert(() => quote(t1.address, t0.address, FeeAmount.MEDIUM), "KOINDX: INVALID_SWAP_DELTAS");
  });

  it("depends on the fee", () => {
    const [t0, t1] = fixture.tokens;
    fixture.createPool(t0.address, t1.address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
    expectRevert(() => quote(t0.address, t1.address, FeeAmount.LOW), "KOINDX: POOL_NOT_FOUND");
  });
});
