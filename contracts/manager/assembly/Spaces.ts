export namespace Spaces {
  // next token id, next pool id
  export const COUNTERS_SPACE_ID = 0;
  // token id (8 bytes) => position_record
  export const POSITIONS_SPACE_ID = 1;
  // pool address => pool id (uint64)
  export const POOL_IDS_SPACE_ID = 2;
  // pool id (8 bytes) => pool_record
  export const POOLS_SPACE_ID = 3;

  // NFT (KCS-2)
  export const NFT_SUPPLY_SPACE_ID = 4;
  // token id => owner
  export const NFT_OWNERS_SPACE_ID = 5;
  // owner => number of tokens
  export const NFT_BALANCES_SPACE_ID = 6;
  // token id => approved account
  export const NFT_TOKEN_APPROVALS_SPACE_ID = 7;
  // owner + operator => approved
  export const NFT_OPERATOR_APPROVALS_SPACE_ID = 8;
  // owner + token id => true
  export const NFT_OWNER_TOKENS_SPACE_ID = 9;
}
