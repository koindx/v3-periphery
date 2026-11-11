import { System, Arrays } from "@koinos/sdk-as";
import { TokenHelper } from "../utils/Contract";
import { Tokens } from "../utils/Tokens";

/**
 * Port of Uniswap v3 PeripheryPayments.
 *
 * Koinos has no native coin to wrap (KOIN is a token), so only `pay` is needed.
 */
export namespace PeripheryPayments {
  /**
   * Pays `value` of `token` to `recipient`.
   * If the payer is this contract the tokens are sent from its balance, otherwise they are
   * transferred from the payer: the token must accept a transfer of the payer's tokens made by
   * this contract (KCS-4: an allowance of the payer to this contract, or a smart wallet payer that
   * authorizes it; tokens that check the signatures of the transaction accept a payer who signed
   * it).
   */
  export function pay(token: string, payer: Uint8Array, recipient: Uint8Array, value: u64): void {
    if (value == 0) return;
    const self = System.getContractId();
    TokenHelper.transfer(Tokens.address(token), Arrays.equal(payer, self) ? self : payer, recipient, value);
  }

  /**
   * Uniswap sweepToken: sends the whole balance of `token` held by this contract to `recipient`,
   * if it is at least `amountMinimum`. Anybody can call it, like in Uniswap: this contract only
   * holds the tokens that a multi hop swap left (an intermediate hop that was partly filled).
   */
  export function sweepToken(token: string, amountMinimum: u64, recipient: Uint8Array): u64 {
    const self = System.getContractId();
    const tokenAddress = Tokens.address(token);
    const balance = TokenHelper.balanceOf(tokenAddress, self);
    System.require(balance >= amountMinimum, "KOINDX: INSUFFICIENT_TOKEN");
    if (balance > 0) TokenHelper.transfer(tokenAddress, self, recipient, balance);
    return balance;
  }
}
