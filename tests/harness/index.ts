// Test harness: exposes the pure libraries of the periphery with string based inputs/outputs so
// they can be compared (differential testing) against BigInt and the official @uniswap/v3-sdk.
import { U256 } from "../../libraries/U256";
import { TickMath } from "../../libraries/TickMath";
import { SafeCast } from "../../libraries/SafeCast";
import { LiquidityAmounts } from "../../libraries/LiquidityAmounts";
import { Path } from "../../libraries/Path";
import { Keys } from "../../utils/Keys";

function u(s: string): U256 {
  return U256.fromString(s);
}

// U256 (tests/harness/u256.ts, shared with v3-core) ---------------------------

export * from "./u256";

// TickMath (copy of the v3-core library) ---------------------------------------

export function getSqrtRatioAtTick(tick: i32): string { return TickMath.getSqrtRatioAtTick(tick).toString(); }
export function getTickAtSqrtRatio(sqrtPriceX96: string): i32 { return TickMath.getTickAtSqrtRatio(u(sqrtPriceX96)); }

// SafeCast ---------------------------------------------------------------------

export function toUint128(a: string): string { return SafeCast.toUint128(u(a)).toString(); }
export function toU64(a: string): string { return SafeCast.toU64(u(a)).toString(); }

// LiquidityAmounts -------------------------------------------------------------

export function getLiquidityForAmount0(a: string, b: string, amount0: string): string {
  return LiquidityAmounts.getLiquidityForAmount0(u(a), u(b), u(amount0)).toString();
}
export function getLiquidityForAmount1(a: string, b: string, amount1: string): string {
  return LiquidityAmounts.getLiquidityForAmount1(u(a), u(b), u(amount1)).toString();
}
export function getLiquidityForAmounts(p: string, a: string, b: string, amount0: string, amount1: string): string {
  return LiquidityAmounts.getLiquidityForAmounts(u(p), u(a), u(b), u(amount0), u(amount1)).toString();
}
export function getAmountsForLiquidity(p: string, a: string, b: string, liquidity: string): string {
  const res = LiquidityAmounts.getAmountsForLiquidity(u(p), u(a), u(b), u(liquidity));
  return res.amount0.toString() + "," + res.amount1.toString();
}

// Path -------------------------------------------------------------------------

/** tokens are joined with "," and fees with ","; returns "tokens|fees" of the transformed path */
function parsePath(tokens: string, fees: string): Path {
  const t = tokens.length == 0 ? new Array<string>() : tokens.split(",");
  const f = new Array<u32>();
  if (fees.length > 0) {
    const parts = fees.split(",");
    for (let i = 0; i < parts.length; i++) f.push(<u32>parseInt(parts[i]));
  }
  return Path.validate(t, f);
}

function formatPath(path: Path): string {
  const fees = new Array<string>();
  for (let i = 0; i < path.fees.length; i++) fees.push(path.fees[i].toString());
  return path.tokens.join(",") + "|" + fees.join(",");
}

export function pathValidate(tokens: string, fees: string): string { return formatPath(parsePath(tokens, fees)); }
export function pathHasMultiplePools(tokens: string, fees: string): bool { return parsePath(tokens, fees).hasMultiplePools(); }
export function pathNumPools(tokens: string, fees: string): i32 { return parsePath(tokens, fees).numPools(); }
export function pathFirstPool(tokens: string, fees: string): string { return formatPath(parsePath(tokens, fees).getFirstPool()); }
export function pathSkipToken(tokens: string, fees: string): string { return formatPath(parsePath(tokens, fees).skipToken()); }
export function pathReverse(tokens: string, fees: string): string { return formatPath(parsePath(tokens, fees).reverse()); }

// Keys (token ids of the position manager) ---------------------------------------

export function uint64KeyRoundTrip(value: string): string { return Keys.toUint64(Keys.uint64(SafeCast.toU64(u(value)))).toString(); }
export function int32KeyRoundTrip(value: i32): i32 { return Keys.toInt32(Keys.int32(value)); }
/** -1, 0 or 1 comparing the byte keys of a and b (the order of the Koinos state database) */
export function int32KeyCompare(a: i32, b: i32): i32 {
  const ka = Keys.int32(a);
  const kb = Keys.int32(b);
  for (let i = 0; i < 4; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}
export function uint64KeyHex(value: string): string {
  const key = Keys.uint64(SafeCast.toU64(u(value)));
  let hex = "";
  for (let i = 0; i < key.length; i++) {
    const b = key[i];
    hex += (b < 16 ? "0" : "") + b.toString(16);
  }
  return hex;
}
