import { U256 } from "./U256";
import { FixedPoint96 } from "./FixedPoint";
import { SafeCast } from "./SafeCast";

export class Amounts {
  constructor(public amount0: U256, public amount1: U256) {}
}

/**
 * Port of Uniswap v3 LiquidityAmounts.
 *
 * Provides functions for computing liquidity amounts from token amounts and prices
 */
export namespace LiquidityAmounts {
  /**
   * Computes the amount of liquidity received for a given amount of token0 and price range
   * Calculates amount0 * (sqrt(upper) * sqrt(lower)) / (sqrt(upper) - sqrt(lower))
   */
  export function getLiquidityForAmount0(sqrtRatioAX96: U256, sqrtRatioBX96: U256, amount0: U256): U256 {
    if (U256.gt(sqrtRatioAX96, sqrtRatioBX96)) {
      const tmp = sqrtRatioAX96;
      sqrtRatioAX96 = sqrtRatioBX96;
      sqrtRatioBX96 = tmp;
    }
    const intermediate = U256.mulDiv(sqrtRatioAX96, sqrtRatioBX96, FixedPoint96.Q96);
    return SafeCast.toUint128(U256.mulDiv(amount0, intermediate, U256.sub(sqrtRatioBX96, sqrtRatioAX96)));
  }

  /**
   * Computes the amount of liquidity received for a given amount of token1 and price range
   * Calculates amount1 / (sqrt(upper) - sqrt(lower)).
   */
  export function getLiquidityForAmount1(sqrtRatioAX96: U256, sqrtRatioBX96: U256, amount1: U256): U256 {
    if (U256.gt(sqrtRatioAX96, sqrtRatioBX96)) {
      const tmp = sqrtRatioAX96;
      sqrtRatioAX96 = sqrtRatioBX96;
      sqrtRatioBX96 = tmp;
    }
    return SafeCast.toUint128(U256.mulDiv(amount1, FixedPoint96.Q96, U256.sub(sqrtRatioBX96, sqrtRatioAX96)));
  }

  /**
   * Computes the maximum amount of liquidity received for a given amount of token0, token1,
   * the current pool prices and the prices at the tick boundaries
   */
  export function getLiquidityForAmounts(
    sqrtRatioX96: U256,
    sqrtRatioAX96: U256,
    sqrtRatioBX96: U256,
    amount0: U256,
    amount1: U256
  ): U256 {
    if (U256.gt(sqrtRatioAX96, sqrtRatioBX96)) {
      const tmp = sqrtRatioAX96;
      sqrtRatioAX96 = sqrtRatioBX96;
      sqrtRatioBX96 = tmp;
    }

    if (U256.lte(sqrtRatioX96, sqrtRatioAX96)) {
      return getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0);
    } else if (U256.lt(sqrtRatioX96, sqrtRatioBX96)) {
      const liquidity0 = getLiquidityForAmount0(sqrtRatioX96, sqrtRatioBX96, amount0);
      const liquidity1 = getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioX96, amount1);
      return U256.lt(liquidity0, liquidity1) ? liquidity0 : liquidity1;
    }
    return getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1);
  }

  /** Computes the amount of token0 for a given amount of liquidity and a price range */
  export function getAmount0ForLiquidity(sqrtRatioAX96: U256, sqrtRatioBX96: U256, liquidity: U256): U256 {
    if (U256.gt(sqrtRatioAX96, sqrtRatioBX96)) {
      const tmp = sqrtRatioAX96;
      sqrtRatioAX96 = sqrtRatioBX96;
      sqrtRatioBX96 = tmp;
    }
    return U256.div(
      U256.mulDiv(
        U256.shl(liquidity, FixedPoint96.RESOLUTION),
        U256.sub(sqrtRatioBX96, sqrtRatioAX96),
        sqrtRatioBX96
      ),
      sqrtRatioAX96
    );
  }

  /** Computes the amount of token1 for a given amount of liquidity and a price range */
  export function getAmount1ForLiquidity(sqrtRatioAX96: U256, sqrtRatioBX96: U256, liquidity: U256): U256 {
    if (U256.gt(sqrtRatioAX96, sqrtRatioBX96)) {
      const tmp = sqrtRatioAX96;
      sqrtRatioAX96 = sqrtRatioBX96;
      sqrtRatioBX96 = tmp;
    }
    return U256.mulDiv(liquidity, U256.sub(sqrtRatioBX96, sqrtRatioAX96), FixedPoint96.Q96);
  }

  /**
   * Computes the token0 and token1 value for a given amount of liquidity, the current
   * pool prices and the prices at the tick boundaries
   */
  export function getAmountsForLiquidity(
    sqrtRatioX96: U256,
    sqrtRatioAX96: U256,
    sqrtRatioBX96: U256,
    liquidity: U256
  ): Amounts {
    if (U256.gt(sqrtRatioAX96, sqrtRatioBX96)) {
      const tmp = sqrtRatioAX96;
      sqrtRatioAX96 = sqrtRatioBX96;
      sqrtRatioBX96 = tmp;
    }

    if (U256.lte(sqrtRatioX96, sqrtRatioAX96)) {
      return new Amounts(getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity), U256.zero());
    } else if (U256.lt(sqrtRatioX96, sqrtRatioBX96)) {
      return new Amounts(
        getAmount0ForLiquidity(sqrtRatioX96, sqrtRatioBX96, liquidity),
        getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioX96, liquidity)
      );
    }
    return new Amounts(U256.zero(), getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity));
  }
}
