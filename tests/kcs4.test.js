// The router and the position manager with tokens of the Koinos token standard (KCS-4), as
// implemented by the KOIN contract (koinos-contracts-as, contracts/koin/assembly/Koin.ts) and
// emulated by tests/vm/token.js: a contract can only move the tokens of an account up to the
// allowance the account gave it (`approve`), or the tokens of a smart wallet that authorizes it.
// Like Uniswap's ERC-20 approvals, the account approves the router / manager, which can be done in
// the same transaction as the swap or the mint.
const { koinos } = require("@koinos/proto-js");
const { AUTHORIZE_ENTRY_POINT } = require("./vm/koinos-vm");
const { completeFixture } = require("./uniswap/shared/fixtures");
const { expectRevert } = require("./uniswap/shared/contracts");
const { encodePriceSqrt, FeeAmount, TICK_SPACINGS, getMinTick, getMaxTick } = require("./uniswap/shared/utilities");

const FEE = FeeAmount.MEDIUM;
const NOT_AUTHORIZED = "account 'from' has not authorized transfer";

describe("Koinos token standard (KCS-4): allowances of the router and the position manager", () => {
  let fixture, vm, wallet, router, nft, tokens, trader;

  const fullRange = (from, a, b, amount) => ({
    from: from.address,
    recipient: from.address,
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

  beforeEach(() => {
    fixture = completeFixture();
    ({ vm, wallet, router, nft, tokens } = fixture);
    for (const [a, b] of [
      [0, 1],
      [1, 2],
    ]) {
      fixture.createPool(tokens[a].address, tokens[b].address, FEE, encodePriceSqrt(1, 1));
      nft.send(wallet, "mint", fullRange(wallet, a, b, 10n ** 12n));
    }
    // an account with tokens and no allowance
    trader = vm.account("trader");
    for (const token of tokens) token.transfer(wallet.address, trader.address, 10n ** 9n);
  });

  const exactInputSingle = (amountIn, from = trader) => ({
    from: from.address,
    recipient: from.address,
    tokenIn: tokens[0].address,
    tokenOut: tokens[1].address,
    fee: FEE,
    amountIn: amountIn.toString(),
    amountOutMinimum: "0",
    sqrtPriceLimitX96: "",
    deadline: "9999999999999",
  });
  const approve = (token, spender, value) => token.approveOperation(trader.address, spender.address, value);

  describe("router", () => {
    it("can't move the tokens of an account without an allowance", () => {
      expectRevert(() => router.send(trader, "exact_input_single", exactInputSingle(1000)), NOT_AUTHORIZED);
    });

    it("swaps with an allowance given in the same transaction, which is used exactly", () => {
      const before = [tokens[0].balanceOf(trader.address), tokens[1].balanceOf(trader.address)];
      const { results } = vm.transaction({
        signers: [trader],
        operations: [approve(tokens[0], router, 1000), router.operation("exact_input_single", exactInputSingle(1000))],
      });
      const { amountOut } = router.decodeResult("exact_input_single", results[1]);
      expect(tokens[0].balanceOf(trader.address)).toEqual(before[0] - 1000n);
      expect(tokens[1].balanceOf(trader.address)).toEqual(before[1] + BigInt(amountOut));
      expect(tokens[0].allowance(trader.address, router.address)).toEqual(0n);
    });

    it("fails when the allowance is smaller than the amount", () => {
      tokens[0].approve(trader.address, router.address, 999);
      expectRevert(() => router.send(trader, "exact_input_single", exactInputSingle(1000)), NOT_AUTHORIZED);
      expect(tokens[0].allowance(trader.address, router.address)).toEqual(999n);
    });

    it("exact output: the part of the allowance that is not used stays", () => {
      const { results } = vm.transaction({
        signers: [trader],
        operations: [
          approve(tokens[0], router, 2000),
          router.operation("exact_output_single", {
            from: trader.address,
            recipient: trader.address,
            tokenIn: tokens[0].address,
            tokenOut: tokens[1].address,
            fee: FEE,
            amountOut: "1000",
            amountInMaximum: "2000",
            sqrtPriceLimitX96: "",
            deadline: "9999999999999",
          }),
        ],
      });
      const amountIn = BigInt(router.decodeResult("exact_output_single", results[1]).amountIn);
      expect(amountIn > 1000n).toBe(true);
      expect(tokens[0].allowance(trader.address, router.address)).toEqual(2000n - amountIn);
    });

    it("multi hop: only the input token needs an allowance (the router pays the next pools)", () => {
      const path = { tokens: tokens.map((t) => t.address), fees: [FEE, FEE] };
      const before = tokens.map((t) => t.balanceOf(trader.address));
      vm.transaction({
        signers: [trader],
        operations: [
          approve(tokens[0], router, 3000),
          router.operation("exact_input", { from: trader.address, recipient: trader.address, ...path, amountIn: "1000", amountOutMinimum: "0", deadline: "9999999999999" }),
          router.operation("exact_output", { from: trader.address, recipient: trader.address, ...path, amountOut: "1000", amountInMaximum: "2000", deadline: "9999999999999" }),
        ],
      });
      const after = tokens.map((t) => t.balanceOf(trader.address));
      expect(after[1]).toEqual(before[1]);
      expect(after[2] > before[2]).toBe(true);
      expect(tokens[0].allowance(trader.address, router.address)).toEqual(3000n - (before[0] - after[0]));
      expect(tokens[1].allowance(trader.address, router.address)).toEqual(0n);
    });
  });

  describe("position manager", () => {
    it("can't move the tokens of an account without an allowance of both tokens", () => {
      expectRevert(() => nft.send(trader, "mint", fullRange(trader, 0, 1, 1000)), NOT_AUTHORIZED);
      tokens[0].approve(trader.address, nft.address, 1000);
      expectRevert(() => nft.send(trader, "mint", fullRange(trader, 0, 1, 1000)), NOT_AUTHORIZED);
    });

    it("mints with the allowances given in the same transaction", () => {
      const { results } = vm.transaction({
        signers: [trader],
        operations: [approve(tokens[0], nft, 1000), approve(tokens[1], nft, 1000), nft.operation("mint", fullRange(trader, 0, 1, 1000))],
      });
      const { amount0, amount1 } = nft.decodeResult("mint", results[2]);
      expect(tokens[0].allowance(trader.address, nft.address)).toEqual(1000n - BigInt(amount0));
      expect(tokens[1].allowance(trader.address, nft.address)).toEqual(1000n - BigInt(amount1));
    });
  });

  it("a smart wallet that authorizes the call pays without an allowance", () => {
    // a contract account overriding its contract call authority (System.checkAccountAuthority
    // calls its `authorize` entry point), which authorizes everything
    const smartWallet = vm.account("smart wallet");
    vm.deployNative(
      smartWallet.address,
      (ctx, entry) => {
        if (entry === AUTHORIZE_ENTRY_POINT) return koinos.chain.authorize_result.encode({ value: true }).finish();
        ctx.revert("unknown entry point");
      },
      { authorizesCallContract: true }
    );
    tokens[0].transfer(wallet.address, smartWallet.address, 1000);
    router.send([], "exact_input_single", exactInputSingle(1000, smartWallet));
    expect(tokens[0].balanceOf(smartWallet.address)).toEqual(0n);
    expect(tokens[1].balanceOf(smartWallet.address) > 0n).toBe(true);
  });
});
