import { System } from "@koinos/sdk-as";

/** Port of Uniswap v3 PeripheryValidation */
export namespace PeripheryValidation {
  /** current block timestamp in milliseconds (Koinos block header) */
  export function blockTimestamp(): u64 {
    const field = System.getBlockField("header.timestamp");
    System.require(field != null, "KOINDX: BLOCK_TIMESTAMP_NOT_FOUND");
    return field!.uint64_value;
  }

  /**
   * Reverts if the transaction is included after `deadline` (milliseconds since epoch, like the
   * Koinos block timestamps). Like Uniswap the deadline is mandatory (0 reverts): a Koinos
   * transaction has no expiration, so a signed transaction could be included much later.
   */
  export function checkDeadline(deadline: u64): void {
    System.require(blockTimestamp() <= deadline, "KOINDX: TRANSACTION_TOO_OLD");
  }
}
