import { Protobuf } from "@koinos/sdk-as";
import { factory } from "./factory";
import { Contract } from "../utils/Contract";

/** entry points of the KoinDX v3 factory (first 4 bytes of sha256 of the method name) */
export namespace FactoryEntries {
  export const GET_POOL: u32 = 0x5c137711; // get_pool
}

/** Client of the KoinDX v3 factory (Uniswap: IUniswapV3Factory) */
export class FactoryClient {
  constructor(public address: Uint8Array) {}

  /** address of the pool, or an empty array if it doesn't exist */
  getPool(tokenA: string, tokenB: string, fee: u32): Uint8Array {
    const res = Contract.call(
      this.address,
      FactoryEntries.GET_POOL,
      Protobuf.encode(new factory.get_pool_arguments(tokenA, tokenB, fee), factory.get_pool_arguments.encode),
      "KOINDX: FACTORY_GET_POOL_FAILED"
    );
    return Protobuf.decode<factory.address>(res, factory.address.decode).value;
  }
}
