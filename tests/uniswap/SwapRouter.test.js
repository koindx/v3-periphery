// Port of Uniswap v3-periphery test/SwapRouter.spec.ts on the KoinDX router (contracts/router) in
// the Koinos VM emulator.
//
// Koinos differences:
// - the path is a list of tokens and a list of fees, in the order of the swaps for the exact
//   input and the exact output (the router reverses it for the exact output, like the encoded
//   path of Uniswap)
// - the payer is `from` (it signs the transaction), there are no token approvals
// - deadlines are in milliseconds and mandatory (0 reverts, like Uniswap), there is no multicall (a Koinos
//   transaction can have several operations)
// Not applicable: ETH / WETH9 input and output (no native coin, KOIN is a token), the *WithFee
// payments (sweepTokenWithFee, unwrapWETH9WithFee), gas and bytecode size.
const { completeFixture } = require("./shared/fixtures");
const { expectRevert } = require("./shared/contracts");
const { encodePriceSqrt, FeeAmount, TICK_SPACINGS, getMinTick, getMaxTick, expandTo18Decimals } = require("./shared/utilities");
const { koinos } = require("@koinos/proto-js");
const { utils } = require("koilib");

const T = koinos.contracts.token;

describe("SwapRouter", () => {
  let fixture, vm, wallet, trader, router, nft, tokens;

  beforeEach(() => {
    fixture = completeFixture();
    ({ vm, wallet, router, nft, tokens } = fixture);
    trader = fixture.other;
    // fund the trader (Uniswap: 1M tokens of 18 decimals; Koinos tokens are u64)
    for (const token of tokens) token.transfer(wallet.address, trader.address, expandTo18Decimals(1));
  });

  const getBalances = (who) => {
    const address = typeof who === "string" ? who : who.address;
    return { token0: tokens[0].balanceOf(address), token1: tokens[1].balanceOf(address), token2: tokens[2].balanceOf(address) };
  };

  // ensure the swap router never ends up with a balance
  afterEach(() => {
    const balances = getBalances(router.address);
    expect(Object.values(balances).every((b) => b === 0n)).toBe(true);
  });

  const transfers = (events, token) =>
    events.filter((e) => e.source === token.address && e.name === "token.transfer_event").map((e) => {
      const d = T.transfer_event.decode(e.data);
      return { from: utils.encodeBase58(d.from), to: utils.encodeBase58(d.to), value: BigInt(d.value.toString()) };
    });

  describe("#sweepToken (Uniswap: what a partly filled intermediate hop leaves in the router)", () => {
    const mint = (tokenA, tokenB, tickLower, tickUpper, amount) => {
      const [token0, token1] = tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];
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
    };

    beforeEach(() => {
      fixture.createPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      fixture.createPool(tokens[1].address, tokens[2].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      const spacing = TICK_SPACINGS[FeeAmount.MEDIUM];
      // a deep first pool, and a second pool with liquidity only around the price
      mint(tokens[0].address, tokens[1].address, getMinTick(spacing), getMaxTick(spacing), 100000000);
      mint(tokens[1].address, tokens[2].address, -spacing, spacing, 1000);
    });

    const exactInput = (amountIn) =>
      router.send(trader, "exact_input", {
        from: trader.address,
        recipient: trader.address,
        tokens: [tokens[0].address, tokens[1].address, tokens[2].address],
        fees: [FeeAmount.MEDIUM, FeeAmount.MEDIUM],
        amountIn: amountIn.toString(),
        amountOutMinimum: "0",
        deadline: "9999999999999",
      });

    it("a partly filled intermediate hop leaves tokens in the router, that anybody can sweep", () => {
      // the second pool can only take a part of what the first hop gives (Uniswap does the same)
      exactInput(100000);
      const leftover = tokens[1].balanceOf(router.address);
      expect(leftover > 0n).toBe(true);
      // anybody (not the trader) can take it, like Uniswap's sweepToken
      const before = tokens[1].balanceOf(wallet.address);
      const { result } = router.send(wallet, "sweep_token", { token: tokens[1].address, amountMinimum: "0", recipient: wallet.address });
      expect(BigInt(result.amount)).toEqual(leftover);
      expect(tokens[1].balanceOf(wallet.address)).toEqual(before + leftover);
      expect(tokens[1].balanceOf(router.address)).toEqual(0n);
    });

    it("amountMinimum, recipient checks, and an empty balance", () => {
      exactInput(100000);
      const leftover = tokens[1].balanceOf(router.address);
      expectRevert(
        () => router.send(wallet, "sweep_token", { token: tokens[1].address, amountMinimum: (leftover + 1n).toString(), recipient: wallet.address }),
        "KOINDX: INSUFFICIENT_TOKEN"
      );
      expectRevert(() => router.send(wallet, "sweep_token", { token: tokens[1].address, amountMinimum: "0", recipient: router.address }), "KOINDX: INVALID_RECIPIENT");
      router.send(trader, "sweep_token", { token: tokens[1].address, amountMinimum: leftover.toString(), recipient: trader.address });
      // nothing left: a sweep of an empty balance transfers nothing
      const { result } = router.send(wallet, "sweep_token", { token: tokens[1].address, amountMinimum: "0", recipient: wallet.address });
      expect(BigInt(result.amount || 0)).toEqual(0n);
    });
  });

  describe("swaps", () => {
    const liquidity = 1000000;
    function createPool(tokenAddressA, tokenAddressB) {
      if (tokenAddressA > tokenAddressB) [tokenAddressA, tokenAddressB] = [tokenAddressB, tokenAddressA];

      fixture.createPool(tokenAddressA, tokenAddressB, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));

      return nft.send(wallet, "mint", {
        from: wallet.address,
        recipient: wallet.address,
        token0: tokenAddressA,
        token1: tokenAddressB,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        amount0Desired: liquidity.toString(),
        amount1Desired: liquidity.toString(),
        amount0Min: "0",
        amount1Min: "0",
        deadline: "9999999999999",
      });
    }

    beforeEach(() => {
      createPool(tokens[0].address, tokens[1].address);
      createPool(tokens[1].address, tokens[2].address);
    });

    const getPool = (a, b) => fixture.getPool(a, b, FeeAmount.MEDIUM).address;

    describe("#exactInput", () => {
      function exactInput(path, amountIn = 3, amountOutMinimum = 1) {
        const params = {
          from: trader.address,
          recipient: trader.address,
          tokens: path,
          fees: new Array(path.length - 1).fill(FeeAmount.MEDIUM),
          amountIn: amountIn.toString(),
          amountOutMinimum: (amountOutMinimum + 1).toString(),
          deadline: "9999999999999",
        };

        // ensure that the swap fails if the limit is any tighter
        expectRevert(() => router.send(trader, "exact_input", params), "KOINDX: TOO_LITTLE_RECEIVED");
        params.amountOutMinimum = amountOutMinimum.toString();

        return router.send(trader, "exact_input", params);
      }

      describe("single-pool", () => {
        it("0 -> 1", () => {
          const pool = getPool(tokens[0].address, tokens[1].address);

          // get balances before
          const poolBefore = getBalances(pool);
          const traderBefore = getBalances(trader);

          exactInput(tokens.slice(0, 2).map((token) => token.address));

          // get balances after
          const poolAfter = getBalances(pool);
          const traderAfter = getBalances(trader);

          expect(traderAfter.token0).toEqual(traderBefore.token0 - 3n);
          expect(traderAfter.token1).toEqual(traderBefore.token1 + 1n);
          expect(poolAfter.token0).toEqual(poolBefore.token0 + 3n);
          expect(poolAfter.token1).toEqual(poolBefore.token1 - 1n);
        });

        it("1 -> 0", () => {
          const pool = getPool(tokens[1].address, tokens[0].address);

          // get balances before
          const poolBefore = getBalances(pool);
          const traderBefore = getBalances(trader);

          exactInput(
            tokens
              .slice(0, 2)
              .reverse()
              .map((token) => token.address)
          );

          // get balances after
          const poolAfter = getBalances(pool);
          const traderAfter = getBalances(trader);

          expect(traderAfter.token0).toEqual(traderBefore.token0 + 1n);
          expect(traderAfter.token1).toEqual(traderBefore.token1 - 3n);
          expect(poolAfter.token0).toEqual(poolBefore.token0 - 1n);
          expect(poolAfter.token1).toEqual(poolBefore.token1 + 3n);
        });
      });

      describe("multi-pool", () => {
        it("0 -> 1 -> 2", () => {
          const traderBefore = getBalances(trader);

          exactInput(
            tokens.map((token) => token.address),
            5,
            1
          );

          const traderAfter = getBalances(trader);

          expect(traderAfter.token0).toEqual(traderBefore.token0 - 5n);
          expect(traderAfter.token2).toEqual(traderBefore.token2 + 1n);
        });

        it("2 -> 1 -> 0", () => {
          const traderBefore = getBalances(trader);

          exactInput(tokens.map((token) => token.address).reverse(), 5, 1);

          const traderAfter = getBalances(trader);

          expect(traderAfter.token2).toEqual(traderBefore.token2 - 5n);
          expect(traderAfter.token0).toEqual(traderBefore.token0 + 1n);
        });

        it("events", () => {
          const { events } = exactInput(
            tokens.map((token) => token.address),
            5,
            1
          );
          const pool01 = getPool(tokens[0].address, tokens[1].address);
          const pool12 = getPool(tokens[1].address, tokens[2].address);
          expect(transfers(events, tokens[0])).toEqual([{ from: trader.address, to: pool01, value: 5n }]);
          expect(transfers(events, tokens[1])).toEqual([
            { from: pool01, to: router.address, value: 3n },
            { from: router.address, to: pool12, value: 3n },
          ]);
          expect(transfers(events, tokens[2])).toEqual([{ from: pool12, to: trader.address, value: 1n }]);
        });
      });
    });

    describe("#exactInputSingle", () => {
      function exactInputSingle(tokenIn, tokenOut, amountIn = 3, amountOutMinimum = 1, sqrtPriceLimitX96) {
        const params = {
          from: trader.address,
          recipient: trader.address,
          tokenIn,
          tokenOut,
          fee: FeeAmount.MEDIUM,
          sqrtPriceLimitX96: (sqrtPriceLimitX96 ?? (tokenIn < tokenOut ? 4295128740n : 1461446703485210103287273052203988822378723970341n)).toString(),
          amountIn: amountIn.toString(),
          amountOutMinimum: (amountOutMinimum + 1).toString(),
          deadline: "9999999999999",
        };

        // ensure that the swap fails if the limit is any tighter
        expectRevert(() => router.send(trader, "exact_input_single", params), "KOINDX: TOO_LITTLE_RECEIVED");
        params.amountOutMinimum = amountOutMinimum.toString();

        return router.send(trader, "exact_input_single", params);
      }

      it("0 -> 1", () => {
        const pool = getPool(tokens[0].address, tokens[1].address);

        // get balances before
        const poolBefore = getBalances(pool);
        const traderBefore = getBalances(trader);

        exactInputSingle(tokens[0].address, tokens[1].address);

        // get balances after
        const poolAfter = getBalances(pool);
        const traderAfter = getBalances(trader);

        expect(traderAfter.token0).toEqual(traderBefore.token0 - 3n);
        expect(traderAfter.token1).toEqual(traderBefore.token1 + 1n);
        expect(poolAfter.token0).toEqual(poolBefore.token0 + 3n);
        expect(poolAfter.token1).toEqual(poolBefore.token1 - 1n);
      });

      it("1 -> 0", () => {
        const pool = getPool(tokens[1].address, tokens[0].address);

        // get balances before
        const poolBefore = getBalances(pool);
        const traderBefore = getBalances(trader);

        exactInputSingle(tokens[1].address, tokens[0].address);

        // get balances after
        const poolAfter = getBalances(pool);
        const traderAfter = getBalances(trader);

        expect(traderAfter.token0).toEqual(traderBefore.token0 + 1n);
        expect(traderAfter.token1).toEqual(traderBefore.token1 - 3n);
        expect(poolAfter.token0).toEqual(poolBefore.token0 - 1n);
        expect(poolAfter.token1).toEqual(poolBefore.token1 + 3n);
      });

      it("fails if past deadline", () => {
        const params = {
          from: trader.address,
          recipient: trader.address,
          tokenIn: tokens[0].address,
          tokenOut: tokens[1].address,
          fee: FeeAmount.MEDIUM,
          sqrtPriceLimitX96: "",
          amountIn: "3",
          amountOutMinimum: "1",
          deadline: (vm.time - 1n).toString(),
        };
        expectRevert(() => router.send(trader, "exact_input_single", params), "KOINDX: TRANSACTION_TOO_OLD");
      });

      it("fails without a deadline (0), like Uniswap", () => {
        // a Koinos transaction has no expiration: the deadline is mandatory
        const params = {
          from: trader.address,
          recipient: trader.address,
          tokenIn: tokens[0].address,
          tokenOut: tokens[1].address,
          fee: FeeAmount.MEDIUM,
          sqrtPriceLimitX96: "",
          amountIn: "3",
          amountOutMinimum: "1",
          deadline: "0",
        };
        expectRevert(() => router.send(trader, "exact_input_single", params), "KOINDX: TRANSACTION_TOO_OLD");
      });

      it("the payer must sign the transaction", () => {
        const params = {
          from: trader.address,
          recipient: wallet.address,
          tokenIn: tokens[0].address,
          tokenOut: tokens[1].address,
          fee: FeeAmount.MEDIUM,
          sqrtPriceLimitX96: "",
          amountIn: "3",
          amountOutMinimum: "1",
          deadline: "9999999999999",
        };
        expectRevert(() => router.send(wallet, "exact_input_single", params), "KOINDX: UNAUTHORIZED");
      });
    });

    describe("#exactOutput", () => {
      function exactOutput(path, amountOut = 1, amountInMaximum = 3) {
        const params = {
          from: trader.address,
          recipient: trader.address,
          tokens: path,
          fees: new Array(path.length - 1).fill(FeeAmount.MEDIUM),
          amountOut: amountOut.toString(),
          amountInMaximum: (amountInMaximum - 1).toString(),
          deadline: "9999999999999",
        };

        // ensure that the swap fails if the limit is any tighter
        expectRevert(() => router.send(trader, "exact_output", params), "KOINDX: TOO_MUCH_REQUESTED");
        params.amountInMaximum = amountInMaximum.toString();

        return router.send(trader, "exact_output", params);
      }

      describe("single-pool", () => {
        it("0 -> 1", () => {
          const pool = getPool(tokens[0].address, tokens[1].address);

          // get balances before
          const poolBefore = getBalances(pool);
          const traderBefore = getBalances(trader);

          exactOutput(tokens.slice(0, 2).map((token) => token.address));

          // get balances after
          const poolAfter = getBalances(pool);
          const traderAfter = getBalances(trader);

          expect(traderAfter.token0).toEqual(traderBefore.token0 - 3n);
          expect(traderAfter.token1).toEqual(traderBefore.token1 + 1n);
          expect(poolAfter.token0).toEqual(poolBefore.token0 + 3n);
          expect(poolAfter.token1).toEqual(poolBefore.token1 - 1n);
        });

        it("1 -> 0", () => {
          const pool = getPool(tokens[1].address, tokens[0].address);

          // get balances before
          const poolBefore = getBalances(pool);
          const traderBefore = getBalances(trader);

          exactOutput(
            tokens
              .slice(0, 2)
              .reverse()
              .map((token) => token.address)
          );

          // get balances after
          const poolAfter = getBalances(pool);
          const traderAfter = getBalances(trader);

          expect(traderAfter.token0).toEqual(traderBefore.token0 + 1n);
          expect(traderAfter.token1).toEqual(traderBefore.token1 - 3n);
          expect(poolAfter.token0).toEqual(poolBefore.token0 - 1n);
          expect(poolAfter.token1).toEqual(poolBefore.token1 + 3n);
        });
      });

      describe("multi-pool", () => {
        it("0 -> 1 -> 2", () => {
          const traderBefore = getBalances(trader);

          exactOutput(
            tokens.map((token) => token.address),
            1,
            5
          );

          const traderAfter = getBalances(trader);

          expect(traderAfter.token0).toEqual(traderBefore.token0 - 5n);
          expect(traderAfter.token2).toEqual(traderBefore.token2 + 1n);
        });

        it("2 -> 1 -> 0", () => {
          const traderBefore = getBalances(trader);

          exactOutput(tokens.map((token) => token.address).reverse(), 1, 5);

          const traderAfter = getBalances(trader);

          expect(traderAfter.token2).toEqual(traderBefore.token2 - 5n);
          expect(traderAfter.token0).toEqual(traderBefore.token0 + 1n);
        });

        it("events", () => {
          const { events } = exactOutput(
            tokens.map((token) => token.address),
            1,
            5
          );
          const pool01 = getPool(tokens[0].address, tokens[1].address);
          const pool12 = getPool(tokens[1].address, tokens[2].address);
          expect(transfers(events, tokens[2])).toEqual([{ from: pool12, to: trader.address, value: 1n }]);
          expect(transfers(events, tokens[1])).toEqual([{ from: pool01, to: pool12, value: 3n }]);
          expect(transfers(events, tokens[0])).toEqual([{ from: trader.address, to: pool01, value: 5n }]);
        });
      });
    });

    describe("#exactOutputSingle", () => {
      function exactOutputSingle(tokenIn, tokenOut, amountOut = 1, amountInMaximum = 3, sqrtPriceLimitX96) {
        const params = {
          from: trader.address,
          recipient: trader.address,
          tokenIn,
          tokenOut,
          fee: FeeAmount.MEDIUM,
          amountOut: amountOut.toString(),
          amountInMaximum: (amountInMaximum - 1).toString(),
          sqrtPriceLimitX96: (sqrtPriceLimitX96 ?? (tokenIn < tokenOut ? 4295128740n : 1461446703485210103287273052203988822378723970341n)).toString(),
          deadline: "9999999999999",
        };

        // ensure that the swap fails if the limit is any tighter
        expectRevert(() => router.send(trader, "exact_output_single", params), "KOINDX: TOO_MUCH_REQUESTED");
        params.amountInMaximum = amountInMaximum.toString();

        return router.send(trader, "exact_output_single", params);
      }

      it("0 -> 1", () => {
        const pool = getPool(tokens[0].address, tokens[1].address);

        // get balances before
        const poolBefore = getBalances(pool);
        const traderBefore = getBalances(trader);

        exactOutputSingle(tokens[0].address, tokens[1].address);

        // get balances after
        const poolAfter = getBalances(pool);
        const traderAfter = getBalances(trader);

        expect(traderAfter.token0).toEqual(traderBefore.token0 - 3n);
        expect(traderAfter.token1).toEqual(traderBefore.token1 + 1n);
        expect(poolAfter.token0).toEqual(poolBefore.token0 + 3n);
        expect(poolAfter.token1).toEqual(poolBefore.token1 - 1n);
      });

      it("1 -> 0", () => {
        const pool = getPool(tokens[1].address, tokens[0].address);

        // get balances before
        const poolBefore = getBalances(pool);
        const traderBefore = getBalances(trader);

        exactOutputSingle(tokens[1].address, tokens[0].address);

        // get balances after
        const poolAfter = getBalances(pool);
        const traderAfter = getBalances(trader);

        expect(traderAfter.token0).toEqual(traderBefore.token0 + 1n);
        expect(traderAfter.token1).toEqual(traderBefore.token1 - 3n);
        expect(poolAfter.token0).toEqual(poolBefore.token0 - 1n);
        expect(poolAfter.token1).toEqual(poolBefore.token1 + 3n);
      });
    });
  });
});
