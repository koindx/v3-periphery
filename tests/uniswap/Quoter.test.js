// Port of Uniswap v3-periphery test/Quoter.spec.ts (the first quoter) on the KoinDX quoter, a port
// of QuoterV2 that also returns the amounts of the first quoter.
//
// Koinos differences: the paths are lists of tokens and fees in the order of the swaps (also for
// the exact output), the quotes are read only calls, and the amounts of the single quotes with a
// price limit are 2^64 - 1 (u64 token amounts) instead of 2^256 - 1.
const { completeFixture } = require("./shared/fixtures");
const { encodePriceSqrt, FeeAmount, TICK_SPACINGS, getMinTick, getMaxTick, expandTo18Decimals, MaxUint64 } = require("./shared/utilities");

describe("Quoter", () => {
  let fixture, wallet, nft, quoter, tokens;

  beforeEach(() => {
    fixture = completeFixture();
    ({ wallet, nft, quoter, tokens } = fixture);
    for (const token of tokens) token.transfer(wallet.address, fixture.other.address, expandTo18Decimals(1));
  });

  // test/shared/quoter.ts createPool
  function createPool(tokenAddressA, tokenAddressB) {
    if (tokenAddressA > tokenAddressB) [tokenAddressA, tokenAddressB] = [tokenAddressB, tokenAddressA];
    fixture.createPool(tokenAddressA, tokenAddressB, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
    nft.send(wallet, "mint", {
      from: wallet.address,
      recipient: wallet.address,
      token0: tokenAddressA,
      token1: tokenAddressB,
      fee: FeeAmount.MEDIUM,
      tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
      tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
      amount0Desired: "1000000",
      amount1Desired: "1000000",
      amount0Min: "0",
      amount1Min: "0",
      deadline: "9999999999999",
    });
  }

  const fees = (path) => new Array(path.length - 1).fill(FeeAmount.MEDIUM);
  const quoteExactInput = (path, amountIn) => BigInt(quoter.read("quote_exact_input", { tokens: path, fees: fees(path), amountIn: amountIn.toString() }).amountOut);
  const quoteExactOutput = (path, amountOut) => BigInt(quoter.read("quote_exact_output", { tokens: path, fees: fees(path), amountOut: amountOut.toString() }).amountIn);
  const quoteExactInputSingle = (tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96) =>
    BigInt(quoter.read("quote_exact_input_single", { tokenIn, tokenOut, fee, amountIn: amountIn.toString(), sqrtPriceLimitX96: sqrtPriceLimitX96.toString() }).amountOut);
  const quoteExactOutputSingle = (tokenIn, tokenOut, fee, amountOut, sqrtPriceLimitX96) =>
    BigInt(quoter.read("quote_exact_output_single", { tokenIn, tokenOut, fee, amountOut: amountOut.toString(), sqrtPriceLimitX96: sqrtPriceLimitX96.toString() }).amountIn);

  describe("quotes", () => {
    beforeEach(() => {
      createPool(tokens[0].address, tokens[1].address);
      createPool(tokens[1].address, tokens[2].address);
    });

    describe("#quoteExactInput", () => {
      it("0 -> 1", () => {
        expect(quoteExactInput([tokens[0].address, tokens[1].address], 3)).toEqual(1n);
      });

      it("1 -> 0", () => {
        expect(quoteExactInput([tokens[1].address, tokens[0].address], 3)).toEqual(1n);
      });

      it("0 -> 1 -> 2", () => {
        expect(
          quoteExactInput(
            tokens.map((token) => token.address),
            5
          )
        ).toEqual(1n);
      });

      it("2 -> 1 -> 0", () => {
        expect(quoteExactInput(tokens.map((token) => token.address).reverse(), 5)).toEqual(1n);
      });
    });

    describe("#quoteExactInputSingle", () => {
      it("0 -> 1", () => {
        // -2%
        expect(quoteExactInputSingle(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, MaxUint64, encodePriceSqrt(100, 102))).toEqual(9852n);
      });

      it("1 -> 0", () => {
        // +2%
        expect(quoteExactInputSingle(tokens[1].address, tokens[0].address, FeeAmount.MEDIUM, MaxUint64, encodePriceSqrt(102, 100))).toEqual(9852n);
      });
    });

    describe("#quoteExactOutput", () => {
      it("0 -> 1", () => {
        expect(quoteExactOutput([tokens[0].address, tokens[1].address], 1)).toEqual(3n);
      });

      it("1 -> 0", () => {
        expect(quoteExactOutput([tokens[1].address, tokens[0].address], 1)).toEqual(3n);
      });

      it("0 -> 1 -> 2", () => {
        expect(
          quoteExactOutput(
            tokens.map((token) => token.address),
            1
          )
        ).toEqual(5n);
      });

      it("2 -> 1 -> 0", () => {
        expect(quoteExactOutput(tokens.map((token) => token.address).reverse(), 1)).toEqual(5n);
      });
    });

    describe("#quoteExactOutputSingle", () => {
      it("0 -> 1", () => {
        expect(quoteExactOutputSingle(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, MaxUint64, encodePriceSqrt(100, 102))).toEqual(9981n);
      });

      it("1 -> 0", () => {
        expect(quoteExactOutputSingle(tokens[1].address, tokens[0].address, FeeAmount.MEDIUM, MaxUint64, encodePriceSqrt(102, 100))).toEqual(9981n);
      });
    });
  });
});
