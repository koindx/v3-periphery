import { Arrays, System, Storage, Protobuf, authority } from "@koinos/sdk-as";
import { router } from "./proto/router";
import { Network } from "../../../utils/Network";
import { Contract } from "../../../utils/Contract";
import { ADDRESS_LENGTH } from "../../../utils/Tokens";
import { U256 } from "../../../libraries/U256";
import { TickMath } from "../../../libraries/TickMath";
import { Path } from "../../../libraries/Path";
import { PoolAddress } from "../../../libraries/PoolAddress";
import { CallbackValidation } from "../../../libraries/CallbackValidation";
import { PeripheryPayments } from "../../../base/PeripheryPayments";
import { PeripheryValidation } from "../../../base/PeripheryValidation";

const AMOUNT_IN_CACHE_SPACE_ID = 0;

/**
 * KoinDX v3 SwapRouter: port of Uniswap v3 SwapRouter.
 *
 * Router for stateless execution of swaps against KoinDX v3 pools.
 */
export class Router {
  contractId: Uint8Array;
  amountInCached: Storage.Obj<router.amount_in_cache>;

  constructor() {
    this.contractId = System.getContractId();
    this.amountInCached = new Storage.Obj(
      this.contractId,
      AMOUNT_IN_CACHE_SPACE_ID,
      router.amount_in_cache.decode,
      router.amount_in_cache.encode,
      null
    );
  }

  /**
   * The contract is deployed overriding its own authority (call contract, transaction
   * application and upload contract): nobody can act on behalf of it or upgrade its code.
   */
  authorize(args: authority.authorize_arguments): authority.authorize_result {
    return new authority.authorize_result(false);
  }

  factory(args: router.factory_arguments): router.address {
    return new router.address(Network.factory());
  }

  sweep_token(args: router.sweep_token_arguments): router.sweep_token_result {
    this.checkRecipient(args.recipient);
    return new router.sweep_token_result(PeripheryPayments.sweepToken(args.token, args.amount_minimum, args.recipient));
  }

  koindx_v3_swap_callback(args: router.koindx_v3_swap_callback_arguments): router.empty_object {
    // the pool is owed `amount_in` of token0 (zero_for_one) or token1 (Uniswap: the positive delta)
    const amountToPay = args.amount_in;
    // swaps entirely within 0-liquidity regions are not supported
    System.require(amountToPay > 0, "KOINDX: INVALID_SWAP_DELTAS");

    const data = Protobuf.decode<router.swap_callback_data>(args.data, router.swap_callback_data.decode);
    const path = Path.validate(data.path_tokens, data.path_fees);
    const tokenIn = path.tokenA();
    const tokenOut = path.tokenB();
    const pool = CallbackValidation.verifyCallback(tokenIn, tokenOut, path.fee());

    // the token owed is tokenIn of the path for an exact input, tokenOut for an exact output
    // (the exact output paths are reversed)
    const isExactInput = args.zero_for_one == (tokenIn < tokenOut);

    if (isExactInput) {
      PeripheryPayments.pay(tokenIn, data.payer, pool.address, amountToPay);
    } else {
      // either initiate the next swap or pay
      if (path.hasMultiplePools()) {
        this.exactOutputInternal(amountToPay, pool.address, U256.zero(), path.skipToken(), data.payer);
      } else {
        this.amountInCached.put(new router.amount_in_cache(amountToPay));
        // swap in/out because exact output swaps are reversed
        PeripheryPayments.pay(tokenOut, data.payer, pool.address, amountToPay);
      }
    }
    return new router.empty_object();
  }

  exact_input_single(args: router.exact_input_single_arguments): router.exact_input_single_result {
    PeripheryValidation.checkDeadline(args.deadline);
    const payer = Contract.getSender(args.from);
    this.checkRecipient(args.recipient);

    const amountOut = this.exactInputInternal(
      args.amount_in,
      args.recipient,
      parseSqrtPriceLimit(args.sqrt_price_limit_x96),
      new Path([args.token_in, args.token_out], [args.fee]),
      payer
    );
    System.require(amountOut >= args.amount_out_minimum, "KOINDX: TOO_LITTLE_RECEIVED");
    return new router.exact_input_single_result(amountOut);
  }

  exact_input(args: router.exact_input_arguments): router.exact_input_result {
    PeripheryValidation.checkDeadline(args.deadline);
    let payer = Contract.getSender(args.from); // the sender pays for the first hop
    this.checkRecipient(args.recipient);

    let path = Path.validate(args.tokens, args.fees);
    let amountIn = args.amount_in;
    while (true) {
      const hasMultiplePools = path.hasMultiplePools();

      // the outputs of prior swaps become the inputs to subsequent ones
      amountIn = this.exactInputInternal(
        amountIn,
        hasMultiplePools ? this.contractId : args.recipient, // for intermediate swaps, this contract custodies
        U256.zero(),
        path.getFirstPool(), // only the first pool in the path is necessary
        payer
      );

      // decide whether to continue or terminate
      if (hasMultiplePools) {
        payer = this.contractId; // at this point, the caller has paid
        path = path.skipToken();
      } else {
        break;
      }
    }

    const amountOut = amountIn;
    System.require(amountOut >= args.amount_out_minimum, "KOINDX: TOO_LITTLE_RECEIVED");
    return new router.exact_input_result(amountOut);
  }

  exact_output_single(args: router.exact_output_single_arguments): router.exact_output_single_result {
    PeripheryValidation.checkDeadline(args.deadline);
    const payer = Contract.getSender(args.from);
    this.checkRecipient(args.recipient);

    const amountIn = this.exactOutputInternal(
      args.amount_out,
      args.recipient,
      parseSqrtPriceLimit(args.sqrt_price_limit_x96),
      new Path([args.token_out, args.token_in], [args.fee]),
      payer
    );
    System.require(amountIn <= args.amount_in_maximum, "KOINDX: TOO_MUCH_REQUESTED");
    // has to be reset even though we don't use it in the single hop case
    this.amountInCached.remove();
    return new router.exact_output_single_result(amountIn);
  }

  exact_output(args: router.exact_output_arguments): router.exact_output_result {
    PeripheryValidation.checkDeadline(args.deadline);
    // it's okay that the payer is fixed to the sender here, as they're only paying for the "final" exact output
    // swap, which happens first, and subsequent swaps are paid for within nested callback frames
    const payer = Contract.getSender(args.from);
    this.checkRecipient(args.recipient);

    // Uniswap encodes exact output paths reversed (output token first)
    const path = Path.validate(args.tokens, args.fees).reverse();
    this.exactOutputInternal(args.amount_out, args.recipient, U256.zero(), path, payer);

    const cache = this.amountInCached.get();
    System.require(cache !== null, "KOINDX: AMOUNT_IN_NOT_FOUND");
    const amountIn = cache!.value;
    System.require(amountIn <= args.amount_in_maximum, "KOINDX: TOO_MUCH_REQUESTED");
    this.amountInCached.remove();
    return new router.exact_output_result(amountIn);
  }

  /**
   * The recipient must be an address, and not the router: the router only keeps the tokens of a
   * multi hop swap between its hops, tokens sent to it can be taken by anyone (sweep_token)
   */
  private checkRecipient(recipient: Uint8Array): void {
    System.require(recipient.length == ADDRESS_LENGTH && !Arrays.equal(recipient, this.contractId), "KOINDX: INVALID_RECIPIENT");
  }

  /** Performs a single exact input swap */
  private exactInputInternal(
    amountIn: u64,
    recipient: Uint8Array,
    sqrtPriceLimitX96: U256,
    path: Path,
    payer: Uint8Array
  ): u64 {
    const tokenIn = path.tokenA();
    const tokenOut = path.tokenB();
    const zeroForOne = tokenIn < tokenOut;
    const pool = PoolAddress.getPool(tokenIn, tokenOut, path.fee());

    System.require(amountIn > 0, "KOINDX: INVALID_AMOUNT_IN");
    const res = pool.swap(
      recipient,
      zeroForOne,
      true,
      amountIn,
      sqrtPriceLimit(sqrtPriceLimitX96, zeroForOne),
      encodeCallbackData(path, payer)
    );
    return res.amount_out;
  }

  /** Performs a single exact output swap */
  private exactOutputInternal(
    amountOut: u64,
    recipient: Uint8Array,
    sqrtPriceLimitX96: U256,
    path: Path,
    payer: Uint8Array
  ): u64 {
    // the path is reversed: the first token is the output token
    const tokenOut = path.tokenA();
    const tokenIn = path.tokenB();
    const zeroForOne = tokenIn < tokenOut;
    const pool = PoolAddress.getPool(tokenIn, tokenOut, path.fee());

    System.require(amountOut > 0, "KOINDX: INVALID_AMOUNT_OUT");
    const res = pool.swap(
      recipient,
      zeroForOne,
      false,
      amountOut,
      sqrtPriceLimit(sqrtPriceLimitX96, zeroForOne),
      encodeCallbackData(path, payer)
    );

    // it's technically possible to not receive the full output amount,
    // so if no price limit has been specified, require this possibility away
    if (sqrtPriceLimitX96.isZero()) {
      System.require(res.amount_out == amountOut, "KOINDX: INSUFFICIENT_OUTPUT_AMOUNT");
    }
    return res.amount_in;
  }
}

function encodeCallbackData(path: Path, payer: Uint8Array): Uint8Array {
  return Protobuf.encode(
    new router.swap_callback_data(path.tokens, path.fees, payer),
    router.swap_callback_data.encode
  );
}

/** "" or "0" means no price limit */
function parseSqrtPriceLimit(value: string): U256 {
  if (value.length == 0) return U256.zero();
  return U256.fromString(value);
}

/** the price limit sent to the pool: no limit means the min/max price */
function sqrtPriceLimit(sqrtPriceLimitX96: U256, zeroForOne: bool): string {
  if (!sqrtPriceLimitX96.isZero()) return sqrtPriceLimitX96.toString();
  return zeroForOne
    ? U256.add(TickMath.MIN_SQRT_RATIO, U256.one()).toString()
    : U256.sub(TickMath.MAX_SQRT_RATIO, U256.one()).toString();
}
