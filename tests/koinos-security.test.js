// Attacks that are specific to Koinos on the periphery (the Uniswap tests don't cover them): the
// payer `from` of the operations (with KCS-4 tokens the users give allowances to the router and
// the manager, nobody else can spend them), the keys of the periphery contracts, the custody of
// the router, malformed addresses and token identifiers.
const { utils } = require("koilib");
const { koinos } = require("@koinos/proto-js");
const { addressBytes, b58, AUTHORIZE_ENTRY_POINT } = require("./vm/koinos-vm");
const { completeFixture } = require("./uniswap/shared/fixtures");
const { expectRevert } = require("./uniswap/shared/contracts");
const { encodePriceSqrt, FeeAmount, TICK_SPACINGS, getMinTick, getMaxTick, MaxUint64 } = require("./uniswap/shared/utilities");

const FEE = FeeAmount.MEDIUM;
const tokenIdBytes = (id) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(id));
  return b;
};

describe("Koinos security: periphery", () => {
  // wallet: a user that approved the router and the manager (max u64), other: an attacker
  let fixture, vm, wallet, other, router, nft, tokens;

  const fullRange = (from, a, b, amount, recipient = from.address) => ({
    from: from.address,
    recipient,
    token0: tokens[a].address,
    token1: tokens[b].address,
    fee: FEE,
    tickLower: getMinTick(TICK_SPACINGS[FEE]),
    tickUpper: getMaxTick(TICK_SPACINGS[FEE]),
    amount0Desired: amount.toString(),
    amount1Desired: amount.toString(),
    amount0Min: "0",
    amount1Min: "0",
    deadline: "9999999999999",
  });
  const swapArgs = (from, recipient, overrides = {}) => ({
    from: from.address,
    recipient,
    tokenIn: tokens[0].address,
    tokenOut: tokens[1].address,
    fee: FEE,
    amountIn: "1000",
    amountOutMinimum: "0",
    sqrtPriceLimitX96: "",
    deadline: "9999999999999",
    ...overrides,
  });
  const path = { tokens: [], fees: [FEE, FEE] };

  beforeEach(() => {
    fixture = completeFixture();
    ({ vm, wallet, other, router, nft, tokens } = fixture);
    for (const [a, b] of [
      [0, 1],
      [1, 2],
    ]) {
      fixture.createPool(tokens[a].address, tokens[b].address, FEE, encodePriceSqrt(1, 1));
      nft.send(wallet, "mint", fullRange(wallet, a, b, 10n ** 12n));
    }
    path.tokens = tokens.map((t) => t.address);
  });

  /** a contract of the attacker that calls `method` of `target` with `args` */
  function attackerContract(target, method, args) {
    const { address } = vm.account(`attacker ${method}`);
    vm.deployNative(address, (ctx) => ctx.call(target.address, target.codec.method(method).entry_point, target.encodeArgs(method, args)));
    return () => vm.transaction({ signers: [other.address], operations: [{ call: { contractId: address, entryPoint: 1, args: new Uint8Array(0) } }] });
  }

  it("nobody can spend the allowance an account gave to the router", () => {
    const balances = tokens.map((t) => t.balanceOf(wallet.address));
    const allowance = tokens[0].allowance(wallet.address, router.address);
    for (const [method, args] of [
      ["exact_input_single", swapArgs(wallet, other.address)],
      ["exact_output_single", { ...swapArgs(wallet, other.address), amountIn: undefined, amountOut: "1000", amountInMaximum: "2000" }],
      ["exact_input", { from: wallet.address, recipient: other.address, ...path, amountIn: "1000", amountOutMinimum: "0", deadline: "9999999999999" }],
      ["exact_output", { from: wallet.address, recipient: other.address, ...path, amountOut: "1000", amountInMaximum: "3000", deadline: "9999999999999" }],
    ]) {
      // a transaction of the attacker
      expectRevert(() => router.send(other, method, args), "KOINDX: UNAUTHORIZED");
      // a contract of the attacker
      expectRevert(attackerContract(router, method, args), "KOINDX: CALLER_IS_UNAUTHORIZED");
    }
    expect(tokens.map((t) => t.balanceOf(wallet.address))).toEqual(balances);
    expect(tokens[0].allowance(wallet.address, router.address)).toEqual(allowance);
  });

  it("nobody can spend the allowance an account gave to the manager", () => {
    const balances = tokens.map((t) => t.balanceOf(wallet.address));
    const mint = fullRange(wallet, 0, 1, 1000, other.address);
    expectRevert(() => nft.send(other, "mint", mint), "KOINDX: UNAUTHORIZED");
    expectRevert(attackerContract(nft, "mint", mint), "KOINDX: CALLER_IS_UNAUTHORIZED");
    const increase = { from: wallet.address, tokenId: tokenIdBytes(1), amount0Desired: "1000", amount1Desired: "1000", amount0Min: "0", amount1Min: "0", deadline: "9999999999999" };
    expectRevert(() => nft.send(other, "increase_liquidity", increase), "KOINDX: UNAUTHORIZED");
    expectRevert(attackerContract(nft, "increase_liquidity", increase), "KOINDX: CALLER_IS_UNAUTHORIZED");
    expect(tokens.map((t) => t.balanceOf(wallet.address))).toEqual(balances);
  });

  it("nobody can act on the positions of others", () => {
    const tokenId = tokenIdBytes(1);
    const decrease = { tokenId, liquidity: "1", amount0Min: "0", amount1Min: "0", deadline: "9999999999999" };
    const collect = { tokenId, recipient: other.address, amount0Max: MaxUint64.toString(), amount1Max: MaxUint64.toString() };
    // the attacker as `from`
    expectRevert(() => nft.send(other, "decrease_liquidity", { ...decrease, from: other.address }), "KOINDX: NOT_APPROVED");
    expectRevert(() => nft.send(other, "collect", { ...collect, from: other.address }), "KOINDX: NOT_APPROVED");
    expectRevert(() => nft.send(other, "burn", { tokenId, from: other.address }), "KOINDX: NOT_APPROVED");
    expectRevert(() => nft.send(other, "transfer", { from: wallet.address, to: other.address, tokenId }), "KOINDX: NOT_APPROVED");
    // the owner as `from`, without its signature
    expectRevert(() => nft.send(other, "decrease_liquidity", { ...decrease, from: wallet.address }), "KOINDX: UNAUTHORIZED");
    expectRevert(() => nft.send(other, "collect", { ...collect, from: wallet.address }), "KOINDX: UNAUTHORIZED");
    // a contract of the attacker
    expectRevert(attackerContract(nft, "collect", { ...collect, from: wallet.address }), "KOINDX: CALLER_IS_UNAUTHORIZED");
    expectRevert(attackerContract(nft, "transfer", { from: wallet.address, to: other.address, tokenId }), "KOINDX: NOT_APPROVED");
    expect(nft.read("owner_of", { tokenId }).value).toEqual(wallet.address);
  });

  it("the keys of the manager and the router can't act for them", () => {
    // the manager owns the liquidity of every position in the pools
    const pool = fixture.getPool(tokens[0].address, tokens[1].address, FEE);
    const [tickLower, tickUpper] = [getMinTick(TICK_SPACINGS[FEE]), getMaxTick(TICK_SPACINGS[FEE])];
    const managerKey = { address: nft.address };
    expectRevert(() => pool.send(managerKey, "burn", { tickLower, tickUpper, amount: "1", owner: nft.address }), "KOINDX: UNAUTHORIZED");
    expectRevert(
      () =>
        pool.send(managerKey, "collect", {
          recipient: other.address,
          tickLower,
          tickUpper,
          amount0Requested: MaxUint64.toString(),
          amount1Requested: MaxUint64.toString(),
          owner: nft.address,
        }),
      "KOINDX: UNAUTHORIZED"
    );
    // nor use them as the payer
    expectRevert(() => nft.send(managerKey, "mint", fullRange({ address: nft.address }, 0, 1, 1000, other.address)), "KOINDX: UNAUTHORIZED");
    expectRevert(() => router.send({ address: router.address }, "exact_input_single", swapArgs({ address: router.address }, other.address)), "KOINDX: UNAUTHORIZED");
    // nor move their tokens
    tokens[0].transfer(wallet.address, router.address, 1000);
    expectRevert(() => tokens[0].transfer(router.address, other.address, 1000), "account 'from' has not authorized transfer");
  });

  it("a smart wallet sees the arguments of the operation it authorizes", () => {
    // a contract account (smart wallet) with a policy: the router can only send the output of a
    // swap to the wallet itself
    const smartWallet = vm.account("policy wallet");
    const seen = [];
    vm.deployNative(
      smartWallet.address,
      (ctx, entry, args) => {
        if (entry !== AUTHORIZE_ENTRY_POINT) ctx.revert("unknown entry point");
        const { call } = koinos.chain.authorize_arguments.decode(args);
        let authorized = true;
        if (b58(call.contract_id) === router.address) {
          const method = Object.keys(router.codec.abi.methods).find((m) => router.codec.method(m).entry_point === call.entry_point);
          seen.push(method);
          authorized = router.codec.decode(router.codec.method(method).argument, call.data).recipient === smartWallet.address;
        }
        return koinos.chain.authorize_result.encode({ value: authorized }).finish();
      },
      { authorizesCallContract: true }
    );
    tokens[0].transfer(wallet.address, smartWallet.address, 10000);
    router.send([], "exact_input_single", swapArgs(smartWallet, smartWallet.address));
    expectRevert(() => router.send([], "exact_input_single", swapArgs(smartWallet, other.address)), "KOINDX: UNAUTHORIZED");
    expect(seen).toEqual(["exact_input_single", "exact_input_single"]);
    expect(tokens[1].balanceOf(smartWallet.address) > 0n).toBe(true);
  });

  it("the router keeps no tokens after a swap", () => {
    vm.transaction({
      signers: [wallet],
      operations: [
        router.operation("exact_input", { from: wallet.address, recipient: wallet.address, ...path, amountIn: "100000", amountOutMinimum: "0", deadline: "9999999999999" }),
        router.operation("exact_output", { from: wallet.address, recipient: wallet.address, ...path, amountOut: "100000", amountInMaximum: "200000", deadline: "9999999999999" }),
        router.operation("exact_input_single", swapArgs(wallet, wallet.address)),
      ],
    });
    expect(tokens.map((t) => t.balanceOf(router.address))).toEqual([0n, 0n, 0n]);
    expect(tokens.map((t) => t.balanceOf(nft.address))).toEqual([0n, 0n, 0n]);
  });

  it("rejects malformed recipient addresses (bytes of any length are valid in the ABI)", () => {
    const shortAddress = utils.encodeBase58(addressBytes(other.address).subarray(0, 24));
    expectRevert(() => router.send(wallet, "exact_input_single", swapArgs(wallet, shortAddress)), "KOINDX: INVALID_RECIPIENT");
    expectRevert(
      () => router.send(wallet, "exact_input", { from: wallet.address, recipient: shortAddress, ...path, amountIn: "1000", amountOutMinimum: "0", deadline: "9999999999999" }),
      "KOINDX: INVALID_RECIPIENT"
    );
    expectRevert(() => nft.send(wallet, "mint", fullRange(wallet, 0, 1, 1000, shortAddress)), "KOINDX: INVALID_RECIPIENT");
    expectRevert(
      () => nft.send(wallet, "collect", { from: wallet.address, tokenId: tokenIdBytes(1), recipient: shortAddress, amount0Max: "1", amount1Max: "1" }),
      "KOINDX: INVALID_RECIPIENT"
    );
  });

  it("the router can't be the recipient of a swap (it keeps no tokens, they couldn't be recovered)", () => {
    expectRevert(() => router.send(wallet, "exact_input_single", swapArgs(wallet, router.address)), "KOINDX: INVALID_RECIPIENT");
    expectRevert(
      () => router.send(wallet, "exact_output", { from: wallet.address, recipient: router.address, ...path, amountOut: "1000", amountInMaximum: "3000", deadline: "9999999999999" }),
      "KOINDX: INVALID_RECIPIENT"
    );
  });

  it("only the canonical token identifiers find a pool", () => {
    for (const variant of [tokens[0].address + " ", " " + tokens[0].address, "1" + tokens[0].address]) {
      expectRevert(() => router.send(wallet, "exact_input_single", swapArgs(wallet, wallet.address, { tokenIn: variant })), "KOINDX: POOL_NOT_FOUND");
      expectRevert(() => fixture.createPool(variant, tokens[2].address, FEE, encodePriceSqrt(1, 1)), "KOINDX: INVALID_TOKEN");
    }
  });
});

describe("Koinos security: code that runs during an authority check", () => {
  // The authority check of a smart wallet (a contract account) runs its `authorize`, which can call
  // the manager: the manager must not use what it read before (Uniswap: storage pointers)
  let fixture, vm, wallet, other, nft, tokens, smartWallet, escrow, hooks;
  const [tickLower, tickUpper] = [getMinTick(TICK_SPACINGS[FEE]), getMaxTick(TICK_SPACINGS[FEE])];
  const mintArgs = (recipient, amount = 10n ** 6n) => ({
    from: wallet.address,
    recipient,
    token0: tokens[0].address,
    token1: tokens[1].address,
    fee: FEE,
    tickLower,
    tickUpper,
    amount0Desired: amount.toString(),
    amount1Desired: amount.toString(),
    amount0Min: "0",
    amount1Min: "0",
    deadline: "9999999999999",
  });
  const callManager = (ctx, method, args) => ctx.call(nft.address, nft.codec.method(method).entry_point, nft.encodeArgs(method, args));
  const ownerOf = (id) => nft.read("owner_of", { tokenId: tokenIdBytes(id) }).value || "";
  const tokensOf = (owner) => (nft.read("get_tokens_by_owner", { owner }).values || []).map((v) => Buffer.from(v, "base64").readBigUInt64BE(0));

  beforeEach(() => {
    fixture = completeFixture();
    ({ vm, wallet, other, nft, tokens } = fixture);
    fixture.createPool(tokens[0].address, tokens[1].address, FEE, encodePriceSqrt(1, 1));
    // a smart wallet that runs the hook of the contract it authorizes (once)
    smartWallet = vm.account("smart wallet").address;
    escrow = vm.account("escrow contract").address;
    hooks = {};
    vm.deployNative(
      smartWallet,
      (ctx, entry, args) => {
        if (entry !== AUTHORIZE_ENTRY_POINT) ctx.revert("unknown entry point");
        const contract = b58(koinos.chain.authorize_arguments.decode(args).call.contract_id);
        const hook = hooks[contract];
        delete hooks[contract];
        if (hook) hook(ctx);
        return koinos.chain.authorize_result.encode({ value: true }).finish();
      },
      { authorizesCallContract: true }
    );
    nft.send(wallet, "mint", mintArgs(smartWallet)); // #1
    nft.send(wallet, "mint", mintArgs(smartWallet)); // #2
  });

  const transferTo = (to) => (ctx) => callManager(ctx, "transfer", { from: smartWallet, to, tokenId: tokenIdBytes(1) });

  it("transfer: the token must still belong to the owner after its authorization", () => {
    hooks[nft.address] = transferTo(escrow);
    expectRevert(() => nft.send([], "transfer", { from: smartWallet, to: other.address, tokenId: tokenIdBytes(1) }), "KOINDX: FROM_IS_NOT_OWNER");
    expect(ownerOf(1)).toEqual(smartWallet);
    expect(tokensOf(smartWallet)).toEqual([1n, 2n]);
  });

  it("approve: only the owner after the authorization can approve", () => {
    hooks[nft.address] = transferTo(escrow);
    expectRevert(() => nft.send([], "approve", { approverAddress: smartWallet, to: other.address, tokenId: tokenIdBytes(1) }), "KOINDX: NOT_APPROVED");
    expect(nft.read("get_approved", { tokenId: tokenIdBytes(1) }).value || "").toEqual("");
    const shortAddress = utils.encodeBase58(addressBytes(other.address).subarray(0, 24));
    expectRevert(() => nft.send([], "approve", { approverAddress: smartWallet, to: shortAddress, tokenId: tokenIdBytes(1) }), "KOINDX: INVALID_APPROVED");
  });

  it("increase_liquidity: the position is read again after the payment", () => {
    // empty #2 so that it can be burned during the payment (the payer pays without allowance, so
    // the tokens check its authority)
    const liquidity = nft.read("positions", { tokenId: tokenIdBytes(2) }).liquidity;
    nft.send([], "decrease_liquidity", { from: smartWallet, tokenId: tokenIdBytes(2), liquidity, amount0Min: "0", amount1Min: "0", deadline: "9999999999999" });
    nft.send([], "collect", { from: smartWallet, tokenId: tokenIdBytes(2), recipient: smartWallet, amount0Max: MaxUint64.toString(), amount1Max: MaxUint64.toString() });
    hooks[tokens[0].address] = (ctx) => callManager(ctx, "burn", { from: smartWallet, tokenId: tokenIdBytes(2) });
    expectRevert(
      () =>
        nft.send([], "increase_liquidity", { from: smartWallet, tokenId: tokenIdBytes(2), amount0Desired: "1000", amount1Desired: "1000", amount0Min: "0", amount1Min: "0", deadline: "9999999999999" }),
      "KOINDX: INVALID_TOKEN_ID"
    );
    expect(ownerOf(2)).toEqual(smartWallet);
  });
});
