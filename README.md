# KoinDX v3 Periphery

Port of [Uniswap v3 periphery](https://github.com/Uniswap/v3-periphery) to Koinos
(AssemblyScript): the contracts that users and dApps call to manage positions and swap through
the [KoinDX v3 core](https://github.com/koindx/v3-core) pools, like
[KoinDX v2 periphery](https://github.com/koindx/v2-periphery) for Uniswap v2.

| Contract | Uniswap v3 | Description |
|---|---|---|
| `manager` | `NonfungiblePositionManager` | positions wrapped in NFTs (Koinos collections standard), mint/increase/decrease/collect/burn, `initialize_pool_if_necessary` |
| `router` | `SwapRouter` | exact input/output swaps, single pool and multi hop |
| `quoter` | `QuoterV2` | read-only quotes of the router swaps |

| Library | Uniswap v3 |
|---|---|
| `libraries/LiquidityAmounts.ts` | `LiquidityAmounts` |
| `libraries/Path.ts` | `Path` (as `tokens` + `fees` arrays instead of packed bytes) |
| `libraries/PoolAddress.ts` | `PoolAddress` (pools are looked up in the factory, there is no `CREATE2`) |
| `libraries/CallbackValidation.ts` | `CallbackValidation` |
| `base/PeripheryPayments.ts`, `base/PeripheryValidation.ts` | `PeripheryPayments`, `PeripheryValidation` |
| `interfaces/*.proto`, `interfaces/*Client.ts` | the core interfaces: copies of the core protos and the entry points used |

`libraries/U256.ts`, `TickMath.ts`, `FixedPoint.ts`, `SafeCast.ts`, `utils/*` and `proto/*` are
copies of the same files of v3-core (the repositories don't depend on each other): apply any
change to both.

## Requirements

Node.js 18+ and yarn 1, same pinned toolchain as v3-core.

```sh
yarn install
```

## Build

The address of the factory is compiled into the contracts (like the v2 periphery), it is taken
from `networks.json`:

```json
{
  "local": { "factory": "1JaMS92SPa3rQoZqUifP7GJxp2MEULxrJB" },
  "harbinger": { "factory": "" },
  "mainnet": { "factory": "" }
}
```

Every contract is built separately, like the KoinDX v2 contracts (`yarn build:release`), for the
network given by `--network` (or `NETWORK`, `local` by default):

| Contract | Release build (deployed) | Debug build | Output |
|---|---|---|---|
| manager | `yarn build:release:manager --network <network>` | `yarn build:debug:manager` | `contracts/manager/build/<mode>/contract.wasm`, `contracts/manager/abi/` |
| router | `yarn build:release:router --network <network>` | `yarn build:debug:router` | `contracts/router/build/<mode>/contract.wasm`, `contracts/router/abi/` |
| quoter | `yarn build:release:quoter --network <network>` | `yarn build:debug:quoter` | `contracts/quoter/build/<mode>/contract.wasm`, `contracts/quoter/abi/` |

`yarn build:release --network <network>` and `yarn build:debug` build the three.

`build/<mode>/build.json` records the network of each build. As in v3-core, the contracts use
the AssemblyScript `stub` runtime (no garbage collector), repeated numeric proto fields must be
`[packed = true]`, and `DEBUG_ABORT=1` builds revert with the source location of
AssemblyScript runtime errors (local debugging only).

## Test

```sh
yarn test
```

Differential tests of `LiquidityAmounts`, `Path` and the shared math libraries against a BigInt
transliteration of the Solidity code and `@uniswap/v3-sdk`, and the as-bignum test vectors of
`U256` (`tests/as-bignum.test.js`, same file as v3-core). The Uniswap v3-periphery test suites
are ported (`tests/uniswap`) and run against the compiled contracts and the v3-core factory and
pools in an emulator of the Koinos VM, see [docs/UNISWAP_TESTS.md](docs/UNISWAP_TESTS.md).
`tests/koinos-security.test.js` covers the attacks specific to Koinos, see the
[security review](https://github.com/koindx/v3-core/blob/main/SECURITY.md). The contracts are tested end to end in the
[integration tests](https://github.com/koindx/v3-integration-tests).

`tests/core` holds the v3-core contracts used by the tests: `yarn sync-core` copies them from
the build of [v3-core](https://github.com/koindx/v3-core) cloned next to this repository.

The math libraries, the Koinos helpers (`utils/`), the core interfaces (`interfaces/*.proto`) and
the test tooling are replicated from v3-core (same files): `yarn check-shared` checks that they are
identical. The CI runs both checks against the current v3-core.

## Deployment

```sh
yarn build:release --network <network>
CONTRACT=manager NETWORK=<network> PRIVATE_KEY=<manager account wif> RPC_URL=<rpc url> yarn deploy
CONTRACT=router  NETWORK=<network> PRIVATE_KEY=<router account wif>  RPC_URL=<rpc url> yarn deploy
CONTRACT=quoter  NETWORK=<network> PRIVATE_KEY=<quoter account wif>  RPC_URL=<rpc url> yarn deploy
```

Each contract gets its own account and is uploaded overriding `call_contract`,
`transaction_application` and `upload_contract`: the deployer key has no power over the
contract and its code can't be changed. This is essential for the manager, which owns the
liquidity of every NFT position in the pools. The deployment script refuses builds made for
another network or with `DEBUG_ABORT=1`.

## Usage

Tokens are identified by strings, like in the KoinDX v2 periphery: `"koin"` and `"vhp"` (name
service, so pools keep working if the system contracts are upgraded) or the base58 address of
any other token.

`from` is the account that pays (and that the operation acts for): it must sign the transaction,
or be the contract calling the periphery. `deadline` is in milliseconds and mandatory, like
Uniswap (`0` reverts): a Koinos transaction has no expiration. `router.sweep_token` sends to anybody
what a multi hop swap left in the router (an intermediate hop partly filled), like Uniswap's
`sweepToken`.

The pools are paid with `transfer(from, pool, value)` called by the manager (`mint`,
`increase_liquidity`) or the router (swaps). Koinos tokens (KCS-4, like the KOIN contract) only
let a contract move the tokens of an account up to the allowance the account gave it, like the
ERC-20 approvals of Uniswap: `from` first approves the manager or the router
(`token.approve(owner = from, spender = manager or router, value)`). The approval can be an
operation of the same transaction, before the mint or the swap: approving the exact amount (or
`amount*Desired` / `amountInMaximum`) leaves no allowance behind (the unused part of a maximum
stays). Only the input token of a swap needs it (the router pays the next pools of a path with
the tokens it holds). A smart wallet (a contract account that authorizes the call) can pay
without an allowance. All the amounts are `u64`, like the Koinos tokens: any amount can be
swapped.

**Positions** (`manager`): `mint` creates a position NFT (`token0 < token1`, ticks multiple of
the tick spacing, `amount*Desired`/`amount*Min` slippage limits); `increase_liquidity`,
`decrease_liquidity` (credits the tokens to the position), `collect` (sends the tokens owed,
fees included) and `burn` (empty positions only) require the owner of the NFT or an approved
account. The NFT methods follow the Koinos collections standard (`transfer`, `approve`,
`set_approval_for_all`, `owner_of`, `get_tokens_by_owner`, `metadata_of`...).

**Swaps** (`router`): `exact_input_single`, `exact_output_single`, `exact_input` and
`exact_output`. Paths are `tokens` (in the swap order) and `fees` (`fees[i]` is the fee of the
pool between `tokens[i]` and `tokens[i + 1]`), e.g. `tokens: ["koin", A, B], fees: [3000, 500]`.
Unlike Uniswap, exact output paths are also given in the swap order.
`sqrt_price_limit_x96` is a decimal string (`""` = no limit).

**Quotes** (`quoter`): `quote_exact_input(_single)` and `quote_exact_output(_single)` return the
amounts, the prices after each hop and the initialized ticks crossed, using the read-only
`quote_swap` simulation of the pools (Koinos read-only calls can't use the
swap-and-revert trick of Uniswap). Read-only calls have a lower compute limit than
transactions: quotes of extreme swaps (hundreds of empty tick bitmap words) fail even though
the swap itself fits in a transaction.

## License

GPL-3.0, see [LICENSE](LICENSE).
