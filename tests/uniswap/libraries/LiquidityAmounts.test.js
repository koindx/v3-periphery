// Port of Uniswap v3-periphery test/LiquidityAmounts.spec.ts (libraries/LiquidityAmounts.ts compiled
// in tests/build/harness.wasm). Not applicable: the gas cost tests.
const { callString } = require("../../harness");
const { encodePriceSqrt } = require("../shared/utilities");

const s = (x) => BigInt(x).toString();
const liquidityFromAmounts = {
  getLiquidityForAmounts: (p, a, b, amount0, amount1) => BigInt(callString("getLiquidityForAmounts", s(p), s(a), s(b), s(amount0), s(amount1))),
  getAmountsForLiquidity: (p, a, b, liquidity) => {
    const [amount0, amount1] = callString("getAmountsForLiquidity", s(p), s(a), s(b), s(liquidity)).split(",").map(BigInt);
    return { amount0, amount1 };
  },
};

describe("LiquidityAmounts", () => {
  describe("#getLiquidityForAmounts", () => {
    it("amounts for price inside", () => {
      const sqrtPriceX96 = encodePriceSqrt(1, 1);
      const sqrtPriceAX96 = encodePriceSqrt(100, 110);
      const sqrtPriceBX96 = encodePriceSqrt(110, 100);
      expect(liquidityFromAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, 100, 200)).toEqual(2148n);
    });

    it("amounts for price below", () => {
      const sqrtPriceX96 = encodePriceSqrt(99, 110);
      const sqrtPriceAX96 = encodePriceSqrt(100, 110);
      const sqrtPriceBX96 = encodePriceSqrt(110, 100);
      expect(liquidityFromAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, 100, 200)).toEqual(1048n);
    });

    it("amounts for price above", () => {
      const sqrtPriceX96 = encodePriceSqrt(111, 100);
      const sqrtPriceAX96 = encodePriceSqrt(100, 110);
      const sqrtPriceBX96 = encodePriceSqrt(110, 100);
      expect(liquidityFromAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, 100, 200)).toEqual(2097n);
    });

    it("amounts for price equal to lower boundary", () => {
      const sqrtPriceAX96 = encodePriceSqrt(100, 110);
      const sqrtPriceX96 = sqrtPriceAX96;
      const sqrtPriceBX96 = encodePriceSqrt(110, 100);
      expect(liquidityFromAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, 100, 200)).toEqual(1048n);
    });

    it("amounts for price equal to upper boundary", () => {
      const sqrtPriceAX96 = encodePriceSqrt(100, 110);
      const sqrtPriceBX96 = encodePriceSqrt(110, 100);
      const sqrtPriceX96 = sqrtPriceBX96;
      expect(liquidityFromAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, 100, 200)).toEqual(2097n);
    });
  });

  describe("#getAmountsForLiquidity", () => {
    it("amounts for price inside", () => {
      const sqrtPriceX96 = encodePriceSqrt(1, 1);
      const sqrtPriceAX96 = encodePriceSqrt(100, 110);
      const sqrtPriceBX96 = encodePriceSqrt(110, 100);
      expect(liquidityFromAmounts.getAmountsForLiquidity(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, 2148)).toEqual({ amount0: 99n, amount1: 99n });
    });

    it("amounts for price below", () => {
      const sqrtPriceX96 = encodePriceSqrt(99, 110);
      const sqrtPriceAX96 = encodePriceSqrt(100, 110);
      const sqrtPriceBX96 = encodePriceSqrt(110, 100);
      expect(liquidityFromAmounts.getAmountsForLiquidity(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, 1048)).toEqual({ amount0: 99n, amount1: 0n });
    });

    it("amounts for price above", () => {
      const sqrtPriceX96 = encodePriceSqrt(111, 100);
      const sqrtPriceAX96 = encodePriceSqrt(100, 110);
      const sqrtPriceBX96 = encodePriceSqrt(110, 100);
      expect(liquidityFromAmounts.getAmountsForLiquidity(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, 2097)).toEqual({ amount0: 0n, amount1: 199n });
    });

    it("amounts for price on lower boundary", () => {
      const sqrtPriceAX96 = encodePriceSqrt(100, 110);
      const sqrtPriceX96 = sqrtPriceAX96;
      const sqrtPriceBX96 = encodePriceSqrt(110, 100);
      expect(liquidityFromAmounts.getAmountsForLiquidity(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, 1048)).toEqual({ amount0: 99n, amount1: 0n });
    });

    it("amounts for price on upper boundary", () => {
      const sqrtPriceAX96 = encodePriceSqrt(100, 110);
      const sqrtPriceBX96 = encodePriceSqrt(110, 100);
      const sqrtPriceX96 = sqrtPriceBX96;
      expect(liquidityFromAmounts.getAmountsForLiquidity(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, 2097)).toEqual({ amount0: 0n, amount1: 199n });
    });
  });
});
