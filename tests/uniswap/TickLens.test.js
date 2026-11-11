// Port of Uniswap v3-periphery test/TickLens.spec.ts. KoinDX has no TickLens contract: the pool
// returns the initialized ticks (get_populated_ticks, paginated and ordered by tick).
// getPopulatedTicksInWord below is TickLens.getPopulatedTicksInWord built on it: the ticks of a
// word of the tick bitmap, from the highest to the lowest.
// Not applicable: gas.
const { completeFixture } = require("./shared/fixtures");
const { encodePriceSqrt, FeeAmount, TICK_SPACINGS, getMinTick, getMaxTick } = require("./shared/utilities");

describe("TickLens", () => {
  let fixture, wallet, nft, tokens;

  beforeEach(() => {
    fixture = completeFixture();
    ({ wallet, nft, tokens } = fixture);
  });

  /** TickLens.getPopulatedTicksInWord */
  function getPopulatedTicksInWord(pool, tickBitmapIndex, tickSpacing = TICK_SPACINGS[FeeAmount.MEDIUM]) {
    const first = tickBitmapIndex * 256 * tickSpacing;
    const last = first + 255 * tickSpacing;
    // `start` is exclusive
    const { ticks } = pool.read("get_populated_ticks", { start: first - 1, limit: 256, descending: false });
    return ticks
      .filter((t) => t.tick <= last)
      .map((t) => ({ tick: t.tick, liquidityNet: Number(t.liquidityNet), liquidityGross: Number(t.liquidityGross) }))
      .reverse();
  }

  describe("#getPopulatedTicksInWord", () => {
    const fullRangeLiquidity = 1000000;
    let pool;

    function createPool(tokenAddressA, tokenAddressB) {
      if (tokenAddressA > tokenAddressB) [tokenAddressA, tokenAddressB] = [tokenAddressB, tokenAddressA];
      const p = fixture.createPool(tokenAddressA, tokenAddressB, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      nft.send(wallet, "mint", {
        from: wallet.address,
        recipient: wallet.address,
        token0: tokenAddressA,
        token1: tokenAddressB,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        amount0Desired: fullRangeLiquidity.toString(),
        amount1Desired: fullRangeLiquidity.toString(),
        amount0Min: "0",
        amount1Min: "0",
        deadline: "9999999999999",
      });
      return p;
    }

    function mint(tickLower, tickUpper, amountBothDesired) {
      const { result } = nft.send(wallet, "mint", {
        from: wallet.address,
        recipient: wallet.address,
        token0: tokens[0].address,
        token1: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        tickLower,
        tickUpper,
        amount0Desired: amountBothDesired.toString(),
        amount1Desired: amountBothDesired.toString(),
        amount0Min: "0",
        amount1Min: "0",
        deadline: "9999999999999",
      });
      return Number(result.liquidity);
    }

    beforeEach(() => {
      pool = createPool(tokens[0].address, tokens[1].address);
    });

    function getTickBitmapIndex(tick, tickSpacing) {
      const intermediate = Math.trunc(tick / tickSpacing);
      // see https://docs.soliditylang.org/en/v0.7.6/types.html#shifts
      return intermediate < 0 ? Math.trunc((intermediate + 1) / 2 ** 8) - 1 : intermediate >> 8;
    }

    it("works for min/max", () => {
      const [min] = getPopulatedTicksInWord(pool, getTickBitmapIndex(getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), TICK_SPACINGS[FeeAmount.MEDIUM]));
      const [max] = getPopulatedTicksInWord(pool, getTickBitmapIndex(getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]), TICK_SPACINGS[FeeAmount.MEDIUM]));

      expect(min.tick).toEqual(getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]));
      expect(min.liquidityNet).toEqual(fullRangeLiquidity);
      expect(min.liquidityGross).toEqual(fullRangeLiquidity);

      expect(max.tick).toEqual(getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]));
      expect(max.liquidityNet).toEqual(fullRangeLiquidity * -1);
      expect(min.liquidityGross).toEqual(fullRangeLiquidity);
    });

    it("works for min/max and -2/-1/0/1", () => {
      const minus = -TICK_SPACINGS[FeeAmount.MEDIUM];
      const plus = -minus;

      const liquidity0 = mint(minus * 2, minus, 2);
      const liquidity1 = mint(minus * 2, 0, 3);
      const liquidity2 = mint(minus * 2, plus, 5);
      const liquidity3 = mint(minus, 0, 7);
      const liquidity4 = mint(minus, plus, 11);
      const liquidity5 = mint(0, plus, 13);

      const [min] = getPopulatedTicksInWord(pool, getTickBitmapIndex(getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), TICK_SPACINGS[FeeAmount.MEDIUM]));
      const [negativeOne, negativeTwo] = getPopulatedTicksInWord(pool, getTickBitmapIndex(minus, TICK_SPACINGS[FeeAmount.MEDIUM]));
      const [one, zero] = getPopulatedTicksInWord(pool, getTickBitmapIndex(plus, TICK_SPACINGS[FeeAmount.MEDIUM]));
      const [max] = getPopulatedTicksInWord(pool, getTickBitmapIndex(getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]), TICK_SPACINGS[FeeAmount.MEDIUM]));

      expect(min.tick).toEqual(getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]));
      expect(min.liquidityNet).toEqual(fullRangeLiquidity);
      expect(min.liquidityGross).toEqual(fullRangeLiquidity);

      expect(negativeTwo.tick).toEqual(minus * 2);
      expect(negativeTwo.liquidityNet).toEqual(liquidity0 + liquidity1 + liquidity2);
      expect(negativeTwo.liquidityGross).toEqual(liquidity0 + liquidity1 + liquidity2);

      expect(negativeOne.tick).toEqual(minus);
      expect(negativeOne.liquidityNet).toEqual(liquidity3 + liquidity4 - liquidity0);
      expect(negativeOne.liquidityGross).toEqual(liquidity3 + liquidity4 + liquidity0);

      expect(zero.tick).toEqual(0);
      expect(zero.liquidityNet).toEqual(liquidity5 - liquidity1 - liquidity3);
      expect(zero.liquidityGross).toEqual(liquidity5 + liquidity1 + liquidity3);

      expect(one.tick).toEqual(plus);
      expect(one.liquidityNet).toEqual(-liquidity2 - liquidity4 - liquidity5);
      expect(one.liquidityGross).toEqual(liquidity2 + liquidity4 + liquidity5);

      expect(max.tick).toEqual(getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]));
      expect(max.liquidityNet).toEqual(fullRangeLiquidity * -1);
      expect(max.liquidityGross).toEqual(fullRangeLiquidity);
    });

    it("fully populated ticks", () => {
      // fully populate a word
      for (let i = 0; i < 128; i++) {
        mint(i * TICK_SPACINGS[FeeAmount.MEDIUM], (255 - i) * TICK_SPACINGS[FeeAmount.MEDIUM], 100);
      }

      const ticks = getPopulatedTicksInWord(pool, getTickBitmapIndex(0, TICK_SPACINGS[FeeAmount.MEDIUM]));
      expect(ticks.length).toEqual(256);
    });
  });
});
