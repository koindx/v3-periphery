import { System } from "@koinos/sdk-as";

/**
 * Port of Uniswap v3 Path.
 *
 * Uniswap packs swap paths as bytes (token, fee, token, fee, token...). KoinDX uses two
 * protobuf arrays: `tokens` (n tokens) and `fees` (n - 1 fees, fees[i] is the fee of the pool
 * between tokens[i] and tokens[i + 1]).
 */
export class Path {
  constructor(public tokens: string[], public fees: u32[]) {}

  static validate(tokens: string[], fees: u32[]): Path {
    System.require(tokens.length >= 2 && fees.length == tokens.length - 1, "KOINDX: INVALID_PATH");
    return new Path(tokens, fees);
  }

  /** Returns true iff the path contains two or more pools */
  hasMultiplePools(): bool {
    return this.tokens.length > 2;
  }

  /** Returns the number of pools in the path */
  numPools(): i32 {
    return this.fees.length;
  }

  /** first token of the first pool */
  tokenA(): string {
    return this.tokens[0];
  }

  /** second token of the first pool */
  tokenB(): string {
    return this.tokens[1];
  }

  /** fee of the first pool */
  fee(): u32 {
    return this.fees[0];
  }

  /** Gets the segment corresponding to the first pool in the path */
  getFirstPool(): Path {
    return new Path([this.tokens[0], this.tokens[1]], [this.fees[0]]);
  }

  /** Skips a token + fee element from the path and returns the remainder */
  skipToken(): Path {
    return new Path(this.tokens.slice(1), this.fees.slice(1));
  }

  /** Returns the path in the opposite direction (Uniswap encodes exact output paths reversed) */
  reverse(): Path {
    const tokens = new Array<string>(this.tokens.length);
    const fees = new Array<u32>(this.fees.length);
    for (let i = 0; i < this.tokens.length; i++) tokens[i] = this.tokens[this.tokens.length - 1 - i];
    for (let i = 0; i < this.fees.length; i++) fees[i] = this.fees[this.fees.length - 1 - i];
    return new Path(tokens, fees);
  }
}
