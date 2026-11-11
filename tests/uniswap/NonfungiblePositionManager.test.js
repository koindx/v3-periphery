// Port of Uniswap v3-periphery test/NonfungiblePositionManager.spec.ts on the KoinDX position
// manager (contracts/manager) in the Koinos VM emulator.
//
// Koinos differences:
// - the payer of mint / increase_liquidity is `from` (it signs the transaction), there are no
//   token approvals: "cannot transfer" is a payer that didn't sign or has no tokens
// - createAndInitializePoolIfNecessary: a Koinos pool is created by uploading its bytecode in the
//   transaction that calls factory.create_pool; initialize_pool_if_necessary initializes it (same
//   transaction in the fixture)
// - the NFT follows the Koinos collections standards (KCS-2 / KCS-5): `transfer(from, to, id)`,
//   the approvals are checked against the calling contract (an approved account can't transfer
//   directly, an approved contract can); the operator of a position can decrease, collect and
//   burn it with `from`
// - multicall: a Koinos transaction can have several operations
// - deadlines are in milliseconds and mandatory (0 reverts, like Uniswap)
// - token amounts are u64: collect uses 2^64 - 1 instead of 2^128 - 1
// Not applicable: ETH / WETH9 (no native coin, KOIN is a token), payable functions, permit
// (EIP-712 signatures: Koinos uses the transaction signatures and the authority system), the
// SVG token URI (the metadata is on chain, KCS-5 metadata_of), gas and bytecode size.
const { completeFixture } = require("./shared/fixtures");
const { expectRevert } = require("./shared/contracts");
const { encodePriceSqrt, FeeAmount, TICK_SPACINGS, getMinTick, getMaxTick, MaxUint64, expandTo18Decimals } = require("./shared/utilities");
const { koinos } = require("@koinos/proto-js");
const { utils } = require("koilib");

const T = koinos.contracts.token;

/** token ids: 8 bytes, big endian */
const tokenIdBytes = (id) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(id));
  return b;
};

describe("NonfungiblePositionManager", () => {
  let fixture, vm, wallet, other, nft, router, tokens;

  beforeEach(() => {
    fixture = completeFixture();
    ({ vm, wallet, other, nft, router, tokens } = fixture);
    // fund the other wallet (Uniswap: 1M tokens of 18 decimals; Koinos tokens are u64)
    for (const token of tokens) token.transfer(wallet.address, other.address, expandTo18Decimals(1));
  });

  const createAndInitializePoolIfNecessary = (tokenA, tokenB, fee, sqrtPriceX96) => fixture.createPool(tokenA, tokenB, fee, sqrtPriceX96);

  function mint(params, from = wallet) {
    return nft.send(from, "mint", {
      from: from.address,
      recipient: params.recipient,
      token0: params.token0,
      token1: params.token1,
      fee: params.fee,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      amount0Desired: params.amount0Desired.toString(),
      amount1Desired: params.amount1Desired.toString(),
      amount0Min: (params.amount0Min ?? 0).toString(),
      amount1Min: (params.amount1Min ?? 0).toString(),
      deadline: (params.deadline ?? 9999999999999n).toString(),
    });
  }
  const increaseLiquidity = (params, from = wallet) =>
    nft.send(from, "increase_liquidity", {
      from: from.address,
      tokenId: tokenIdBytes(params.tokenId),
      amount0Desired: params.amount0Desired.toString(),
      amount1Desired: params.amount1Desired.toString(),
      amount0Min: (params.amount0Min ?? 0).toString(),
      amount1Min: (params.amount1Min ?? 0).toString(),
      deadline: (params.deadline ?? 9999999999999n).toString(),
    });
  const decreaseLiquidityArgs = (params, from) => ({
    from: from.address,
    tokenId: tokenIdBytes(params.tokenId),
    liquidity: params.liquidity.toString(),
    amount0Min: (params.amount0Min ?? 0).toString(),
    amount1Min: (params.amount1Min ?? 0).toString(),
    deadline: (params.deadline ?? 9999999999999n).toString(),
  });
  const decreaseLiquidity = (params, from = wallet) => nft.send(from, "decrease_liquidity", decreaseLiquidityArgs(params, from));
  const collectArgs = (params, from) => ({
    from: from.address,
    tokenId: tokenIdBytes(params.tokenId),
    recipient: params.recipient,
    amount0Max: params.amount0Max.toString(),
    amount1Max: params.amount1Max.toString(),
  });
  const collect = (params, from = wallet) => nft.send(from, "collect", collectArgs(params, from));
  const collectStatic = (params, from = wallet) => {
    const r = nft.callStatic(from, "collect", collectArgs(params, from));
    return { amount0: BigInt(r.amount0), amount1: BigInt(r.amount1) };
  };
  const burn = (tokenId, from = wallet) => nft.send(from, "burn", { tokenId: tokenIdBytes(tokenId), from: from.address });
  const positions = (tokenId) => {
    const p = nft.read("positions", { tokenId: tokenIdBytes(tokenId) });
    return {
      ...p,
      liquidity: BigInt(p.liquidity),
      tokensOwed0: BigInt(p.tokensOwed0),
      tokensOwed1: BigInt(p.tokensOwed1),
      feeGrowthInside0LastX128: BigInt(p.feeGrowthInside0LastX128),
      feeGrowthInside1LastX128: BigInt(p.feeGrowthInside1LastX128),
    };
  };
  const ownerOf = (tokenId) => nft.read("owner_of", { tokenId: tokenIdBytes(tokenId) }).value;
  const getApproved = (tokenId) => nft.read("get_approved", { tokenId: tokenIdBytes(tokenId) }).value;
  const approve = (to, tokenId, from) => nft.send(from, "approve", { approverAddress: from.address, to, tokenId: tokenIdBytes(tokenId) });
  const transferFrom = (fromAddress, to, tokenId, signer) => nft.send(signer, "transfer", { from: fromAddress, to, tokenId: tokenIdBytes(tokenId) });
  /** the NFT events have the names of the Koinos collections standard */
  const collectionEvents = (events, name) =>
    events.filter((e) => e.source === nft.address && e.name === `collections.${name}`).map((e) => nft.codec.decode(`manager.${name}`, e.data));
  const tokenTransfers = (events, token) =>
    events.filter((e) => e.source === token.address && e.name === "token.transfer_event").map((e) => {
      const d = T.transfer_event.decode(e.data);
      return { from: utils.encodeBase58(d.from), to: utils.encodeBase58(d.to), value: BigInt(d.value.toString()) };
    });

  const fullRange = { tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]) };
  const position = (recipient, amount) => ({
    token0: tokens[0].address,
    token1: tokens[1].address,
    fee: FeeAmount.MEDIUM,
    ...fullRange,
    recipient,
    amount0Desired: amount,
    amount1Desired: amount,
  });

  describe("#createAndInitializePoolIfNecessary", () => {
    it("creates the pool at the expected address", () => {
      // Koinos: the pool address is the account that uploads the pool, registered by the factory
      expect(fixture.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM)).toBeNull();
      const pool = createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      expect(fixture.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM).address).toEqual(pool.address);
      expect(pool.slot0().sqrtPriceX96).toEqual(encodePriceSqrt(1, 1));
    });

    it("works if pool is created but not initialized", () => {
      const pool = fixture.createPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM);
      expect(pool.slot0().sqrtPriceX96).toEqual(0n);
      const { result } = nft.send(wallet, "initialize_pool_if_necessary", {
        token0: tokens[0].address,
        token1: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        sqrtPriceX96: encodePriceSqrt(2, 1).toString(),
      });
      expect(result.value).toEqual(pool.address);
      expect(pool.slot0().sqrtPriceX96).toEqual(encodePriceSqrt(2, 1));
    });

    it("works if pool is created and initialized", () => {
      const pool = fixture.createPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM);
      pool.send(wallet, "initialize", { sqrtPriceX96: encodePriceSqrt(3, 1).toString() });
      nft.send(wallet, "initialize_pool_if_necessary", {
        token0: tokens[0].address,
        token1: tokens[1].address,
        fee: FeeAmount.MEDIUM,
        sqrtPriceX96: encodePriceSqrt(4, 1).toString(),
      });
      // the price is not changed
      expect(pool.slot0().sqrtPriceX96).toEqual(encodePriceSqrt(3, 1));
    });

    it("fails if the pool does not exist", () => {
      expectRevert(
        () =>
          nft.send(wallet, "initialize_pool_if_necessary", {
            token0: tokens[0].address,
            token1: tokens[1].address,
            fee: FeeAmount.MEDIUM,
            sqrtPriceX96: encodePriceSqrt(1, 1).toString(),
          }),
        "KOINDX: POOL_NOT_FOUND"
      );
    });
  });

  describe("#mint", () => {
    it("fails if pool does not exist", () => {
      expectRevert(() => mint(position(wallet.address, 100)), "KOINDX: POOL_NOT_FOUND");
    });

    it("fails if cannot transfer", () => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      // Uniswap: tokens[0].approve(nft.address, 0), the mint reverts with STF
      tokens[0].approve(wallet.address, nft.address, 0);
      expectRevert(() => mint(position(wallet.address, 100)), "account 'from' has not authorized transfer");
      // Koinos: the payer must also sign the transaction
      expectRevert(
        () =>
          nft.send(other, "mint", {
            ...position(wallet.address, 100),
            from: wallet.address,
            amount0Desired: "100",
            amount1Desired: "100",
            amount0Min: "0",
            amount1Min: "0",
            deadline: "9999999999999",
          }),
        "KOINDX: UNAUTHORIZED"
      );
      // and have the tokens
      const poor = vm.account("poor");
      fixture.approve(nft, [poor]);
      expectRevert(() => mint(position(wallet.address, 100), poor), "insufficient balance");
    });

    it("creates a token", () => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));

      mint({ ...position(other.address, 15), deadline: vm.time + 10n });
      expect(nft.read("balance_of", { owner: other.address }).value).toEqual("1");
      // tokenOfOwnerByIndex
      expect(nft.read("get_tokens_by_owner", { owner: other.address, limit: 1 }).values).toEqual([tokenIdBytes(1).toString("base64")]);
      const { fee, token0, token1, tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1, feeGrowthInside0LastX128, feeGrowthInside1LastX128 } = positions(1);
      expect(token0).toEqual(tokens[0].address);
      expect(token1).toEqual(tokens[1].address);
      expect(fee).toEqual(FeeAmount.MEDIUM);
      expect(tickLower).toEqual(getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]));
      expect(tickUpper).toEqual(getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]));
      expect(liquidity).toEqual(15n);
      expect(tokensOwed0).toEqual(0n);
      expect(tokensOwed1).toEqual(0n);
      expect(feeGrowthInside0LastX128).toEqual(0n);
      expect(feeGrowthInside1LastX128).toEqual(0n);
    });

    it("emits an event", () => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      const { events } = mint(position(other.address, 15));
      expect(collectionEvents(events, "mint_event")).toEqual([{ to: other.address, tokenId: tokenIdBytes(1).toString("base64") }]);
      expect(nft.events(events, "manager.increase_liquidity_event").map((e) => e.args)).toEqual([
        { tokenId: tokenIdBytes(1).toString("base64"), liquidity: "15", amount0: "15", amount1: "15" },
      ]);
    });

    it("fails if past deadline", () => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      expectRevert(() => mint({ ...position(other.address, 15), deadline: vm.time - 1n }), "KOINDX: TRANSACTION_TOO_OLD");
    });

    it("fails without a deadline (0), like Uniswap", () => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      expectRevert(() => mint({ ...position(other.address, 15), deadline: 0n }), "KOINDX: TRANSACTION_TOO_OLD");
    });
  });

  describe("#increaseLiquidity", () => {
    const tokenId = 1;
    beforeEach(() => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      mint(position(other.address, 1000));
    });

    it("increases position liquidity", () => {
      increaseLiquidity({ tokenId, amount0Desired: 100, amount1Desired: 100 });
      const { liquidity } = positions(tokenId);
      expect(liquidity).toEqual(1100n);
    });

    it("emits an event", () => {
      const { events } = increaseLiquidity({ tokenId, amount0Desired: 100, amount1Desired: 100 });
      expect(nft.events(events, "manager.increase_liquidity_event").map((e) => e.args)).toEqual([
        { tokenId: tokenIdBytes(tokenId).toString("base64"), liquidity: "100", amount0: "100", amount1: "100" },
      ]);
    });
  });

  describe("#decreaseLiquidity", () => {
    const tokenId = 1;
    beforeEach(() => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      mint(position(other.address, 100));
    });

    it("emits an event", () => {
      const { events } = decreaseLiquidity({ tokenId, liquidity: 25 }, other);
      expect(nft.events(events, "manager.decrease_liquidity_event").map((e) => e.args)).toEqual([
        { tokenId: tokenIdBytes(tokenId).toString("base64"), liquidity: "25", amount0: "24", amount1: "24" },
      ]);
    });

    it("fails if past deadline", () => {
      expectRevert(() => decreaseLiquidity({ tokenId, liquidity: 50, deadline: vm.time - 1n }, other), "KOINDX: TRANSACTION_TOO_OLD");
    });

    it("cannot be called by other addresses", () => {
      expectRevert(() => decreaseLiquidity({ tokenId, liquidity: 50 }), "KOINDX: NOT_APPROVED");
    });

    it("decreases position liquidity", () => {
      decreaseLiquidity({ tokenId, liquidity: 25 }, other);
      const { liquidity } = positions(tokenId);
      expect(liquidity).toEqual(75n);
    });

    it("accounts for tokens owed", () => {
      decreaseLiquidity({ tokenId, liquidity: 25 }, other);
      const { tokensOwed0, tokensOwed1 } = positions(tokenId);
      expect(tokensOwed0).toEqual(24n);
      expect(tokensOwed1).toEqual(24n);
    });

    it("can decrease for all the liquidity", () => {
      decreaseLiquidity({ tokenId, liquidity: 100 }, other);
      const { liquidity } = positions(tokenId);
      expect(liquidity).toEqual(0n);
    });

    it("cannot decrease for more than all the liquidity", () => {
      expectRevert(() => decreaseLiquidity({ tokenId, liquidity: 101 }, other), "KOINDX: INSUFFICIENT_LIQUIDITY");
    });

    it("cannot decrease for more than the liquidity of the nft position", () => {
      mint(position(other.address, 200));
      expectRevert(() => decreaseLiquidity({ tokenId, liquidity: 101 }, other), "KOINDX: INSUFFICIENT_LIQUIDITY");
    });

    it("can be called by the approved account", () => {
      approve(wallet.address, tokenId, other);
      decreaseLiquidity({ tokenId, liquidity: 25 }, wallet);
      expect(positions(tokenId).liquidity).toEqual(75n);
    });
  });

  describe("#collect", () => {
    const tokenId = 1;
    beforeEach(() => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      mint(position(other.address, 100));
    });

    it("emits an event", () => {
      decreaseLiquidity({ tokenId, liquidity: 50 }, other);
      const { events } = collect({ tokenId, recipient: wallet.address, amount0Max: MaxUint64, amount1Max: MaxUint64 }, other);
      expect(nft.events(events, "manager.collect_event").map((e) => e.args)).toEqual([
        { tokenId: tokenIdBytes(tokenId).toString("base64"), recipient: wallet.address, amount0: "49", amount1: "49" },
      ]);
    });

    it("cannot be called by other addresses", () => {
      expectRevert(() => collect({ tokenId, recipient: wallet.address, amount0Max: MaxUint64, amount1Max: MaxUint64 }), "KOINDX: NOT_APPROVED");
    });

    it("cannot be called with 0 for both amounts", () => {
      expectRevert(() => collect({ tokenId, recipient: wallet.address, amount0Max: 0, amount1Max: 0 }, other), "KOINDX: INVALID_AMOUNTS");
    });

    it("no op if no tokens are owed", () => {
      const { events } = collect({ tokenId, recipient: wallet.address, amount0Max: MaxUint64, amount1Max: MaxUint64 }, other);
      expect(tokenTransfers(events, tokens[0])).toEqual([]);
      expect(tokenTransfers(events, tokens[1])).toEqual([]);
    });

    it("transfers tokens owed from burn", () => {
      decreaseLiquidity({ tokenId, liquidity: 50 }, other);
      const poolAddress = fixture.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM).address;
      const { events } = collect({ tokenId, recipient: wallet.address, amount0Max: MaxUint64, amount1Max: MaxUint64 }, other);
      expect(tokenTransfers(events, tokens[0])).toEqual([{ from: poolAddress, to: wallet.address, value: 49n }]);
      expect(tokenTransfers(events, tokens[1])).toEqual([{ from: poolAddress, to: wallet.address, value: 49n }]);
    });
  });

  describe("#burn", () => {
    const tokenId = 1;
    beforeEach(() => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      mint(position(other.address, 100));
    });

    it("emits an event", () => {
      decreaseLiquidity({ tokenId, liquidity: 100 }, other);
      collect({ tokenId, recipient: wallet.address, amount0Max: MaxUint64, amount1Max: MaxUint64 }, other);
      const { events } = burn(tokenId, other);
      expect(collectionEvents(events, "burn_event")).toEqual([{ from: other.address, tokenId: tokenIdBytes(tokenId).toString("base64") }]);
    });

    it("cannot be called by other addresses", () => {
      expectRevert(() => burn(tokenId), "KOINDX: NOT_APPROVED");
    });

    it("cannot be called while there is still liquidity", () => {
      expectRevert(() => burn(tokenId, other), "KOINDX: NOT_CLEARED");
    });

    it("cannot be called while there is still partial liquidity", () => {
      decreaseLiquidity({ tokenId, liquidity: 50 }, other);
      expectRevert(() => burn(tokenId, other), "KOINDX: NOT_CLEARED");
    });

    it("cannot be called while there is still tokens owed", () => {
      decreaseLiquidity({ tokenId, liquidity: 100 }, other);
      expectRevert(() => burn(tokenId, other), "KOINDX: NOT_CLEARED");
    });

    it("deletes the token", () => {
      decreaseLiquidity({ tokenId, liquidity: 100 }, other);
      collect({ tokenId, recipient: wallet.address, amount0Max: MaxUint64, amount1Max: MaxUint64 }, other);
      burn(tokenId, other);
      expectRevert(() => positions(tokenId), "KOINDX: INVALID_TOKEN_ID");
    });
  });

  describe("#transferFrom", () => {
    const tokenId = 1;
    beforeEach(() => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      mint(position(other.address, 100));
    });

    it("can only be called by authorized or owner", () => {
      expectRevert(() => transferFrom(other.address, wallet.address, tokenId, wallet), "KOINDX: NOT_APPROVED");
    });

    it("changes the owner", () => {
      const { events } = transferFrom(other.address, wallet.address, tokenId, other);
      expect(ownerOf(tokenId)).toEqual(wallet.address);
      expect(collectionEvents(events, "transfer_event")).toEqual([{ from: other.address, to: wallet.address, tokenId: tokenIdBytes(tokenId).toString("base64") }]);
    });

    it("removes existing approval", () => {
      approve(wallet.address, tokenId, other);
      expect(getApproved(tokenId)).toEqual(wallet.address);
      // KCS-5: the approvals are for the calling contract (an approved account can't transfer
      // directly): the owner transfers
      transferFrom(other.address, wallet.address, tokenId, other);
      expect(getApproved(tokenId)).toEqual("");
    });

    it("can be called by an approved contract", () => {
      // a contract (e.g. a marketplace) approved by the owner transfers the position
      const { address: marketplace } = vm.account("marketplace");
      const { entryPoint } = require("../vm/koinos-vm");
      const transferEntry = nft.codec.method("transfer").entry_point;
      vm.deployNative(marketplace, (ctx, entry, args) => {
        if (entry === entryPoint("buy")) {
          const { to } = JSON.parse(Buffer.from(args).toString());
          ctx.call(nft.address, transferEntry, nft.encodeArgs("transfer", { from: other.address, to, tokenId: tokenIdBytes(tokenId) }));
          return;
        }
        ctx.revert("unknown entry point");
      });
      const buy = () =>
        vm.transaction({ signers: [wallet.address], operations: [{ call: { contractId: marketplace, entryPoint: entryPoint("buy"), args: Buffer.from(JSON.stringify({ to: wallet.address })) } }] });
      expectRevert(buy, "KOINDX: NOT_APPROVED");
      approve(marketplace, tokenId, other);
      buy();
      expect(ownerOf(tokenId)).toEqual(wallet.address);
      expect(getApproved(tokenId)).toEqual("");
    });
  });

  describe("multicall exit", () => {
    const tokenId = 1;
    beforeEach(() => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      mint(position(other.address, 100));
    });

    /** Koinos: decrease_liquidity, collect and burn in the operations of one transaction */
    function exit({ liquidity, tokenId, amount0Min, amount1Min, recipient, from }) {
      return vm.transaction({
        signers: [from.address],
        operations: [
          nft.operation("decrease_liquidity", decreaseLiquidityArgs({ tokenId, liquidity, amount0Min, amount1Min }, from)),
          nft.operation("collect", collectArgs({ tokenId, recipient, amount0Max: MaxUint64, amount1Max: MaxUint64 }, from)),
          nft.operation("burn", { tokenId: tokenIdBytes(tokenId), from: from.address }),
        ],
      });
    }

    it("executes all the actions", () => {
      const pool = fixture.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM);
      const { events } = exit({ tokenId, liquidity: 100, amount0Min: 0, amount1Min: 0, recipient: wallet.address, from: other });
      expect(pool.events(events, "pool.burn_event").length).toEqual(1);
      expect(pool.events(events, "pool.collect_event").length).toEqual(1);
      expectRevert(() => positions(tokenId), "KOINDX: INVALID_TOKEN_ID");
    });
  });

  describe("#tokenURI", () => {
    const tokenId = 1;
    beforeEach(() => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      mint(position(other.address, 100));
    });

    // KCS-5: the metadata is on chain (metadata_of)
    it("reverts for invalid token id", () => {
      expectRevert(() => nft.read("metadata_of", { tokenId: tokenIdBytes(tokenId + 1) }), "KOINDX: INVALID_TOKEN_ID");
    });

    it("content is valid JSON and structure", () => {
      const content = JSON.parse(nft.read("metadata_of", { tokenId: tokenIdBytes(tokenId) }).value);
      expect(typeof content.name).toEqual("string");
      expect(typeof content.description).toEqual("string");
      expect(content.attributes).toEqual([
        { trait_type: "token0", value: tokens[0].address },
        { trait_type: "token1", value: tokens[1].address },
        { trait_type: "fee", value: FeeAmount.MEDIUM },
        { trait_type: "tick_lower", value: fullRange.tickLower },
        { trait_type: "tick_upper", value: fullRange.tickUpper },
        { trait_type: "liquidity", value: "100" },
      ]);
    });
  });

  describe("fees accounting", () => {
    beforeEach(() => {
      createAndInitializePoolIfNecessary(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
      // nft 1 earns 25% of fees
      mint({ ...position(wallet.address, 100), tickLower: getMinTick(FeeAmount.MEDIUM), tickUpper: getMaxTick(FeeAmount.MEDIUM) });
      // nft 2 earns 75% of fees
      mint({ ...position(wallet.address, 300), tickLower: getMinTick(FeeAmount.MEDIUM), tickUpper: getMaxTick(FeeAmount.MEDIUM) });
    });

    describe("10k of token0 fees collect", () => {
      beforeEach(() => {
        const swapAmount = 3_333_333;
        router.send(wallet, "exact_input", {
          from: wallet.address,
          recipient: wallet.address,
          tokens: [tokens[0].address, tokens[1].address],
          fees: [FeeAmount.MEDIUM],
          amountIn: swapAmount.toString(),
          amountOutMinimum: "0",
          deadline: "9999999999999",
        });
      });

      it("expected amounts", () => {
        const { amount0: nft1Amount0, amount1: nft1Amount1 } = collectStatic({ tokenId: 1, recipient: wallet.address, amount0Max: MaxUint64, amount1Max: MaxUint64 });
        const { amount0: nft2Amount0, amount1: nft2Amount1 } = collectStatic({ tokenId: 2, recipient: wallet.address, amount0Max: MaxUint64, amount1Max: MaxUint64 });
        expect(nft1Amount0).toEqual(2501n);
        expect(nft1Amount1).toEqual(0n);
        expect(nft2Amount0).toEqual(7503n);
        expect(nft2Amount1).toEqual(0n);
      });

      it("actually collected", () => {
        const poolAddress = fixture.getPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM).address;
        let { events } = collect({ tokenId: 1, recipient: wallet.address, amount0Max: MaxUint64, amount1Max: MaxUint64 });
        expect(tokenTransfers(events, tokens[0])).toEqual([{ from: poolAddress, to: wallet.address, value: 2501n }]);
        expect(tokenTransfers(events, tokens[1])).toEqual([]);
        ({ events } = collect({ tokenId: 2, recipient: wallet.address, amount0Max: MaxUint64, amount1Max: MaxUint64 }));
        expect(tokenTransfers(events, tokens[0])).toEqual([{ from: poolAddress, to: wallet.address, value: 7503n }]);
        expect(tokenTransfers(events, tokens[1])).toEqual([]);
      });
    });
  });
});
