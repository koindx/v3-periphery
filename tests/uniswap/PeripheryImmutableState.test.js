// Port of Uniswap v3-periphery test/PeripheryImmutableState.spec.ts: the factory of the
// periphery contracts (compiled for the network, networks.json). Not applicable: WETH9, bytecode
// size.
const { completeFixture, FACTORY_ADDRESS } = require("./shared/fixtures");

describe("PeripheryImmutableState", () => {
  let fixture;
  beforeEach(() => {
    fixture = completeFixture();
  });

  describe("#factory", () => {
    it("points to v3 core factory", () => {
      expect(fixture.factory.address).toEqual(FACTORY_ADDRESS);
      for (const contract of [fixture.nft, fixture.router, fixture.quoter]) {
        expect(contract.read("factory").value).toEqual(fixture.factory.address);
      }
    });
  });
});
