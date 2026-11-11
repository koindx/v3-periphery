import { Protobuf } from "@koinos/sdk-as";
import { pool } from "./pool";
import { Contract } from "../utils/Contract";

/** entry points of the KoinDX v3 pool (first 4 bytes of sha256 of the method name) */
export namespace PoolEntries {
  export const SLOT0: u32 = 0x4c4b4a1f; // slot0
  export const INITIALIZE: u32 = 0x470ebe82; // initialize
  export const MINT: u32 = 0xdc6f17bb; // mint
  export const BURN: u32 = 0x859facc5; // burn
  export const COLLECT: u32 = 0x81824c90; // collect
  export const SWAP: u32 = 0xda47c2f4; // swap
  export const POSITIONS: u32 = 0xf50871d1; // positions
  export const QUOTE_SWAP: u32 = 0x6e14e06a; // quote_swap
}

/** Client of a KoinDX v3 pool (Uniswap: IUniswapV3Pool) */
export class PoolClient {
  constructor(public address: Uint8Array) {}

  slot0(): pool.slot0_result {
    const res = Contract.call(this.address, PoolEntries.SLOT0, new Uint8Array(0), "KOINDX: POOL_SLOT0_FAILED");
    return Protobuf.decode<pool.slot0_result>(res, pool.slot0_result.decode);
  }

  initialize(sqrtPriceX96: string): void {
    Contract.call(
      this.address,
      PoolEntries.INITIALIZE,
      Protobuf.encode(new pool.initialize_arguments(sqrtPriceX96), pool.initialize_arguments.encode),
      "KOINDX: POOL_INITIALIZE_FAILED"
    );
  }

  mint(recipient: Uint8Array, tickLower: i32, tickUpper: i32, amount: string, data: Uint8Array): pool.mint_result {
    const res = Contract.call(
      this.address,
      PoolEntries.MINT,
      Protobuf.encode(new pool.mint_arguments(recipient, tickLower, tickUpper, amount, data), pool.mint_arguments.encode),
      "KOINDX: POOL_MINT_FAILED"
    );
    return Protobuf.decode<pool.mint_result>(res, pool.mint_result.decode);
  }

  /** burns liquidity of the position owned by the calling contract */
  burn(tickLower: i32, tickUpper: i32, amount: string): pool.burn_result {
    const res = Contract.call(
      this.address,
      PoolEntries.BURN,
      Protobuf.encode(new pool.burn_arguments(tickLower, tickUpper, amount), pool.burn_arguments.encode),
      "KOINDX: POOL_BURN_FAILED"
    );
    return Protobuf.decode<pool.burn_result>(res, pool.burn_result.decode);
  }

  /** collects the tokens owed to the position owned by the calling contract */
  collect(recipient: Uint8Array, tickLower: i32, tickUpper: i32, amount0Requested: u64, amount1Requested: u64): pool.collect_result {
    const res = Contract.call(
      this.address,
      PoolEntries.COLLECT,
      Protobuf.encode(
        new pool.collect_arguments(recipient, tickLower, tickUpper, amount0Requested, amount1Requested),
        pool.collect_arguments.encode
      ),
      "KOINDX: POOL_COLLECT_FAILED"
    );
    return Protobuf.decode<pool.collect_result>(res, pool.collect_result.decode);
  }

  /** exact input: `amountSpecified` of the input token is paid, exact output: `amountSpecified` of the output token is received */
  swap(
    recipient: Uint8Array,
    zeroForOne: bool,
    exactInput: bool,
    amountSpecified: u64,
    sqrtPriceLimitX96: string,
    data: Uint8Array
  ): pool.swap_result {
    const res = Contract.call(
      this.address,
      PoolEntries.SWAP,
      Protobuf.encode(
        new pool.swap_arguments(recipient, zeroForOne, exactInput, amountSpecified, sqrtPriceLimitX96, data),
        pool.swap_arguments.encode
      ),
      "KOINDX: POOL_SWAP_FAILED"
    );
    return Protobuf.decode<pool.swap_result>(res, pool.swap_result.decode);
  }

  positions(owner: Uint8Array, tickLower: i32, tickUpper: i32): pool.positions_result {
    const res = Contract.call(
      this.address,
      PoolEntries.POSITIONS,
      Protobuf.encode(new pool.positions_arguments(owner, tickLower, tickUpper), pool.positions_arguments.encode),
      "KOINDX: POOL_POSITIONS_FAILED"
    );
    return Protobuf.decode<pool.positions_result>(res, pool.positions_result.decode);
  }

  quoteSwap(zeroForOne: bool, exactInput: bool, amountSpecified: u64, sqrtPriceLimitX96: string): pool.quote_swap_result {
    const res = Contract.call(
      this.address,
      PoolEntries.QUOTE_SWAP,
      Protobuf.encode(
        new pool.quote_swap_arguments(zeroForOne, exactInput, amountSpecified, sqrtPriceLimitX96),
        pool.quote_swap_arguments.encode
      ),
      "KOINDX: POOL_QUOTE_FAILED"
    );
    return Protobuf.decode<pool.quote_swap_result>(res, pool.quote_swap_result.decode);
  }
}
