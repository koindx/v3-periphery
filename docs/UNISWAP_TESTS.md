# Uniswap v3-periphery tests on KoinDX

The test files of [Uniswap v3-periphery](https://github.com/Uniswap/v3-periphery/tree/main/test)
that apply to the KoinDX periphery are ported to `tests/uniswap` and run against the compiled
contracts (local network build) and the v3-core factory and pools (`tests/core`, synced from
v3-core by `scripts/sync-core.js`), in the Koinos VM emulator (`tests/vm`, shared with v3-core).
See also [the v3-core tests](https://github.com/koindx/v3-core/blob/main/docs/UNISWAP_TESTS.md).

## Coverage

| Uniswap test | KoinDX test | Tests | Notes |
|---|---|---|---|
| `NonfungiblePositionManager.spec.ts` | `NonfungiblePositionManager.test.js` | 41 | the fees accounting gives the Uniswap amounts |
| `SwapRouter.spec.ts` | `SwapRouter.test.js` | 19 | the router keeps a balance only when an intermediate hop is partly filled, swept with `sweep_token` |
| `QuoterV2.spec.ts` | `QuoterV2.test.js` | 25 | amounts, prices after and initialized ticks crossed equal to Uniswap. The ticks crossed are the ones the swap crosses: QuoterV2's `PoolTicksCounter` also counts, for a swap that starts at a negative tick that is not a multiple of the spacing, an initialized tick at the next multiple toward zero that the swap doesn't cross (Uniswap only uses it to estimate gas) |
| `Quoter.spec.ts` | `Quoter.test.js` | 12 | the KoinDX quoter is QuoterV2 |
| `TickLens.spec.ts` | `TickLens.test.js` | 3 | through `get_populated_ticks` of the pool |
| `LiquidityAmounts.spec.ts` | `libraries/LiquidityAmounts.test.js` | 10 | |
| `Path.spec.ts` | `libraries/Path.test.js` | 4 | paths are lists of tokens and fees |
| `PoolAddress.spec.ts` | `PoolAddress.test.js` | 3 | the pools are found through the factory (no CREATE2) |
| `CallbackValidation.spec.ts` | `CallbackValidation.test.js` | 2 | router and manager callbacks |
| `PeripheryImmutableState.spec.ts` | `PeripheryImmutableState.test.js` | 1 | |
| — | `differential/Periphery.fuzz.test.js` | 3 | random operations on KoinDX and on the Uniswap reference, compared after every operation (see below) |
| — | `differential/QuoterEdges.test.js` | 2 | the quoter against the QuoterV2 bytecode in the cases the ported tests don't reach: a swap without liquidity reverts like QuoterV2 (finding F13), and the documented difference of the initialized ticks crossed |
| — | `koinos-security.test.js` | 12 | attacks specific to Koinos (allowances given to the router and the manager, keys of the contracts, smart wallets and code that runs during their authorization, malformed addresses and token identifiers), see [SECURITY.md](https://github.com/koindx/v3-core/blob/main/SECURITY.md) |
| `PoolTicksCounter.spec.ts` | — | — | KoinDX counts the initialized ticks crossed in the swap loop of the pool: checked by the QuoterV2 tests |
| `OracleLibrary.spec.ts`, `PositionValue.spec.ts` | — | — | libraries for other contracts, not part of the KoinDX periphery |
| `NFTDescriptor.spec.ts`, `NonfungibleTokenPositionDescriptor.spec.ts`, `Base64.spec.ts` | — | — | the position metadata is on chain JSON (KCS-5 `metadata_of`), there is no SVG |
| `Multicall.spec.ts`, `SelfPermit.spec.ts` | — | — | a Koinos transaction can have several operations; there are no permits (transaction signatures and the authority system) |
| `V3Migrator.spec.ts`, `PairFlash.spec.ts` | — | — | not implemented (Uniswap v2 migration, flash swap example) |
| `SwapRouter.gas.spec.ts` | — | — | EVM gas |

## Differential fuzzing

`tests/uniswap/differential/Periphery.fuzz.test.js` runs random sequences of position manager
operations (mint, increase, decrease, collect, burn, by the owner or not) and router swaps (exact
input / output, single and multi hop, price limits) on KoinDX and on the Uniswap reference: the
`NonfungiblePositionManager`, `SwapRouter`, factory and pool bytecode published by Uniswap, run in
an EVM (`tests/uniswap/evm`, shared with v3-core). After every operation both must agree on the
outcome (success, or failure with the same reason), the returned amounts, the positions of every
NFT, the pools and the token balances.

```sh
PERIPHERY_FUZZ_RUNS=120 PERIPHERY_FUZZ_OPS=100 PERIPHERY_FUZZ_SEED=100 npx jest --rootDir tests uniswap/differential
```

The only differences are revert reasons (Uniswap's requires without a message) and the Koinos
limits: an amount above 2^64 can't be paid, and an exact output whose input amount exceeds
2^64 - 1 on a pool (more than a token supply) reverts there on KoinDX (`AMOUNT_OVERFLOW`). Uniswap reverts later on the same
operation: beyond the liquidity the router rejects the partial output, and on a multi hop path the
previous pool reverts with `SPL` when its price is already at the limit. Like the v3-core fuzzer,
the reference runs without the Ethereum block gas limit.

## Adaptations

- The payer of `mint`, `increase_liquidity` and the swaps is `from`, who signs the transaction.
  The test tokens follow the Koinos token standard (KCS-4, `tests/vm/token.js`): like the Uniswap
  tests, the accounts approve the manager and the router (`MaxUint64` instead of `MaxUint256`).
  `tests/kcs4.test.js` checks the allowances (approve and swap / mint in the same transaction,
  exact amounts, multi hop, smart wallets).
- Pools are created by uploading the pool bytecode in the transaction that calls
  `factory.create_pool`; `initialize_pool_if_necessary` initializes them
  (Uniswap: `createAndInitializePoolIfNecessary`).
- Paths are lists of tokens and fees in the order of the swaps, also for the exact output (the
  router reverses them like the encoded path of Uniswap). The lists of prices and ticks crossed of
  `quote_exact_output` follow this order.
- The NFT follows the Koinos collections standards (KCS-2 / KCS-5): `transfer(from, to, id)`,
  approvals are checked against the calling contract (an approved contract can transfer, an
  approved account can't do it directly), the owner or the approved account can decrease, collect
  and burn a position with `from`, the metadata is on chain JSON.
- Deadlines are in milliseconds (Koinos block time) and mandatory (0 reverts, like Uniswap).
- Token amounts are `u64`, like the Koinos tokens: `2^64 - 1` replaces `2^128 - 1` / `2^256 - 1`.
- Not applicable: ETH / WETH9, payable functions, `refundETH`, `unwrapWETH9`, gas. `sweepToken`
  is the router's `sweep_token` (tested with what a partly filled intermediate hop leaves).

## Differences found and fixed

- The fees owed to a position of the manager are truncated to `uint128` and `tokensOwed` wraps
  at 2^128 like Uniswap (Solidity 0.7), instead of reverting.
