// Port of Uniswap v3-periphery test/Path.spec.ts (libraries/Path.ts compiled in
// tests/build/harness.wasm). A KoinDX path is a list of tokens and a list of fees instead of the
// packed bytes of Uniswap (token, fee, token...): the encoding / decoding tests check the
// validation of the lists. Not applicable: gas.
const { call, callString } = require("../../harness");
const { FeeAmount } = require("../shared/utilities");

const tokenAddresses = ["1HZFQFQwhQXSTPyCRpbWj6VYCjJkkLNUey", "1PHx8PaGVRiwnwNZ5QkS3teFz1s5VfQoyh", "1Pa6krGjezwgD57RqZJ7CZJ6KwZZd3Kg8w"];
const fees = [FeeAmount.MEDIUM, FeeAmount.MEDIUM];

const decode = (formatted) => {
  const [tokens, fees] = formatted.split("|");
  return { tokens: tokens ? tokens.split(",") : [], fees: fees ? fees.split(",").map(Number) : [] };
};
const path = {
  validate: (tokens, fees) => decode(callString("pathValidate", tokens.join(","), fees.join(","))),
  hasMultiplePools: (p) => call("pathHasMultiplePools", p.tokens.join(","), p.fees.join(",")) === 1,
  getFirstPool: (p) => decode(callString("pathFirstPool", p.tokens.join(","), p.fees.join(","))),
  skipToken: (p) => decode(callString("pathSkipToken", p.tokens.join(","), p.fees.join(","))),
  decodeFirstPool: (p) => ({ tokenA: p.tokens[0], tokenB: p.tokens[1], fee: p.fees[0] }),
};

describe("Path", () => {
  it("encoding works as expected", () => {
    expect(path.validate(tokenAddresses.slice(0, 2), fees.slice(0, 1))).toEqual({ tokens: tokenAddresses.slice(0, 2), fees: [FeeAmount.MEDIUM] });
    expect(path.validate(tokenAddresses, fees)).toEqual({ tokens: tokenAddresses, fees });
  });

  it("invalid paths revert", () => {
    // a fee for each pair of tokens
    expect(() => path.validate(tokenAddresses, fees.slice(0, 1))).toThrow();
    expect(() => path.validate(tokenAddresses.slice(0, 1), [])).toThrow();
  });

  describe("#hasMultiplePools / #decodeFirstPool / #skipToken / #getFirstPool", () => {
    const encodedPath = { tokens: tokenAddresses, fees };

    it("works on first pool", () => {
      expect(path.hasMultiplePools(encodedPath)).toBe(true);
      const firstPool = path.decodeFirstPool(encodedPath);
      expect(firstPool.tokenA).toEqual(tokenAddresses[0]);
      expect(firstPool.tokenB).toEqual(tokenAddresses[1]);
      expect(firstPool.fee).toEqual(FeeAmount.MEDIUM);
      expect(path.decodeFirstPool(path.getFirstPool(encodedPath))).toEqual(firstPool);
    });

    it("skips 1 item", () => {
      const skipped = path.skipToken(encodedPath);
      expect(skipped).toEqual({ tokens: tokenAddresses.slice(1), fees: fees.slice(1) });
      expect(path.hasMultiplePools(skipped)).toBe(false);
      const { tokenA, tokenB, fee: decodedFee } = path.decodeFirstPool(skipped);
      expect(tokenA).toEqual(tokenAddresses[1]);
      expect(tokenB).toEqual(tokenAddresses[2]);
      expect(decodedFee).toEqual(FeeAmount.MEDIUM);
    });
  });
});
