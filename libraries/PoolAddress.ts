import { System } from "@koinos/sdk-as";
import { FactoryClient } from "../interfaces/FactoryClient";
import { PoolClient } from "../interfaces/PoolClient";
import { Network } from "../utils/Network";

/** Identifies a pool: the tokens (sorted, token0 < token1) and the fee */
export class PoolKey {
  constructor(public token0: string, public token1: string, public fee: u32) {}
}

/**
 * Port of Uniswap v3 PoolAddress.
 *
 * Uniswap computes the pool address with CREATE2. Koinos has no deterministic deployment, so
 * the address of a pool is queried to the factory.
 */
export namespace PoolAddress {
  /** Returns PoolKey: the ordered tokens with the matched fee levels */
  export function getPoolKey(tokenA: string, tokenB: string, fee: u32): PoolKey {
    if (tokenA > tokenB) return new PoolKey(tokenB, tokenA, fee);
    return new PoolKey(tokenA, tokenB, fee);
  }

  /** Returns the address of the pool, reverts if the pool doesn't exist */
  export function getPool(tokenA: string, tokenB: string, fee: u32): PoolClient {
    const address = new FactoryClient(Network.factory()).getPool(tokenA, tokenB, fee);
    System.require(address.length > 0, "KOINDX: POOL_NOT_FOUND");
    return new PoolClient(address);
  }
}
