import { System, authority } from "@koinos/sdk-as";
import { quoter } from "./proto/quoter";
import { Network } from "../../../utils/Network";
import { U256 } from "../../../libraries/U256";
import { TickMath } from "../../../libraries/TickMath";
import { Path } from "../../../libraries/Path";
import { PoolAddress } from "../../../libraries/PoolAddress";

class QuoteResult {
  constructor(
    public amount: u64,
    public sqrtPriceX96After: string,
    public initializedTicksCrossed: u32
  ) {}
}

/**
 * KoinDX v3 Quoter: port of Uniswap v3 QuoterV2.
 *
 * Allows getting the expected amount out or amount in for a given swap without executing the swap.
 */
export class Quoter {
  /**
   * The contract is deployed overriding its own authority (call contract, transaction
   * application and upload contract): nobody can act on behalf of it or upgrade its code.
   */
  authorize(args: authority.authorize_arguments): authority.authorize_result {
    return new authority.authorize_result(false);
  }

  factory(args: quoter.factory_arguments): quoter.address {
    return new quoter.address(Network.factory());
  }

  quote_exact_input_single(args: quoter.quote_exact_input_single_arguments): quoter.quote_exact_input_single_result {
    const res = quoteExactInputSingle(args.token_in, args.token_out, args.fee, args.amount_in, args.sqrt_price_limit_x96);
    return new quoter.quote_exact_input_single_result(res.amount, res.sqrtPriceX96After, res.initializedTicksCrossed);
  }

  quote_exact_input(args: quoter.quote_exact_input_arguments): quoter.quote_exact_input_result {
    const path = Path.validate(args.tokens, args.fees);
    const result = new quoter.quote_exact_input_result();
    let amount = args.amount_in;
    for (let i = 0; i < path.numPools(); i++) {
      // the outputs of prior swaps become the inputs to subsequent ones
      const res = quoteExactInputSingle(path.tokens[i], path.tokens[i + 1], path.fees[i], amount, "");
      result.sqrt_price_x96_after_list.push(res.sqrtPriceX96After);
      result.initialized_ticks_crossed_list.push(res.initializedTicksCrossed);
      amount = res.amount;
    }
    result.amount_out = amount;
    return result;
  }

  quote_exact_output_single(args: quoter.quote_exact_output_single_arguments): quoter.quote_exact_output_single_result {
    const res = quoteExactOutputSingle(args.token_in, args.token_out, args.fee, args.amount_out, args.sqrt_price_limit_x96);
    return new quoter.quote_exact_output_single_result(res.amount, res.sqrtPriceX96After, res.initializedTicksCrossed);
  }

  quote_exact_output(args: quoter.quote_exact_output_arguments): quoter.quote_exact_output_result {
    const path = Path.validate(args.tokens, args.fees);
    const pools = path.numPools();
    const sqrtPrices = new Array<string>(pools);
    const ticksCrossed = new Array<u32>(pools);
    let amount = args.amount_out;
    // exact output swaps are executed from the output token backwards
    for (let i = pools - 1; i >= 0; i--) {
      const res = quoteExactOutputSingle(path.tokens[i], path.tokens[i + 1], path.fees[i], amount, "");
      sqrtPrices[i] = res.sqrtPriceX96After;
      ticksCrossed[i] = res.initializedTicksCrossed;
      amount = res.amount;
    }
    return new quoter.quote_exact_output_result(amount, sqrtPrices, ticksCrossed);
  }
}

function quoteExactInputSingle(tokenIn: string, tokenOut: string, fee: u32, amountIn: u64, sqrtPriceLimit: string): QuoteResult {
  const zeroForOne = tokenIn < tokenOut;
  const pool = PoolAddress.getPool(tokenIn, tokenOut, fee);
  System.require(amountIn > 0, "KOINDX: INVALID_AMOUNT_IN");

  const res = pool.quoteSwap(zeroForOne, true, amountIn, priceLimit(sqrtPriceLimit, zeroForOne));
  // QuoterV2 / the router: swaps entirely within 0-liquidity regions are not supported
  System.require(res.amount_in > 0, "KOINDX: INVALID_SWAP_DELTAS");
  return new QuoteResult(res.amount_out, res.sqrt_price_x96_after, res.initialized_ticks_crossed);
}

function quoteExactOutputSingle(tokenIn: string, tokenOut: string, fee: u32, amountOut: u64, sqrtPriceLimit: string): QuoteResult {
  const zeroForOne = tokenIn < tokenOut;
  const pool = PoolAddress.getPool(tokenIn, tokenOut, fee);
  System.require(amountOut > 0, "KOINDX: INVALID_AMOUNT_OUT");

  const res = pool.quoteSwap(zeroForOne, false, amountOut, priceLimit(sqrtPriceLimit, zeroForOne));
  // QuoterV2 / the router: swaps entirely within 0-liquidity regions are not supported
  System.require(res.amount_in > 0, "KOINDX: INVALID_SWAP_DELTAS");
  // if no price limit has been specified, the full output amount must be available
  if (isNoLimit(sqrtPriceLimit)) {
    System.require(res.amount_out == amountOut, "KOINDX: INSUFFICIENT_LIQUIDITY");
  }
  return new QuoteResult(res.amount_in, res.sqrt_price_x96_after, res.initialized_ticks_crossed);
}

function isNoLimit(sqrtPriceLimit: string): bool {
  return sqrtPriceLimit.length == 0 || U256.fromString(sqrtPriceLimit).isZero();
}

function priceLimit(sqrtPriceLimit: string, zeroForOne: bool): string {
  if (!isNoLimit(sqrtPriceLimit)) return sqrtPriceLimit;
  return zeroForOne
    ? U256.add(TickMath.MIN_SQRT_RATIO, U256.one()).toString()
    : U256.sub(TickMath.MAX_SQRT_RATIO, U256.one()).toString();
}
