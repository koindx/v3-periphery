// Port of Uniswap v3-periphery test/CallbackValidation.spec.ts: the callbacks of the router and
// the position manager revert when they are not called by the KoinDX pool of the tokens and fee
// of the callback data.
const { completeFixture } = require("./shared/fixtures");
const { expectRevert } = require("./shared/contracts");
const { encodePriceSqrt, FeeAmount } = require("./shared/utilities");

describe("CallbackValidation", () => {
  let fixture, vm, wallet, router, nft, tokens;
  beforeEach(() => {
    fixture = completeFixture();
    ({ vm, wallet, router, nft, tokens } = fixture);
    fixture.createPool(tokens[0].address, tokens[1].address, FeeAmount.MEDIUM, encodePriceSqrt(1, 1));
  });

  /** a contract (not the pool) that calls a callback */
  function fakePool(target, method, args) {
    const { address } = vm.account("not the pool");
    const entry = target.codec.method(method).entry_point;
    vm.deployNative(address, (ctx) => ctx.call(target.address, entry, target.encodeArgs(method, args)));
    return () => vm.transaction({ signers: [wallet.address], operations: [{ call: { contractId: address, entryPoint: 1, args: new Uint8Array(0) } }] });
  }

  it("reverts when called from an address other than the associated pool (swap callback)", () => {
    const data = router.codec.encode("router.swap_callback_data", { pathTokens: [tokens[0].address, tokens[1].address], pathFees: [FeeAmount.MEDIUM], payer: wallet.address });
    const call = fakePool(router, "koindx_v3_swap_callback", { zeroForOne: true, amountIn: "1000", amountOut: "1000", data });
    expectRevert(call, "KOINDX: INVALID_CALLBACK_CALLER");
    // and from an account
    expectRevert(() => router.send(wallet, "koindx_v3_swap_callback", { zeroForOne: true, amountIn: "1000", amountOut: "1000", data }), "KOINDX: INVALID_CALLBACK_CALLER");
  });

  it("reverts when called from an address other than the associated pool (mint callback)", () => {
    const data = nft.codec.encode("manager.mint_callback_data", { poolKey: { token0: tokens[0].address, token1: tokens[1].address, fee: FeeAmount.MEDIUM }, payer: wallet.address });
    const call = fakePool(nft, "koindx_v3_mint_callback", { amount0Owed: "1000", amount1Owed: "1000", data });
    expectRevert(call, "KOINDX: INVALID_CALLBACK_CALLER");
    expectRevert(() => nft.send(wallet, "koindx_v3_mint_callback", { amount0Owed: "1000", amount1Owed: "1000", data }), "KOINDX: INVALID_CALLBACK_CALLER");
  });
});
