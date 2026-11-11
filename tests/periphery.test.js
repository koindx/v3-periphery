// Differential tests of the periphery libraries (compiled to tests/build/harness.wasm) against a
// BigInt transliteration of the Solidity code (tests/reference.js) and the official @uniswap/v3-sdk.
const JSBI = require("jsbi");
const sdk = require("@uniswap/v3-sdk");
const ref = require("./reference");
const { call, callString, Revert } = require("./harness");

const MAX256 = ref.MAX256;
const N = Number(process.env.FUZZ_RUNS || 1500);

// deterministic PRNG (mulberry32)
let seed = 0x9e3779b9;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function randInt(min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}
/** random BigInt with a random bit length in [0, maxBits], biased towards edge values */
function randBig(maxBits = 256) {
  const r = rand();
  if (r < 0.03) return 0n;
  if (r < 0.06) return 1n;
  if (r < 0.09) return (1n << BigInt(maxBits)) - 1n;
  const bits = randInt(1, maxBits);
  let v = 0n;
  for (let i = 0; i < bits; i += 30) v = (v << 30n) | BigInt(randInt(0, (1 << 30) - 1));
  return v & ((1n << BigInt(bits)) - 1n);
}
const randTick = () => randInt(ref.MIN_TICK, ref.MAX_TICK);
const randPrice = () => ref.getSqrtRatioAtTick(randTick());
const J = (x) => JSBI.BigInt(x.toString());

/** runs the reference and the wasm implementation, both must revert or return the same value */
function same(refFn, wasmFn) {
  let expected, refReverted = false;
  try {
    expected = refFn();
  } catch (e) {
    if (!(e instanceof ref.Revert)) throw e;
    refReverted = true;
  }
  let actual, wasmReverted = false;
  try {
    actual = wasmFn();
  } catch (e) {
    if (!(e instanceof Revert)) throw e;
    wasmReverted = true;
  }
  if (refReverted || wasmReverted) {
    expect({ wasmReverted }).toEqual({ wasmReverted: refReverted });
    return undefined;
  }
  expect(actual).toEqual(expected);
  return actual;
}

describe("shared libraries (copies of v3-core)", () => {
  test("U256 checked arithmetic and mulDiv", () => {
    for (let i = 0; i < N; i++) {
      const a = randBig(), b = randBig(), d = randBig();
      same(() => { if (a + b > MAX256) throw new ref.Revert(); return (a + b).toString(); }, () => callString("u256Add", a, b));
      same(() => { if (a < b) throw new ref.Revert(); return (a - b).toString(); }, () => callString("u256Sub", a, b));
      same(() => { if (a * b > MAX256) throw new ref.Revert(); return (a * b).toString(); }, () => callString("u256Mul", a, b));
      same(() => { if (b === 0n) throw new ref.Revert(); return (a / b).toString(); }, () => callString("u256Div", a, b));
      same(() => ref.mulDiv(a, b, d).toString(), () => callString("u256MulDiv", a, b, d));
      same(() => ref.mulDivRoundingUp(a, b, d).toString(), () => callString("u256MulDivRoundingUp", a, b, d));
      expect(callString("u256WrappingSub", a, b)).toEqual((((a - b) % (1n << 256n)) + (1n << 256n)) % (1n << 256n) + "");
      expect(callString("u256BytesRoundTrip", a)).toEqual(a.toString());
    }
  });

  test("TickMath matches reference and v3-sdk", () => {
    expect(callString("getSqrtRatioAtTick", ref.MIN_TICK)).toEqual(ref.MIN_SQRT_RATIO.toString());
    expect(callString("getSqrtRatioAtTick", ref.MAX_TICK)).toEqual(ref.MAX_SQRT_RATIO.toString());
    expect(() => call("getSqrtRatioAtTick", ref.MAX_TICK + 1)).toThrow(Revert);
    expect(() => call("getTickAtSqrtRatio", ref.MAX_SQRT_RATIO)).toThrow(Revert);
    for (let i = 0; i < N; i++) {
      const tick = randTick();
      const p = ref.getSqrtRatioAtTick(tick);
      expect(callString("getSqrtRatioAtTick", tick)).toEqual(p.toString());
      if (p < ref.MAX_SQRT_RATIO) {
        expect(call("getTickAtSqrtRatio", p)).toEqual(tick);
        expect(sdk.TickMath.getTickAtSqrtRatio(J(p))).toEqual(tick);
      }
    }
  });

  test("SafeCast", () => {
    expect(callString("toUint128", (1n << 128n) - 1n)).toEqual(((1n << 128n) - 1n).toString());
    expect(() => call("toUint128", 1n << 128n)).toThrow(Revert);
    expect(callString("toU64", (1n << 64n) - 1n)).toEqual(((1n << 64n) - 1n).toString());
    expect(() => call("toU64", 1n << 64n)).toThrow(Revert);
  });
});

describe("LiquidityAmounts", () => {
  test("known vectors (LiquidityAmounts.spec)", () => {
    const sqrt = (r1, r0) => BigInt(sdk.encodeSqrtRatioX96(r1, r0).toString());
    // amounts for price inside
    expect(callString("getLiquidityForAmounts", sqrt(1, 1), sqrt(100, 110), sqrt(110, 100), 100n, 200n)).toEqual("2148");
    // amounts for price below
    expect(callString("getLiquidityForAmounts", sqrt(99, 110), sqrt(100, 110), sqrt(110, 100), 100n, 200n)).toEqual("1048");
    // amounts for price above
    expect(callString("getLiquidityForAmounts", sqrt(111, 100), sqrt(100, 110), sqrt(110, 100), 100n, 200n)).toEqual("2097");
    // amounts for price equal to lower boundary
    expect(callString("getLiquidityForAmounts", sqrt(100, 110), sqrt(100, 110), sqrt(110, 100), 100n, 200n)).toEqual("1048");
    // amounts for price equal to upper boundary
    expect(callString("getLiquidityForAmounts", sqrt(110, 100), sqrt(100, 110), sqrt(110, 100), 100n, 200n)).toEqual("2097");
    // amounts for liquidity
    expect(callString("getAmountsForLiquidity", sqrt(1, 1), sqrt(100, 110), sqrt(110, 100), 2148n)).toEqual("99,99");
    expect(callString("getAmountsForLiquidity", sqrt(99, 110), sqrt(100, 110), sqrt(110, 100), 1048n)).toEqual("99,0");
    expect(callString("getAmountsForLiquidity", sqrt(111, 100), sqrt(100, 110), sqrt(110, 100), 2097n)).toEqual("0,199");
    expect(callString("getAmountsForLiquidity", sqrt(100, 110), sqrt(100, 110), sqrt(110, 100), 1048n)).toEqual("99,0");
    expect(callString("getAmountsForLiquidity", sqrt(110, 100), sqrt(100, 110), sqrt(110, 100), 2097n)).toEqual("0,199");
  });

  test("getLiquidityForAmounts matches reference and v3-sdk (maxLiquidityForAmounts)", () => {
    for (let i = 0; i < N; i++) {
      const p = randPrice(), a = randPrice(), b = randPrice();
      if (a === b) continue;
      // token amounts are u64 on Koinos, larger values are tested too
      const amount0 = randBig(rand() < 0.8 ? 64 : 160), amount1 = randBig(rand() < 0.8 ? 64 : 160);
      const res = same(
        () => ref.getLiquidityForAmounts(p, a, b, amount0, amount1).toString(),
        () => callString("getLiquidityForAmounts", p, a, b, amount0, amount1)
      );
      if (res !== undefined) {
        // the v3-sdk "imprecise" mode is the on-chain LiquidityAmounts algorithm
        expect(sdk.maxLiquidityForAmounts(J(p), J(a), J(b), J(amount0), J(amount1), false).toString()).toEqual(res);
      }
    }
  });

  test("getAmountsForLiquidity matches reference", () => {
    for (let i = 0; i < N; i++) {
      const p = randPrice(), a = randPrice(), b = randPrice();
      if (a === b) continue;
      const liquidity = randBig(128);
      same(() => ref.getAmountsForLiquidity(p, a, b, liquidity).join(","), () => callString("getAmountsForLiquidity", p, a, b, liquidity));
    }
  });

  test("never overflows silently: liquidity above uint128 reverts", () => {
    const a = ref.getSqrtRatioAtTick(-1), b = ref.getSqrtRatioAtTick(1);
    // a 1 tick range at price 1 multiplies the amount by ~20000
    expect(() => call("getLiquidityForAmount1", a, b, (1n << 128n) / 10000n)).toThrow(Revert);
    expect(() => call("getLiquidityForAmount0", a, b, (1n << 128n) / 10000n)).toThrow(Revert);
    // the largest Koinos amount (u64) never overflows on any range
    const maxU64 = (1n << 64n) - 1n;
    for (let i = 0; i < N; i++) {
      const lower = randInt(ref.MIN_TICK, ref.MAX_TICK - 1);
      const x = ref.getSqrtRatioAtTick(lower), y = ref.getSqrtRatioAtTick(lower + 1);
      same(() => ref.getLiquidityForAmount0(x, y, maxU64).toString(), () => callString("getLiquidityForAmount0", x, y, maxU64));
      same(() => ref.getLiquidityForAmount1(x, y, maxU64).toString(), () => callString("getLiquidityForAmount1", x, y, maxU64));
    }
  });
});

describe("Path", () => {
  const tokens = "koin,1A,1B,1C";
  const fees = "3000,500,10000";

  test("validate", () => {
    expect(callString("pathValidate", "koin,1A", "3000")).toEqual("koin,1A|3000");
    expect(() => call("pathValidate", "koin", "")).toThrow(Revert);
    expect(() => call("pathValidate", "koin,1A", "")).toThrow(Revert);
    expect(() => call("pathValidate", "koin,1A", "3000,500")).toThrow(Revert);
    expect(() => call("pathValidate", tokens, "3000,500")).toThrow(Revert);
  });

  test("decoding (Path.spec)", () => {
    expect(Boolean(call("pathHasMultiplePools", "koin,1A", "3000"))).toBe(false);
    expect(Boolean(call("pathHasMultiplePools", tokens, fees))).toBe(true);
    expect(call("pathNumPools", tokens, fees)).toBe(3);
    expect(callString("pathFirstPool", tokens, fees)).toEqual("koin,1A|3000");
    expect(callString("pathSkipToken", tokens, fees)).toEqual("1A,1B,1C|500,10000");
    expect(callString("pathSkipToken", "1A,1B,1C", "500,10000")).toEqual("1B,1C|10000");
    expect(callString("pathReverse", tokens, fees)).toEqual("1C,1B,1A,koin|10000,500,3000");
    expect(callString("pathReverse", "koin,1A", "3000")).toEqual("1A,koin|3000");
  });
});

describe("Keys", () => {
  test("token ids are 8 bytes big endian", () => {
    expect(callString("uint64KeyHex", 1n)).toEqual("0000000000000001");
    expect(callString("uint64KeyHex", 258n)).toEqual("0000000000000102");
    expect(callString("uint64KeyHex", (1n << 64n) - 1n)).toEqual("ffffffffffffffff");
    for (let i = 0; i < 200; i++) {
      const v = randBig(64);
      expect(callString("uint64KeyRoundTrip", v)).toEqual(v.toString());
    }
  });

  test("int32 keys keep the numeric order", () => {
    const values = [-2147483648, -887272, -1, 0, 1, 887272, 2147483647];
    for (let i = 0; i < 200; i++) values.push(randInt(-2147483648, 2147483647));
    for (const a of values) {
      expect(call("int32KeyRoundTrip", a)).toEqual(a);
      const b = values[randInt(0, values.length - 1)];
      expect(call("int32KeyCompare", a, b)).toEqual(a < b ? -1 : a > b ? 1 : 0);
    }
  });
});
