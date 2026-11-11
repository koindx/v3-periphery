import { System, Storage, Protobuf, Arrays, authority } from "@koinos/sdk-as";
import { manager } from "./proto/manager";
import { Spaces } from "./Spaces";
import { Nft, tokenIdToBytes, tokenIdFromBytes } from "./Nft";
import { LiquidityManagement } from "./LiquidityManagement";
import { Network } from "../../../utils/Network";
import { Contract } from "../../../utils/Contract";
import { Keys } from "../../../utils/Keys";
import { ADDRESS_LENGTH } from "../../../utils/Tokens";
import { U256 } from "../../../libraries/U256";
import { SafeCast } from "../../../libraries/SafeCast";
import { FixedPoint128 } from "../../../libraries/FixedPoint";
import { PoolAddress, PoolKey } from "../../../libraries/PoolAddress";
import { PoolClient } from "../../../interfaces/PoolClient";
import { PeripheryValidation } from "../../../base/PeripheryValidation";

const NAME = "KoinDX V3 Positions NFT-V1";
const SYMBOL = "KOINDX-V3-POS";
const URI = "";
const DESCRIPTION = "This NFT represents a liquidity position in a KoinDX V3 pool. The owner of this NFT can modify or redeem the position.";

/** uint128 += uint128 of Uniswap (Solidity 0.7, unchecked): b is truncated to 128 bits, the sum wraps around */
function addUint128Wrapping(a: U256, b: U256): U256 {
  return U256.truncate(U256.wrappingAdd(a, U256.truncate(b, 128)), 128);
}

/** details about the position (Uniswap NonfungiblePositionManager.Position) */
class Position {
  poolId: u64 = 0;
  tickLower: i32 = 0;
  tickUpper: i32 = 0;
  liquidity: U256 = U256.zero();
  feeGrowthInside0LastX128: U256 = U256.zero();
  feeGrowthInside1LastX128: U256 = U256.zero();
  tokensOwed0: U256 = U256.zero();
  tokensOwed1: U256 = U256.zero();

  static fromRecord(record: manager.position_record): Position {
    const p = new Position();
    p.poolId = record.pool_id;
    p.tickLower = record.tick_lower;
    p.tickUpper = record.tick_upper;
    p.liquidity = U256.fromBytes(record.liquidity);
    p.feeGrowthInside0LastX128 = U256.fromBytes(record.fee_growth_inside0_last_x128);
    p.feeGrowthInside1LastX128 = U256.fromBytes(record.fee_growth_inside1_last_x128);
    p.tokensOwed0 = U256.fromBytes(record.tokens_owed0);
    p.tokensOwed1 = U256.fromBytes(record.tokens_owed1);
    return p;
  }

  toRecord(): manager.position_record {
    return new manager.position_record(
      this.poolId,
      this.tickLower,
      this.tickUpper,
      this.liquidity.toBytes(),
      this.feeGrowthInside0LastX128.toBytes(),
      this.feeGrowthInside1LastX128.toBytes(),
      this.tokensOwed0.toBytes(),
      this.tokensOwed1.toBytes()
    );
  }

  /**
   * accounts the fees earned by the position since the last update
   * (the subtraction of fee growth wraps around on purpose)
   */
  accrueFees(liquidity: U256, feeGrowthInside0X128: U256, feeGrowthInside1X128: U256): void {
    // like Uniswap (Solidity 0.7): the fees are truncated to uint128 and tokensOwed wraps around
    // at 2^128, so a position can always be decreased and collected
    this.tokensOwed0 = addUint128Wrapping(
      this.tokensOwed0,
      U256.mulDiv(U256.wrappingSub(feeGrowthInside0X128, this.feeGrowthInside0LastX128), liquidity, FixedPoint128.Q128)
    );
    this.tokensOwed1 = addUint128Wrapping(
      this.tokensOwed1,
      U256.mulDiv(U256.wrappingSub(feeGrowthInside1X128, this.feeGrowthInside1LastX128), liquidity, FixedPoint128.Q128)
    );
    this.feeGrowthInside0LastX128 = feeGrowthInside0X128;
    this.feeGrowthInside1LastX128 = feeGrowthInside1X128;
  }
}

/**
 * KoinDX v3 positions manager: port of Uniswap v3 NonfungiblePositionManager.
 *
 * Wraps KoinDX v3 positions in the Koinos collections NFT interface (KCS-2).
 */
export class Manager {
  contractId: Uint8Array;
  counters: Storage.Obj<manager.counters_record>;
  positionStore: Storage.Map<Uint8Array, manager.position_record>;
  poolIds: Storage.Map<Uint8Array, manager.uint64>;
  pools: Storage.Map<Uint8Array, manager.pool_record>;
  nft: Nft;

  constructor() {
    this.contractId = System.getContractId();
    this.counters = new Storage.Obj(
      this.contractId,
      Spaces.COUNTERS_SPACE_ID,
      manager.counters_record.decode,
      manager.counters_record.encode,
      () => new manager.counters_record(1, 1, 0)
    );
    this.positionStore = new Storage.Map(
      this.contractId,
      Spaces.POSITIONS_SPACE_ID,
      manager.position_record.decode,
      manager.position_record.encode,
      null
    );
    this.poolIds = new Storage.Map(
      this.contractId,
      Spaces.POOL_IDS_SPACE_ID,
      manager.uint64.decode,
      manager.uint64.encode,
      null
    );
    this.pools = new Storage.Map(
      this.contractId,
      Spaces.POOLS_SPACE_ID,
      manager.pool_record.decode,
      manager.pool_record.encode,
      null
    );
    this.nft = new Nft(this.contractId);
  }

  /**
   * The contract is deployed overriding its own authority (call contract, transaction
   * application and upload contract): nobody can act on behalf of it or upgrade its code.
   */
  authorize(args: authority.authorize_arguments): authority.authorize_result {
    return new authority.authorize_result(false);
  }

  // ---------------------------------------------------------------------------
  // NFT read methods
  // ---------------------------------------------------------------------------

  name(args: manager.name_arguments): manager.str {
    return new manager.str(NAME);
  }

  symbol(args: manager.symbol_arguments): manager.str {
    return new manager.str(SYMBOL);
  }

  uri(args: manager.uri_arguments): manager.str {
    return new manager.str(URI);
  }

  get_info(args: manager.get_info_arguments): manager.get_info_result {
    return new manager.get_info_result(NAME, SYMBOL, URI, DESCRIPTION);
  }

  total_supply(args: manager.total_supply_arguments): manager.uint64 {
    return new manager.uint64(this.nft.totalSupply());
  }

  balance_of(args: manager.balance_of_arguments): manager.uint64 {
    return new manager.uint64(this.nft.balanceOf(args.owner));
  }

  owner_of(args: manager.owner_of_arguments): manager.address {
    return new manager.address(this.nft.ownerOf(args.token_id));
  }

  get_approved(args: manager.get_approved_arguments): manager.address {
    return new manager.address(this.nft.getApproved(args.token_id));
  }

  is_approved_for_all(args: manager.is_approved_for_all_arguments): manager.boole {
    return new manager.boole(this.nft.isApprovedForAll(args.owner, args.operator));
  }

  get_tokens_by_owner(args: manager.get_tokens_by_owner_arguments): manager.get_tokens_by_owner_result {
    let limit = args.limit;
    if (limit <= 0 || limit > 100) limit = 100;
    return new manager.get_tokens_by_owner_result(this.nft.tokensByOwner(args.owner, args.start, limit, args.descending));
  }

  metadata_of(args: manager.metadata_of_arguments): manager.str {
    const id = tokenIdFromBytes(args.token_id);
    const position = this.getPosition(args.token_id);
    const pool = this.getPoolRecord(position.poolId);
    const json = "{" +
      '"name":"KoinDX V3 Position #' + id.toString() + '",' +
      '"description":"' + DESCRIPTION + '",' +
      '"attributes":[' +
      '{"trait_type":"token0","value":"' + pool.token0 + '"},' +
      '{"trait_type":"token1","value":"' + pool.token1 + '"},' +
      '{"trait_type":"fee","value":' + pool.fee.toString() + "}," +
      '{"trait_type":"tick_lower","value":' + position.tickLower.toString() + "}," +
      '{"trait_type":"tick_upper","value":' + position.tickUpper.toString() + "}," +
      '{"trait_type":"liquidity","value":"' + position.liquidity.toString() + '"}' +
      "]}";
    return new manager.str(json);
  }

  // ---------------------------------------------------------------------------
  // NFT write methods
  // ---------------------------------------------------------------------------

  transfer(args: manager.transfer_arguments): manager.empty_object {
    const owner = this.nft.ownerOf(args.token_id);
    System.require(owner.length > 0, "KOINDX: INVALID_TOKEN_ID");
    System.require(Arrays.equal(args.from, owner), "KOINDX: FROM_IS_NOT_OWNER");

    const caller = System.getCaller().caller;
    if (caller.length > 0) {
      // a contract can transfer the token if it is the owner, the approved account or an operator
      System.require(this.nft.isApprovedOrOwner(caller, args.token_id), "KOINDX: NOT_APPROVED");
    } else {
      System.require(
        System.checkAuthority(authority.authorization_type.contract_call, owner, System.getArguments().args),
        "KOINDX: NOT_APPROVED"
      );
      // the authority check can run the code of a smart wallet (its `authorize`), which could
      // transfer the token: it must still belong to the owner that authorized the transfer
      System.require(Arrays.equal(this.nft.ownerOf(args.token_id), owner), "KOINDX: FROM_IS_NOT_OWNER");
    }
    this.nft.transfer(owner, args.to, args.token_id);
    return new manager.empty_object();
  }

  approve(args: manager.approve_arguments): manager.empty_object {
    // first the authority check: it can run the code of a smart wallet (its `authorize`)
    const sender = Contract.getSender(args.approver_address);
    const owner = this.nft.ownerOf(args.token_id);
    System.require(owner.length > 0, "KOINDX: INVALID_TOKEN_ID");
    System.require(args.to.length == 0 || args.to.length == ADDRESS_LENGTH, "KOINDX: INVALID_APPROVED");
    System.require(
      Arrays.equal(sender, owner) || this.nft.isApprovedForAll(owner, sender),
      "KOINDX: NOT_APPROVED"
    );
    System.require(!Arrays.equal(args.to, owner), "KOINDX: APPROVAL_TO_CURRENT_OWNER");
    this.nft.approve(sender, args.to, args.token_id);
    return new manager.empty_object();
  }

  set_approval_for_all(args: manager.set_approval_for_all_arguments): manager.empty_object {
    const sender = Contract.getSender(args.approver_address);
    System.require(args.operator_address.length == ADDRESS_LENGTH, "KOINDX: INVALID_OPERATOR");
    System.require(!Arrays.equal(args.operator_address, sender), "KOINDX: APPROVE_TO_CALLER");
    this.nft.setApprovalForAll(sender, args.operator_address, args.approved);
    return new manager.empty_object();
  }

  // ---------------------------------------------------------------------------
  // positions
  // ---------------------------------------------------------------------------

  factory(args: manager.factory_arguments): manager.address {
    return new manager.address(Network.factory());
  }

  positions(args: manager.positions_arguments): manager.positions_result {
    const position = this.getPosition(args.token_id);
    const pool = this.getPoolRecord(position.poolId);
    return new manager.positions_result(
      this.nft.getApproved(args.token_id),
      pool.token0,
      pool.token1,
      pool.fee,
      position.tickLower,
      position.tickUpper,
      position.liquidity.toString(),
      position.feeGrowthInside0LastX128.toString(),
      position.feeGrowthInside1LastX128.toString(),
      position.tokensOwed0.toString(),
      position.tokensOwed1.toString(),
      pool.pool
    );
  }

  /**
   * Uniswap: createAndInitializePoolIfNecessary. Koinos pools are created by uploading the pool
   * bytecode in the transaction that calls `factory.create_pool`, so this method only sets the
   * initial price of an existing pool. It can be added to the same transaction, after create_pool.
   */
  initialize_pool_if_necessary(args: manager.initialize_pool_if_necessary_arguments): manager.address {
    System.require(args.token0 < args.token1, "KOINDX: TOKENS_NOT_SORTED");
    const pool = PoolAddress.getPool(args.token0, args.token1, args.fee);
    const sqrtPriceX96 = U256.fromString(pool.slot0().sqrt_price_x96);
    if (sqrtPriceX96.isZero()) {
      pool.initialize(args.sqrt_price_x96);
    }
    return new manager.address(pool.address);
  }

  mint(args: manager.mint_arguments): manager.mint_result {
    PeripheryValidation.checkDeadline(args.deadline);
    const payer = Contract.getSender(args.from);
    System.require(args.recipient.length == ADDRESS_LENGTH, "KOINDX: INVALID_RECIPIENT");
    System.require(args.token0 < args.token1, "KOINDX: TOKENS_NOT_SORTED");

    const key = new PoolKey(args.token0, args.token1, args.fee);
    const res = LiquidityManagement.addLiquidity(
      key,
      this.contractId,
      args.tick_lower,
      args.tick_upper,
      args.amount0_desired,
      args.amount1_desired,
      args.amount0_min,
      args.amount1_min,
      payer
    );

    const counters = this.counters.get()!;
    const tokenId = tokenIdToBytes(counters.next_id);
    counters.next_id += 1;
    this.counters.put(counters);
    this.nft.mint(args.recipient, tokenId);

    // the fee growth inside the position is now updated to the current transaction
    const poolPosition = res.pool.positions(this.contractId, args.tick_lower, args.tick_upper);

    const position = new Position();
    position.poolId = this.cachePoolKey(res.pool, key);
    position.tickLower = args.tick_lower;
    position.tickUpper = args.tick_upper;
    position.liquidity = res.liquidity;
    position.feeGrowthInside0LastX128 = U256.fromString(poolPosition.fee_growth_inside0_last_x128);
    position.feeGrowthInside1LastX128 = U256.fromString(poolPosition.fee_growth_inside1_last_x128);
    this.positionStore.put(tokenId, position.toRecord());

    this.emitIncreaseLiquidity(tokenId, res.liquidity, res.amount0, res.amount1);
    return new manager.mint_result(tokenId, res.liquidity.toString(), res.amount0, res.amount1);
  }

  increase_liquidity(args: manager.increase_liquidity_arguments): manager.increase_liquidity_result {
    PeripheryValidation.checkDeadline(args.deadline);
    const payer = Contract.getSender(args.from);
    let position = this.getPosition(args.token_id);
    const pool = this.getPoolRecord(position.poolId);

    const res = LiquidityManagement.addLiquidity(
      new PoolKey(pool.token0, pool.token1, pool.fee),
      this.contractId,
      position.tickLower,
      position.tickUpper,
      args.amount0_desired,
      args.amount1_desired,
      args.amount0_min,
      args.amount1_min,
      payer
    );
    // the payment can run the code of the payer (the `authorize` of a smart wallet), which could
    // have changed the position (Uniswap: storage pointer): read it again
    position = this.getPosition(args.token_id);

    // this is now updated to the current transaction
    const poolPosition = res.pool.positions(this.contractId, position.tickLower, position.tickUpper);
    position.accrueFees(
      position.liquidity,
      U256.fromString(poolPosition.fee_growth_inside0_last_x128),
      U256.fromString(poolPosition.fee_growth_inside1_last_x128)
    );
    position.liquidity = SafeCast.toUint128(U256.add(position.liquidity, res.liquidity));
    this.positionStore.put(args.token_id, position.toRecord());

    this.emitIncreaseLiquidity(args.token_id, res.liquidity, res.amount0, res.amount1);
    return new manager.increase_liquidity_result(res.liquidity.toString(), res.amount0, res.amount1);
  }

  decrease_liquidity(args: manager.decrease_liquidity_arguments): manager.decrease_liquidity_result {
    PeripheryValidation.checkDeadline(args.deadline);
    this.requireApprovedOrOwner(args.from, args.token_id);
    const liquidity = U256.fromString(args.liquidity);
    System.require(!liquidity.isZero(), "KOINDX: ZERO_LIQUIDITY");

    const position = this.getPosition(args.token_id);
    const positionLiquidity = position.liquidity;
    System.require(U256.gte(positionLiquidity, liquidity), "KOINDX: INSUFFICIENT_LIQUIDITY");

    const pool = new PoolClient(this.getPoolRecord(position.poolId).pool);
    const res = pool.burn(position.tickLower, position.tickUpper, liquidity.toString());
    System.require(res.amount0 >= args.amount0_min && res.amount1 >= args.amount1_min, "KOINDX: PRICE_SLIPPAGE_CHECK");

    // this is now updated to the current transaction
    const poolPosition = pool.positions(this.contractId, position.tickLower, position.tickUpper);
    position.tokensOwed0 = addUint128Wrapping(position.tokensOwed0, U256.fromU64(res.amount0));
    position.tokensOwed1 = addUint128Wrapping(position.tokensOwed1, U256.fromU64(res.amount1));
    position.accrueFees(
      positionLiquidity,
      U256.fromString(poolPosition.fee_growth_inside0_last_x128),
      U256.fromString(poolPosition.fee_growth_inside1_last_x128)
    );
    // subtraction is safe because we checked positionLiquidity is gte liquidity
    position.liquidity = U256.sub(positionLiquidity, liquidity);
    this.positionStore.put(args.token_id, position.toRecord());

    System.event(
      "manager.decrease_liquidity_event",
      Protobuf.encode(
        new manager.decrease_liquidity_event(args.token_id, liquidity.toString(), res.amount0, res.amount1),
        manager.decrease_liquidity_event.encode
      ),
      [this.nft.ownerOf(args.token_id)]
    );
    return new manager.decrease_liquidity_result(res.amount0, res.amount1);
  }

  collect(args: manager.collect_arguments): manager.collect_result {
    this.requireApprovedOrOwner(args.from, args.token_id);
    System.require(args.amount0_max > 0 || args.amount1_max > 0, "KOINDX: INVALID_AMOUNTS");
    System.require(args.recipient.length == ADDRESS_LENGTH, "KOINDX: INVALID_RECIPIENT");

    const position = this.getPosition(args.token_id);
    const pool = new PoolClient(this.getPoolRecord(position.poolId).pool);

    // trigger an update of the position fees owed and fee growth snapshots if it has any liquidity
    if (!position.liquidity.isZero()) {
      pool.burn(position.tickLower, position.tickUpper, "0");
      const poolPosition = pool.positions(this.contractId, position.tickLower, position.tickUpper);
      position.accrueFees(
        position.liquidity,
        U256.fromString(poolPosition.fee_growth_inside0_last_x128),
        U256.fromString(poolPosition.fee_growth_inside1_last_x128)
      );
    }

    // compute the arguments to give to the pool#collect method
    const amount0Collect = minU64(args.amount0_max, position.tokensOwed0);
    const amount1Collect = minU64(args.amount1_max, position.tokensOwed1);

    // the actual amounts collected are returned
    const res = pool.collect(args.recipient, position.tickLower, position.tickUpper, amount0Collect, amount1Collect);

    // sometimes there will be a few less units than expected due to rounding down in core, but we just subtract
    // the full amount expected instead of the actual amount so we can burn the token
    position.tokensOwed0 = U256.sub(position.tokensOwed0, U256.fromU64(amount0Collect));
    position.tokensOwed1 = U256.sub(position.tokensOwed1, U256.fromU64(amount1Collect));
    this.positionStore.put(args.token_id, position.toRecord());

    System.event(
      "manager.collect_event",
      Protobuf.encode(
        new manager.collect_event(args.token_id, args.recipient, amount0Collect, amount1Collect),
        manager.collect_event.encode
      ),
      [args.recipient, this.nft.ownerOf(args.token_id)]
    );
    return new manager.collect_result(res.amount0, res.amount1);
  }

  burn(args: manager.burn_arguments): manager.empty_object {
    this.requireApprovedOrOwner(args.from, args.token_id);
    const position = this.getPosition(args.token_id);
    System.require(
      position.liquidity.isZero() && position.tokensOwed0.isZero() && position.tokensOwed1.isZero(),
      "KOINDX: NOT_CLEARED"
    );
    this.positionStore.remove(args.token_id);
    this.nft.burn(args.token_id);
    return new manager.empty_object();
  }

  koindx_v3_mint_callback(args: manager.koindx_v3_mint_callback_arguments): manager.empty_object {
    LiquidityManagement.mintCallback(args.amount0_owed, args.amount1_owed, args.data);
    return new manager.empty_object();
  }

  // ---------------------------------------------------------------------------
  // internal
  // ---------------------------------------------------------------------------

  /** the account executing the operation must be the owner, the approved account or an operator */
  private requireApprovedOrOwner(from: Uint8Array, tokenId: Uint8Array): void {
    const sender = Contract.getSender(from);
    System.require(this.nft.isApprovedOrOwner(sender, tokenId), "KOINDX: NOT_APPROVED");
  }

  private getPosition(tokenId: Uint8Array): Position {
    tokenIdFromBytes(tokenId);
    const record = this.positionStore.get(tokenId);
    System.require(record !== null, "KOINDX: INVALID_TOKEN_ID");
    return Position.fromRecord(record!);
  }

  private getPoolRecord(poolId: u64): manager.pool_record {
    const record = this.pools.get(Keys.uint64(poolId));
    System.require(record !== null, "KOINDX: INVALID_POOL_ID");
    return record!;
  }

  /** returns the id of the pool, registering it the first time */
  private cachePoolKey(pool: PoolClient, key: PoolKey): u64 {
    const existing = this.poolIds.get(pool.address);
    if (existing) return existing.value;
    const counters = this.counters.get()!;
    const poolId = counters.next_pool_id;
    counters.next_pool_id += 1;
    this.counters.put(counters);
    this.poolIds.put(pool.address, new manager.uint64(poolId));
    this.pools.put(Keys.uint64(poolId), new manager.pool_record(key.token0, key.token1, key.fee, pool.address));
    return poolId;
  }

  private emitIncreaseLiquidity(tokenId: Uint8Array, liquidity: U256, amount0: u64, amount1: u64): void {
    System.event(
      "manager.increase_liquidity_event",
      Protobuf.encode(
        new manager.increase_liquidity_event(tokenId, liquidity.toString(), amount0, amount1),
        manager.increase_liquidity_event.encode
      ),
      [this.nft.ownerOf(tokenId)]
    );
  }
}

/** min(max, owed) where owed may be bigger than 64 bits */
function minU64(max: u64, owed: U256): u64 {
  if (owed.fitsBits(64) && owed.w0 < max) return owed.w0;
  return max;
}
