import { System, Protobuf } from "@koinos/sdk-as";
import { manager } from "./proto/manager";
import { U256 } from "../../../libraries/U256";
import { TickMath } from "../../../libraries/TickMath";
import { LiquidityAmounts } from "../../../libraries/LiquidityAmounts";
import { PoolAddress, PoolKey } from "../../../libraries/PoolAddress";
import { CallbackValidation } from "../../../libraries/CallbackValidation";
import { PoolClient } from "../../../interfaces/PoolClient";
import { PeripheryPayments } from "../../../base/PeripheryPayments";

export class AddLiquidityResult {
  constructor(
    public liquidity: U256,
    public amount0: u64,
    public amount1: u64,
    public pool: PoolClient
  ) {}
}

/**
 * Port of Uniswap v3 LiquidityManagement: liquidity management functions for the KoinDX v3 pools
 */
export namespace LiquidityManagement {
  /** Pays the tokens owed to the pool for the minted liquidity (koindx_v3_mint_callback) */
  export function mintCallback(amount0Owed: u64, amount1Owed: u64, data: Uint8Array): void {
    const decoded = Protobuf.decode<manager.mint_callback_data>(data, manager.mint_callback_data.decode);
    System.require(decoded.pool_key !== null, "KOINDX: INVALID_CALLBACK_DATA");
    const key = decoded.pool_key!;
    const pool = CallbackValidation.verifyCallback(key.token0, key.token1, key.fee);

    if (amount0Owed > 0) PeripheryPayments.pay(key.token0, decoded.payer, pool.address, amount0Owed);
    if (amount1Owed > 0) PeripheryPayments.pay(key.token1, decoded.payer, pool.address, amount1Owed);
  }

  /** Add liquidity to an initialized pool */
  export function addLiquidity(
    key: PoolKey,
    recipient: Uint8Array,
    tickLower: i32,
    tickUpper: i32,
    amount0Desired: u64,
    amount1Desired: u64,
    amount0Min: u64,
    amount1Min: u64,
    payer: Uint8Array
  ): AddLiquidityResult {
    const pool = PoolAddress.getPool(key.token0, key.token1, key.fee);

    // compute the liquidity amount
    const sqrtPriceX96 = U256.fromString(pool.slot0().sqrt_price_x96);
    System.require(!sqrtPriceX96.isZero(), "KOINDX: POOL_NOT_INITIALIZED");
    const sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
    const sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);
    const liquidity = LiquidityAmounts.getLiquidityForAmounts(
      sqrtPriceX96,
      sqrtRatioAX96,
      sqrtRatioBX96,
      U256.fromU64(amount0Desired),
      U256.fromU64(amount1Desired)
    );

    const data = Protobuf.encode(
      new manager.mint_callback_data(new manager.pool_key(key.token0, key.token1, key.fee), payer),
      manager.mint_callback_data.encode
    );
    const res = pool.mint(recipient, tickLower, tickUpper, liquidity.toString(), data);

    System.require(res.amount0 >= amount0Min && res.amount1 >= amount1Min, "KOINDX: PRICE_SLIPPAGE_CHECK");
    return new AddLiquidityResult(liquidity, res.amount0, res.amount1, pool);
  }
}
