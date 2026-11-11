import { System, Arrays } from "@koinos/sdk-as";
import { PoolAddress } from "./PoolAddress";
import { PoolClient } from "../interfaces/PoolClient";

/** Port of Uniswap v3 CallbackValidation: provides validation for callbacks from KoinDX v3 pools */
export namespace CallbackValidation {
  /** Returns the pool if the caller is the KoinDX v3 pool of the given tokens and fee, reverts otherwise */
  export function verifyCallback(tokenA: string, tokenB: string, fee: u32): PoolClient {
    const pool = PoolAddress.getPool(tokenA, tokenB, fee);
    System.require(Arrays.equal(System.getCaller().caller, pool.address), "KOINDX: INVALID_CALLBACK_CALLER");
    return pool;
  }
}
