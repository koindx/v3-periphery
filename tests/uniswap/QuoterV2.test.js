// Port of Uniswap v3-periphery test/QuoterV2.spec.ts on the KoinDX quoter (contracts/quoter) in
// the Koinos VM emulator.
//
// Koinos differences:
// - the paths are lists of tokens and fees in the order of the swaps, also for the exact output
//   (Uniswap: encoded path reversed), and the lists of prices and ticks crossed of the exact output
//   follow this order (Uniswap: the order of its reversed path)
// - the quotes are read only calls (Uniswap: callStatic of a function that reverts)
// - token amounts are u64: the exact output single quotes use 2^64 - 1 instead of 2^256 - 1
// Not applicable: gas estimates.
const { completeFixture } = require("./shared/fixtures");
const { encodePriceSqrt, FeeAmount, TICK_SPACINGS, getMinTick, getMaxTick, expandTo18Decimals, MaxUint64 } = require("./shared/utilities");

describe("QuoterV2", () => {
  let fixture, wallet, trader, nft, quoter, tokens;

  beforeEach(() => {
    fixture = completeFixture();
    ({ wallet, nft, quoter, tokens } = fixture);
    trader = fixture.other;
    for (const token of tokens) token.transfer(wallet.address, trader.address, expandTo18Decimals(1));
  });

  // test/shared/quoter.ts
  function mint(token0, token1, tickLower, tickUpper, amount) {
    nft.send(wallet, "mint", {
      from: wallet.address,
      recipient: wallet.address,
      token0,
      token1,
      fee: FeeAmount.MEDIUM,
      tickLower,
      tickUpper,
      amount0Desired: amount.toString(),
      amount1Desired: amount.toString(),
      amount0Min: "0",
      amount1Min: "0",
      deadline: "9999999999999",
    });
  }
  const sorted = (a, b) => (a < b ? [a, b] : [b, a]);
  const fullRange = [getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM])];

  function createPool(tokenAddressA, tokenAddressB) {
    const [token0, token1] = sorted(tokenAddressA, tokenAddressB);
    fixture.createPool(token0, token1, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
    mint(token0, token1, ...fullRange, 1000000);
  }

  function createPoolWithMultiplePositions(tokenAddressA, tokenAddressB) {
    const [token0, token1] = sorted(tokenAddressA, tokenAddressB);
    fixture.createPool(token0, token1, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
    mint(token0, token1, ...fullRange, 1000000);
    mint(token0, token1, -60, 60, 100);
    mint(token0, token1, -120, 120, 100);
  }

  function createPoolWithZeroTickInitialized(tokenAddressA, tokenAddressB) {
    // Uniswap: createAndInitializePoolIfNecessary on the existing pool (no op), then the positions
    const [token0, token1] = sorted(tokenAddressA, tokenAddressB);
    mint(token0, token1, ...fullRange, 1000000);
    mint(token0, token1, 0, 60, 100);
    mint(token0, token1, -120, 0, 100);
  }

  const parseList = (r) => ({
    sqrtPriceX96AfterList: r.sqrtPriceX96AfterList,
    initializedTicksCrossedList: r.initializedTicksCrossedList,
  });
  const quoteExactInput = (path, amountIn) => {
    const r = quoter.read("quote_exact_input", { tokens: path, fees: new Array(path.length - 1).fill(FeeAmount.MEDIUM), amountIn: amountIn.toString() });
    return { amountOut: BigInt(r.amountOut), ...parseList(r) };
  };
  /** `path` in the order of the swaps; the lists are returned in the order of Uniswap (reversed) */
  const quoteExactOutput = (path, amountOut) => {
    const r = quoter.read("quote_exact_output", { tokens: path, fees: new Array(path.length - 1).fill(FeeAmount.MEDIUM), amountOut: amountOut.toString() });
    return {
      amountIn: BigInt(r.amountIn),
      sqrtPriceX96AfterList: [...r.sqrtPriceX96AfterList].reverse(),
      initializedTicksCrossedList: [...r.initializedTicksCrossedList].reverse(),
    };
  };
  const quoteExactInputSingle = (params) => {
    const r = quoter.read("quote_exact_input_single", { ...params, amountIn: params.amountIn.toString(), sqrtPriceLimitX96: params.sqrtPriceLimitX96.toString() });
    return { amountOut: BigInt(r.amountOut), sqrtPriceX96After: r.sqrtPriceX96After, initializedTicksCrossed: r.initializedTicksCrossed };
  };
  const quoteExactOutputSingle = (params) => {
    const r = quoter.read("quote_exact_output_single", { ...params, amountOut: params.amountOut.toString(), sqrtPriceLimitX96: params.sqrtPriceLimitX96.toString() });
    return { amountIn: BigInt(r.amountIn), sqrtPriceX96After: r.sqrtPriceX96After, initializedTicksCrossed: r.initializedTicksCrossed };
  };

  describe("quotes", () => {
    beforeEach(() => {
      createPool(tokens[0].address, tokens[1].address);
      createPool(tokens[1].address, tokens[2].address);
      createPoolWithMultiplePositions(tokens[0].address, tokens[2].address);
    });

    describe("#quoteExactInput", () => {
      it("0 -> 2 cross 2 tick", () => {
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[0].address, tokens[2].address], 10000);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("78461846509168490764501028180");
        expect(initializedTicksCrossedList[0]).toEqual(2);
        expect(amountOut).toEqual(9871n);
      });

      it("0 -> 2 cross 2 tick where after is initialized", () => {
        // The swap amount is set such that the active tick after the swap is -120.
        // -120 is an initialized tick for this pool. We check that we don't count it.
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[0].address, tokens[2].address], 6200);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("78757224507315167622282810783");
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(initializedTicksCrossedList[0]).toEqual(1);
        expect(amountOut).toEqual(6143n);
      });

      it("0 -> 2 cross 1 tick", () => {
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[0].address, tokens[2].address], 4000);
        expect(initializedTicksCrossedList[0]).toEqual(1);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("78926452400586371254602774705");
        expect(amountOut).toEqual(3971n);
      });

      it("0 -> 2 cross 0 tick, starting tick not initialized", () => {
        // Tick before 0, tick after -1.
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[0].address, tokens[2].address], 10);
        expect(initializedTicksCrossedList[0]).toEqual(0);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("79227483487511329217250071027");
        expect(amountOut).toEqual(8n);
      });

      it("0 -> 2 cross 0 tick, starting tick initialized", () => {
        // Tick before 0, tick after -1. Tick 0 initialized.
        createPoolWithZeroTickInitialized(tokens[0].address, tokens[2].address);
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[0].address, tokens[2].address], 10);
        expect(initializedTicksCrossedList[0]).toEqual(1);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("79227817515327498931091950511");
        expect(amountOut).toEqual(8n);
      });

      it("2 -> 0 cross 2", () => {
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[2].address, tokens[0].address], 10000);
        expect(initializedTicksCrossedList[0]).toEqual(2);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("80001962924147897865541384515");
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(amountOut).toEqual(9871n);
      });

      it("2 -> 0 cross 2 where tick after is initialized", () => {
        // The swap amount is set such that the active tick after the swap is 120.
        // 120 is an initialized tick for this pool. We check we don't count it.
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[2].address, tokens[0].address], 6250);
        expect(initializedTicksCrossedList[0]).toEqual(2);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("79705728824507063507279123685");
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(amountOut).toEqual(6190n);
      });

      it("2 -> 0 cross 0 tick, starting tick initialized", () => {
        // Tick 0 initialized. Tick after = 1
        createPoolWithZeroTickInitialized(tokens[0].address, tokens[2].address);
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[2].address, tokens[0].address], 200);
        expect(initializedTicksCrossedList[0]).toEqual(0);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("79235729830182478001034429156");
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(amountOut).toEqual(198n);
      });

      it("2 -> 0 cross 0 tick, starting tick not initialized", () => {
        // Tick 0 initialized. Tick after = 1
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[2].address, tokens[0].address], 103);
        expect(initializedTicksCrossedList[0]).toEqual(0);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("79235858216754624215638319723");
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(amountOut).toEqual(101n);
      });

      it("2 -> 1", () => {
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[2].address, tokens[1].address], 10000);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("80018067294531553039351583520");
        expect(initializedTicksCrossedList[0]).toEqual(0);
        expect(amountOut).toEqual(9871n);
      });

      it("0 -> 2 -> 1", () => {
        const { amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactInput([tokens[0].address, tokens[2].address, tokens[1].address], 10000);
        expect(sqrtPriceX96AfterList.length).toEqual(2);
        expect(sqrtPriceX96AfterList[0]).toEqual("78461846509168490764501028180");
        expect(sqrtPriceX96AfterList[1]).toEqual("80007846861567212939802016351");
        expect(initializedTicksCrossedList[0]).toEqual(2);
        expect(initializedTicksCrossedList[1]).toEqual(0);
        expect(amountOut).toEqual(9745n);
      });
    });

    describe("#quoteExactInputSingle", () => {
      it("0 -> 2", () => {
        const { initializedTicksCrossed, amountOut: quote, sqrtPriceX96After } = quoteExactInputSingle({
          tokenIn: tokens[0].address,
          tokenOut: tokens[2].address,
          fee: FeeAmount.MEDIUM,
          amountIn: 10000,
          // -2%
          sqrtPriceLimitX96: encodePriceSqrt(100, 102),
        });
        expect(initializedTicksCrossed).toEqual(2);
        expect(quote).toEqual(9871n);
        expect(sqrtPriceX96After).toEqual("78461846509168490764501028180");
      });

      it("2 -> 0", () => {
        const { initializedTicksCrossed, amountOut: quote, sqrtPriceX96After } = quoteExactInputSingle({
          tokenIn: tokens[2].address,
          tokenOut: tokens[0].address,
          fee: FeeAmount.MEDIUM,
          amountIn: 10000,
          // +2%
          sqrtPriceLimitX96: encodePriceSqrt(102, 100),
        });
        expect(initializedTicksCrossed).toEqual(2);
        expect(quote).toEqual(9871n);
        expect(sqrtPriceX96After).toEqual("80001962924147897865541384515");
      });
    });

    describe("#quoteExactOutput", () => {
      it("0 -> 2 cross 2 tick", () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactOutput([tokens[0].address, tokens[2].address], 15000);
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(initializedTicksCrossedList[0]).toEqual(2);
        expect(amountIn).toEqual(15273n);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("78055527257643669242286029831");
      });

      it("0 -> 2 cross 2 where tick after is initialized", () => {
        // The swap amount is set such that the active tick after the swap is -120.
        // -120 is an initialized tick for this pool. We check that we count it.
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactOutput([tokens[0].address, tokens[2].address], 6143);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("78757225449310403327341205211");
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(initializedTicksCrossedList[0]).toEqual(1);
        expect(amountIn).toEqual(6200n);
      });

      it("0 -> 2 cross 1 tick", () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactOutput([tokens[0].address, tokens[2].address], 4000);
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(initializedTicksCrossedList[0]).toEqual(1);
        expect(amountIn).toEqual(4029n);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("78924219757724709840818372098");
      });

      it("0 -> 2 cross 0 tick starting tick initialized", () => {
        // Tick before 0, tick after 1. Tick 0 initialized.
        createPoolWithZeroTickInitialized(tokens[0].address, tokens[2].address);
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactOutput([tokens[0].address, tokens[2].address], 100);
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(initializedTicksCrossedList[0]).toEqual(1);
        expect(amountIn).toEqual(102n);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("79224329176051641448521403903");
      });

      it("0 -> 2 cross 0 tick starting tick not initialized", () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactOutput([tokens[0].address, tokens[2].address], 10);
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(initializedTicksCrossedList[0]).toEqual(0);
        expect(amountIn).toEqual(12n);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("79227408033628034983534698435");
      });

      it("2 -> 0 cross 2 ticks", () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactOutput([tokens[2].address, tokens[0].address], 15000);
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(initializedTicksCrossedList[0]).toEqual(2);
        expect(amountIn).toEqual(15273n);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("80418414376567919517220409857");
      });

      it("2 -> 0 cross 2 where tick after is initialized", () => {
        // The swap amount is set such that the active tick after the swap is 120.
        // 120 is an initialized tick for this pool. We check that we don't count it.
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactOutput([tokens[2].address, tokens[0].address], 6223);
        expect(initializedTicksCrossedList[0]).toEqual(2);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("79708304437530892332449657932");
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(amountIn).toEqual(6283n);
      });

      it("2 -> 0 cross 1 tick", () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactOutput([tokens[2].address, tokens[0].address], 6000);
        expect(initializedTicksCrossedList[0]).toEqual(1);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("79690640184021170956740081887");
        expect(initializedTicksCrossedList.length).toEqual(1);
        expect(amountIn).toEqual(6055n);
      });

      it("2 -> 1", () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactOutput([tokens[2].address, tokens[1].address], 9871);
        expect(sqrtPriceX96AfterList.length).toEqual(1);
        expect(sqrtPriceX96AfterList[0]).toEqual("80018020393569259756601362385");
        expect(initializedTicksCrossedList[0]).toEqual(0);
        expect(amountIn).toEqual(10000n);
      });

      it("0 -> 2 -> 1", () => {
        const { amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList } = quoteExactOutput([tokens[0].address, tokens[2].address, tokens[1].address], 9745);
        expect(sqrtPriceX96AfterList.length).toEqual(2);
        expect(sqrtPriceX96AfterList[0]).toEqual("80007838904387594703933785072");
        expect(sqrtPriceX96AfterList[1]).toEqual("78461888503179331029803316753");
        expect(initializedTicksCrossedList[0]).toEqual(0);
        expect(initializedTicksCrossedList[1]).toEqual(2);
        expect(amountIn).toEqual(10000n);
      });
    });

    describe("#quoteExactOutputSingle", () => {
      it("0 -> 1", () => {
        const { amountIn, sqrtPriceX96After, initializedTicksCrossed } = quoteExactOutputSingle({
          tokenIn: tokens[0].address,
          tokenOut: tokens[1].address,
          fee: FeeAmount.MEDIUM,
          amountOut: MaxUint64,
          sqrtPriceLimitX96: encodePriceSqrt(100, 102),
        });
        expect(amountIn).toEqual(9981n);
        expect(initializedTicksCrossed).toEqual(0);
        expect(sqrtPriceX96After).toEqual("78447570448055484695608110440");
      });

      it("1 -> 0", () => {
        const { amountIn, sqrtPriceX96After, initializedTicksCrossed } = quoteExactOutputSingle({
          tokenIn: tokens[1].address,
          tokenOut: tokens[0].address,
          fee: FeeAmount.MEDIUM,
          amountOut: MaxUint64,
          sqrtPriceLimitX96: encodePriceSqrt(102, 100),
        });
        expect(amountIn).toEqual(9981n);
        expect(initializedTicksCrossed).toEqual(0);
        expect(sqrtPriceX96After).toEqual("80016521857016594389520272648");
      });
    });
  });
});
