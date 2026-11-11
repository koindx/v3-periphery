import { System, Storage, Protobuf, Arrays } from "@koinos/sdk-as";
import { manager } from "./proto/manager";
import { Spaces } from "./Spaces";
import { Keys } from "../../../utils/Keys";
import { ADDRESS_LENGTH } from "../../../utils/Tokens";

export const TOKEN_ID_LENGTH = 8;

/** token ids are 8 bytes (big endian uint64) */
export function tokenIdToBytes(id: u64): Uint8Array {
  return Keys.uint64(id);
}

export function tokenIdFromBytes(tokenId: Uint8Array): u64 {
  System.require(tokenId.length == TOKEN_ID_LENGTH, "KOINDX: INVALID_TOKEN_ID");
  return Keys.toUint64(tokenId);
}

/**
 * NFT logic of the position manager (Uniswap: ERC721), following the Koinos collections
 * standard (KCS-2) and the `get_tokens_by_owner` pagination of KCS-5.
 */
export class Nft {
  supply: Storage.Obj<manager.uint64>;
  owners: Storage.Map<Uint8Array, manager.address>;
  balances: Storage.Map<Uint8Array, manager.uint64>;
  tokenApprovals: Storage.Map<Uint8Array, manager.address>;
  operatorApprovals: Storage.Map<Uint8Array, manager.boole>;
  // owner + token id => true (index used by get_tokens_by_owner)
  ownerTokens: Storage.Map<Uint8Array, manager.boole>;

  constructor(contractId: Uint8Array) {
    this.supply = new Storage.Obj(contractId, Spaces.NFT_SUPPLY_SPACE_ID, manager.uint64.decode, manager.uint64.encode, () => new manager.uint64(0));
    this.owners = new Storage.Map(contractId, Spaces.NFT_OWNERS_SPACE_ID, manager.address.decode, manager.address.encode, null);
    this.balances = new Storage.Map(contractId, Spaces.NFT_BALANCES_SPACE_ID, manager.uint64.decode, manager.uint64.encode, () => new manager.uint64(0));
    this.tokenApprovals = new Storage.Map(contractId, Spaces.NFT_TOKEN_APPROVALS_SPACE_ID, manager.address.decode, manager.address.encode, null);
    this.operatorApprovals = new Storage.Map(contractId, Spaces.NFT_OPERATOR_APPROVALS_SPACE_ID, manager.boole.decode, manager.boole.encode, null);
    this.ownerTokens = new Storage.Map(contractId, Spaces.NFT_OWNER_TOKENS_SPACE_ID, manager.boole.decode, manager.boole.encode, null);
  }

  totalSupply(): u64 {
    return this.supply.get()!.value;
  }

  balanceOf(owner: Uint8Array): u64 {
    return this.balances.get(owner)!.value;
  }

  /** owner of the token, or an empty array if it doesn't exist */
  ownerOf(tokenId: Uint8Array): Uint8Array {
    const owner = this.owners.get(tokenId);
    return owner ? owner.value : new Uint8Array(0);
  }

  exists(tokenId: Uint8Array): bool {
    return this.ownerOf(tokenId).length > 0;
  }

  getApproved(tokenId: Uint8Array): Uint8Array {
    const approved = this.tokenApprovals.get(tokenId);
    return approved ? approved.value : new Uint8Array(0);
  }

  isApprovedForAll(owner: Uint8Array, operator: Uint8Array): bool {
    const approval = this.operatorApprovals.get(operatorKey(owner, operator));
    return approval ? approval.value : false;
  }

  /** Returns whether `spender` is allowed to manage `tokenId` */
  isApprovedOrOwner(spender: Uint8Array, tokenId: Uint8Array): bool {
    const owner = this.ownerOf(tokenId);
    System.require(owner.length > 0, "KOINDX: INVALID_TOKEN_ID");
    return Arrays.equal(spender, owner) ||
      Arrays.equal(this.getApproved(tokenId), spender) ||
      this.isApprovedForAll(owner, spender);
  }

  /** Returns a page of the tokens owned by `owner`, after `start` */
  tokensByOwner(owner: Uint8Array, start: Uint8Array, limit: i32, descending: bool): Uint8Array[] {
    const result: Uint8Array[] = [];
    if (limit <= 0) limit = 100;
    let key = new Uint8Array(owner.length + TOKEN_ID_LENGTH);
    key.set(owner, 0);
    if (start.length == TOKEN_ID_LENGTH) {
      key.set(start, owner.length);
    } else if (descending) {
      for (let i = owner.length; i < key.length; i++) key[i] = 0xFF;
    }
    if (descending && start.length != TOKEN_ID_LENGTH) {
      // include the last possible token id of the owner
      const obj = this.ownerTokens.get(key);
      if (obj) result.push(key.slice(owner.length));
    }
    while (result.length < limit) {
      const obj = descending ? this.ownerTokens.getPrev(key) : this.ownerTokens.getNext(key);
      if (!obj) break;
      const k = obj.key!;
      if (k.length != owner.length + TOKEN_ID_LENGTH || !Arrays.equal(k.slice(0, owner.length), owner)) break;
      result.push(k.slice(owner.length));
      key = k;
    }
    return result;
  }

  mint(to: Uint8Array, tokenId: Uint8Array): void {
    System.require(to.length == ADDRESS_LENGTH, "KOINDX: INVALID_RECIPIENT");
    System.require(!this.exists(tokenId), "KOINDX: TOKEN_ALREADY_MINTED");
    this.owners.put(tokenId, new manager.address(to));
    this.addToOwner(to, tokenId);
    const supply = this.supply.get()!;
    supply.value += 1;
    this.supply.put(supply);
    System.event(
      "collections.mint_event",
      Protobuf.encode(new manager.mint_event(to, tokenId), manager.mint_event.encode),
      [to]
    );
  }

  burn(tokenId: Uint8Array): void {
    const owner = this.ownerOf(tokenId);
    System.require(owner.length > 0, "KOINDX: INVALID_TOKEN_ID");
    this.tokenApprovals.remove(tokenId);
    this.owners.remove(tokenId);
    this.removeFromOwner(owner, tokenId);
    const supply = this.supply.get()!;
    supply.value -= 1;
    this.supply.put(supply);
    System.event(
      "collections.burn_event",
      Protobuf.encode(new manager.burn_event(owner, tokenId), manager.burn_event.encode),
      [owner]
    );
  }

  transfer(from: Uint8Array, to: Uint8Array, tokenId: Uint8Array): void {
    System.require(to.length == ADDRESS_LENGTH, "KOINDX: INVALID_RECIPIENT");
    // clear approvals from the previous owner
    this.tokenApprovals.remove(tokenId);
    this.removeFromOwner(from, tokenId);
    this.owners.put(tokenId, new manager.address(to));
    this.addToOwner(to, tokenId);
    System.event(
      "collections.transfer_event",
      Protobuf.encode(new manager.transfer_event(from, to, tokenId), manager.transfer_event.encode),
      [to, from]
    );
  }

  approve(approver: Uint8Array, to: Uint8Array, tokenId: Uint8Array): void {
    if (to.length == 0) {
      this.tokenApprovals.remove(tokenId);
    } else {
      this.tokenApprovals.put(tokenId, new manager.address(to));
    }
    System.event(
      "collections.token_approval_event",
      Protobuf.encode(new manager.token_approval_event(approver, to, tokenId), manager.token_approval_event.encode),
      [to, approver]
    );
  }

  setApprovalForAll(owner: Uint8Array, operator: Uint8Array, approved: bool): void {
    if (approved) {
      this.operatorApprovals.put(operatorKey(owner, operator), new manager.boole(true));
    } else {
      this.operatorApprovals.remove(operatorKey(owner, operator));
    }
    System.event(
      "collections.operator_approval_event",
      Protobuf.encode(new manager.operator_approval_event(owner, operator, approved), manager.operator_approval_event.encode),
      [operator, owner]
    );
  }

  private addToOwner(owner: Uint8Array, tokenId: Uint8Array): void {
    const balance = this.balances.get(owner)!;
    balance.value += 1;
    this.balances.put(owner, balance);
    this.ownerTokens.put(ownerTokenKey(owner, tokenId), new manager.boole(true));
  }

  private removeFromOwner(owner: Uint8Array, tokenId: Uint8Array): void {
    const balance = this.balances.get(owner)!;
    System.require(balance.value > 0, "KOINDX: INVALID_BALANCE");
    balance.value -= 1;
    if (balance.value == 0) {
      this.balances.remove(owner);
    } else {
      this.balances.put(owner, balance);
    }
    this.ownerTokens.remove(ownerTokenKey(owner, tokenId));
  }
}

function operatorKey(owner: Uint8Array, operator: Uint8Array): Uint8Array {
  const key = new Uint8Array(owner.length + operator.length);
  key.set(owner, 0);
  key.set(operator, owner.length);
  return key;
}

function ownerTokenKey(owner: Uint8Array, tokenId: Uint8Array): Uint8Array {
  const key = new Uint8Array(owner.length + tokenId.length);
  key.set(owner, 0);
  key.set(tokenId, owner.length);
  return key;
}
