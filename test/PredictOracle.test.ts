import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { PredictOracle } from "../typechain-types";

const DISPUTE_WINDOW = 24 * 60 * 60; // 24 hours in seconds

async function deployOracle(owner: SignerWithAddress): Promise<PredictOracle> {
  const Impl = await ethers.getContractFactory("PredictOracle");
  const impl = await Impl.deploy();

  const Proxy = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy"
  );
  const initData = Impl.interface.encodeFunctionData("initialize", [owner.address]);
  const proxy = await Proxy.deploy(await impl.getAddress(), owner.address, initData);
  return Impl.attach(await proxy.getAddress()) as PredictOracle;
}

// Minimal market stub that records resolveMarket calls.
// The oracle itself calls resolveMarket, so we pass the oracle's address as resolver.
async function deployMarketStub(oracleAddress: string): Promise<string> {
  const Stub = await ethers.getContractFactory("MockMarketStub");
  const stub = await Stub.deploy(oracleAddress);
  return await stub.getAddress();
}

describe("PredictOracle", () => {
  let owner: SignerWithAddress;
  let resolver: SignerWithAddress;
  let disputer: SignerWithAddress;
  let stranger: SignerWithAddress;

  let oracle: PredictOracle;
  let marketAddr: string;

  beforeEach(async () => {
    [owner, resolver, disputer, stranger] = await ethers.getSigners();
    oracle = await deployOracle(owner);
    await oracle.connect(owner).addResolver(resolver.address);
    await oracle.connect(owner).addDisputer(disputer.address);
    marketAddr = await deployMarketStub(await oracle.getAddress());
  });

  // ─── addResolver / removeResolver ────────────────────────────────────────────

  describe("addResolver / removeResolver", () => {
    it("owner adds a resolver", async () => {
      await oracle.connect(owner).addResolver(stranger.address);
      expect(await oracle.authorizedResolvers(stranger.address)).to.be.true;
    });

    it("emits ResolverAdded", async () => {
      await expect(oracle.connect(owner).addResolver(stranger.address))
        .to.emit(oracle, "ResolverAdded")
        .withArgs(stranger.address);
    });

    it("owner removes a resolver", async () => {
      await oracle.connect(owner).removeResolver(resolver.address);
      expect(await oracle.authorizedResolvers(resolver.address)).to.be.false;
    });

    it("non-owner cannot add resolver", async () => {
      await expect(oracle.connect(stranger).addResolver(stranger.address)).to.be.reverted;
    });
  });

  // ─── proposeResolution ───────────────────────────────────────────────────────

  describe("proposeResolution", () => {
    it("authorized resolver can propose", async () => {
      await oracle.connect(resolver).proposeResolution(marketAddr, true);
      const res = await oracle.resolutions(marketAddr);
      expect(res.status).to.equal(1); // Proposed
      expect(res.proposedOutcome).to.be.true;
      expect(res.proposedBy).to.equal(resolver.address);
    });

    it("owner can propose without being in resolver list", async () => {
      await expect(oracle.connect(owner).proposeResolution(marketAddr, false)).to.not.be
        .reverted;
    });

    it("unauthorized address reverts", async () => {
      await expect(
        oracle.connect(stranger).proposeResolution(marketAddr, true)
      ).to.be.revertedWith("PredictOracle: not authorized");
    });

    it("cannot propose twice", async () => {
      await oracle.connect(resolver).proposeResolution(marketAddr, true);
      await expect(
        oracle.connect(resolver).proposeResolution(marketAddr, false)
      ).to.be.revertedWith("PredictOracle: already proposed");
    });

    it("emits ResolutionProposed with correct deadline", async () => {
      const tx = await oracle.connect(resolver).proposeResolution(marketAddr, true);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const expectedDeadline = block!.timestamp + DISPUTE_WINDOW;

      await expect(tx)
        .to.emit(oracle, "ResolutionProposed")
        .withArgs(marketAddr, true, resolver.address, expectedDeadline);
    });

    it("reverts on zero market address", async () => {
      await expect(
        oracle.connect(resolver).proposeResolution(ethers.ZeroAddress, true)
      ).to.be.revertedWith("PredictOracle: zero market");
    });
  });

  // ─── disputeResolution ───────────────────────────────────────────────────────

  describe("disputeResolution", () => {
    beforeEach(async () => {
      await oracle.connect(resolver).proposeResolution(marketAddr, true);
    });

    it("authorized disputer can dispute within window", async () => {
      await oracle.connect(disputer).disputeResolution(marketAddr);
      const res = await oracle.resolutions(marketAddr);
      expect(res.status).to.equal(2); // Disputed
      expect(res.disputedBy).to.equal(disputer.address);
    });

    it("unauthorized address cannot dispute", async () => {
      await expect(
        oracle.connect(stranger).disputeResolution(marketAddr)
      ).to.be.revertedWith("PredictOracle: not authorized to dispute");
    });

    it("emits ResolutionDisputed", async () => {
      await expect(oracle.connect(disputer).disputeResolution(marketAddr))
        .to.emit(oracle, "ResolutionDisputed")
        .withArgs(marketAddr, disputer.address);
    });

    it("reverts if not in Proposed state", async () => {
      await oracle.connect(disputer).disputeResolution(marketAddr);
      // Status is now Disputed — even an authorized disputer cannot dispute again
      await expect(
        oracle.connect(disputer).disputeResolution(marketAddr)
      ).to.be.revertedWith("PredictOracle: not proposed");
    });

    it("reverts after dispute window closes", async () => {
      await time.increase(DISPUTE_WINDOW + 1);
      await expect(
        oracle.connect(disputer).disputeResolution(marketAddr)
      ).to.be.revertedWith("PredictOracle: dispute window closed");
    });
  });

  // ─── finalizeResolution ──────────────────────────────────────────────────────

  describe("finalizeResolution", () => {
    beforeEach(async () => {
      await oracle.connect(resolver).proposeResolution(marketAddr, true);
    });

    it("reverts before dispute window expires", async () => {
      await expect(
        oracle.connect(stranger).finalizeResolution(marketAddr)
      ).to.be.revertedWith("PredictOracle: dispute window still open");
    });

    it("finalizes after window and calls resolveMarket", async () => {
      await time.increase(DISPUTE_WINDOW + 1);

      const stub = await ethers.getContractAt("MockMarketStub", marketAddr);
      await oracle.connect(stranger).finalizeResolution(marketAddr);

      const res = await oracle.resolutions(marketAddr);
      expect(res.status).to.equal(3); // Finalized

      expect(await stub.resolvedOutcome()).to.be.true;
      expect(await stub.resolveMarketCalled()).to.be.true;
    });

    it("emits ResolutionFinalized", async () => {
      await time.increase(DISPUTE_WINDOW + 1);
      await expect(oracle.connect(stranger).finalizeResolution(marketAddr))
        .to.emit(oracle, "ResolutionFinalized")
        .withArgs(marketAddr, true);
    });

    it("reverts if status is not Proposed (e.g. Disputed)", async () => {
      await oracle.connect(disputer).disputeResolution(marketAddr);
      await time.increase(DISPUTE_WINDOW + 1);
      await expect(
        oracle.connect(stranger).finalizeResolution(marketAddr)
      ).to.be.revertedWith("PredictOracle: not in proposed state");
    });
  });

  // ─── overrideResolution ──────────────────────────────────────────────────────

  describe("overrideResolution", () => {
    beforeEach(async () => {
      await oracle.connect(resolver).proposeResolution(marketAddr, true);
      await oracle.connect(disputer).disputeResolution(marketAddr);
    });

    it("owner overrides a disputed resolution", async () => {
      await oracle.connect(owner).overrideResolution(marketAddr, false);
      const res = await oracle.resolutions(marketAddr);
      expect(res.status).to.equal(3); // Finalized
      expect(res.proposedOutcome).to.be.false;
    });

    it("calls resolveMarket with overridden outcome", async () => {
      const stub = await ethers.getContractAt("MockMarketStub", marketAddr);
      await oracle.connect(owner).overrideResolution(marketAddr, false);
      expect(await stub.resolvedOutcome()).to.be.false;
    });

    it("emits ResolutionOverridden", async () => {
      await expect(oracle.connect(owner).overrideResolution(marketAddr, false))
        .to.emit(oracle, "ResolutionOverridden")
        .withArgs(marketAddr, false, owner.address);
    });

    it("non-owner reverts", async () => {
      await expect(
        oracle.connect(stranger).overrideResolution(marketAddr, false)
      ).to.be.reverted;
    });

    it("reverts if market is not in Disputed state", async () => {
      const market2 = await deployMarketStub(await oracle.getAddress());
      await oracle.connect(resolver).proposeResolution(market2, true);
      // Still Proposed, not Disputed
      await expect(
        oracle.connect(owner).overrideResolution(market2, false)
      ).to.be.revertedWith("PredictOracle: not disputed");
    });
  });

  // ─── Full flow: propose → dispute → override ─────────────────────────────────

  describe("full flow: propose → dispute → override", () => {
    it("completes the full dispute-and-override lifecycle", async () => {
      const stub = await ethers.getContractAt("MockMarketStub", marketAddr);

      // 1. Propose YES
      await oracle.connect(resolver).proposeResolution(marketAddr, true);
      expect((await oracle.resolutions(marketAddr)).status).to.equal(1);

      // 2. Dispute within window
      await oracle.connect(disputer).disputeResolution(marketAddr);
      expect((await oracle.resolutions(marketAddr)).status).to.equal(2);

      // 3. Owner overrides to NO
      await oracle.connect(owner).overrideResolution(marketAddr, false);
      expect((await oracle.resolutions(marketAddr)).status).to.equal(3);
      expect(await stub.resolvedOutcome()).to.be.false;
    });
  });
});
