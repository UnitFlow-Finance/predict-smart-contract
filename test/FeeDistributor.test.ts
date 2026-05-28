import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { FeeDistributor, MockERC20, MockUnitFlowRouter } from "../typechain-types";

async function deployFeeDistributor(
  owner: SignerWithAddress,
  routerAddr: string,
  treasuryAddr: string,
  lpAddr: string,
  unitTokenAddr: string   // pass ZeroAddress for manual mode
): Promise<FeeDistributor> {
  const Impl = await ethers.getContractFactory("FeeDistributor");
  const impl = await Impl.deploy();

  const Proxy = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy"
  );
  const initData = Impl.interface.encodeFunctionData("initialize", [
    routerAddr,
    treasuryAddr,
    lpAddr,
    unitTokenAddr,
    owner.address,
  ]);
  const proxy = await Proxy.deploy(await impl.getAddress(), owner.address, initData);
  return Impl.attach(await proxy.getAddress()) as FeeDistributor;
}

describe("FeeDistributor", () => {
  let owner: SignerWithAddress;
  let market: SignerWithAddress;
  let stranger: SignerWithAddress;
  let treasury: SignerWithAddress;
  let lpRewardPool: SignerWithAddress;

  let usdc: MockERC20;
  let unitToken: MockERC20;
  let router: MockUnitFlowRouter;

  const MINT = ethers.parseUnits("1000000", 6);
  const FEE  = ethers.parseUnits("1000", 6);

  async function setupFd(withUnitToken: boolean): Promise<FeeDistributor> {
    const fd = await deployFeeDistributor(
      owner,
      await router.getAddress(),
      treasury.address,
      lpRewardPool.address,
      withUnitToken ? await unitToken.getAddress() : ethers.ZeroAddress
    );
    await fd.connect(owner).authorizeMarket(market.address);
    return fd;
  }

  async function seedFee(fd: FeeDistributor, amount = FEE) {
    await usdc.mint(await fd.getAddress(), amount);
    await fd.connect(market).receiveFee(await usdc.getAddress(), amount);
  }

  // Helper: distribute with zero minBuybackOut (acceptable in tests; real callers should supply a quote)
  async function distribute(fd: FeeDistributor, caller = stranger) {
    return fd.connect(caller).distributeFees(await usdc.getAddress(), 0);
  }

  beforeEach(async () => {
    [owner, market, stranger, treasury, lpRewardPool] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    usdc      = (await Token.deploy("Mock USDC", "USDC", 6))  as MockERC20;
    unitToken = (await Token.deploy("Mock UNIT", "UNIT", 18)) as MockERC20;
    await usdc.mint(owner.address, MINT);

    const Router = await ethers.getContractFactory("MockUnitFlowRouter");
    router = (await Router.deploy()) as MockUnitFlowRouter;
  });

  // ─── receiveFee ─────────────────────────────────────────────────────────────

  describe("receiveFee", () => {
    let fd: FeeDistributor;
    beforeEach(async () => { fd = await setupFd(true); });

    it("authorized market increments pendingFees", async () => {
      const amount = ethers.parseUnits("100", 6);
      await usdc.mint(await fd.getAddress(), amount);
      await fd.connect(market).receiveFee(await usdc.getAddress(), amount);
      expect(await fd.pendingFees(await usdc.getAddress())).to.equal(amount);
    });

    it("owner can call receiveFee", async () => {
      const amount = ethers.parseUnits("50", 6);
      await usdc.mint(await fd.getAddress(), amount);
      await expect(fd.connect(owner).receiveFee(await usdc.getAddress(), amount)).to.not.be.reverted;
    });

    it("unauthorized address reverts", async () => {
      await expect(
        fd.connect(stranger).receiveFee(await usdc.getAddress(), ethers.parseUnits("1", 6))
      ).to.be.revertedWith("FeeDistributor: not authorized");
    });

    it("reverts on zero amount", async () => {
      await expect(
        fd.connect(market).receiveFee(await usdc.getAddress(), 0)
      ).to.be.revertedWith("FeeDistributor: zero amount");
    });

    it("accumulates multiple calls", async () => {
      const a1 = ethers.parseUnits("100", 6);
      const a2 = ethers.parseUnits("200", 6);
      await usdc.mint(await fd.getAddress(), a1 + a2);
      await fd.connect(market).receiveFee(await usdc.getAddress(), a1);
      await fd.connect(market).receiveFee(await usdc.getAddress(), a2);
      expect(await fd.pendingFees(await usdc.getAddress())).to.equal(a1 + a2);
    });
  });

  // ─── distributeFees — auto mode ──────────────────────────────────────────────

  describe("distributeFees — auto mode (unitToken set)", () => {
    let fd: FeeDistributor;
    beforeEach(async () => {
      fd = await setupFd(true);
      await seedFee(fd);
    });

    it("splits 60/20/20: LP and treasury receive correct amounts", async () => {
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      const lpBefore       = await usdc.balanceOf(lpRewardPool.address);

      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);

      const buyback = (FEE * 6000n) / 10000n;
      const lp      = (FEE * 2000n) / 10000n;
      const treas   = FEE - buyback - lp;

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + treas);
      expect(await usdc.balanceOf(lpRewardPool.address)).to.equal(lpBefore + lp);
    });

    it("calls swap on router with correct buyback amount", async () => {
      const buyback = (FEE * 6000n) / 10000n;
      await expect(fd.connect(stranger).distributeFees(await usdc.getAddress(), 0))
        .to.emit(router, "SwapExecuted")
        .withArgs(await usdc.getAddress(), await fd.unitToken(), buyback, await fd.deadAddress());
    });

    it("emits FeesDistributed with correct amounts", async () => {
      const buyback = (FEE * 6000n) / 10000n;
      const lp      = (FEE * 2000n) / 10000n;
      const treas   = FEE - buyback - lp;
      await expect(fd.connect(stranger).distributeFees(await usdc.getAddress(), 0))
        .to.emit(fd, "FeesDistributed")
        .withArgs(await usdc.getAddress(), buyback, lp, treas);
    });

    it("resets pendingFees to zero", async () => {
      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);
      expect(await fd.pendingFees(await usdc.getAddress())).to.equal(0);
    });

    it("does NOT accumulate pendingBuyback in auto mode", async () => {
      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);
      expect(await fd.getPendingBuyback(await usdc.getAddress())).to.equal(0);
    });

    it("reverts when nothing to distribute", async () => {
      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);
      await expect(
        fd.connect(stranger).distributeFees(await usdc.getAddress(), 0)
      ).to.be.revertedWith("FeeDistributor: nothing to distribute");
    });
  });

  // ─── distributeFees — manual mode ────────────────────────────────────────────

  describe("distributeFees — manual mode (unitToken == address(0))", () => {
    let fd: FeeDistributor;
    beforeEach(async () => {
      fd = await setupFd(false);
      await seedFee(fd);
    });

    it("does NOT call the router", async () => {
      await expect(fd.connect(stranger).distributeFees(await usdc.getAddress(), 0))
        .to.not.emit(router, "SwapExecuted");
    });

    it("accumulates buyback share in pendingBuyback", async () => {
      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);
      const expected = (FEE * 6000n) / 10000n;
      expect(await fd.getPendingBuyback(await usdc.getAddress())).to.equal(expected);
    });

    it("still routes LP and treasury shares correctly", async () => {
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      const lpBefore       = await usdc.balanceOf(lpRewardPool.address);

      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);

      const buyback = (FEE * 6000n) / 10000n;
      const lp      = (FEE * 2000n) / 10000n;
      const treas   = FEE - buyback - lp;

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + treas);
      expect(await usdc.balanceOf(lpRewardPool.address)).to.equal(lpBefore + lp);
    });

    it("emits FeesDistributed with buybackAmount = 0", async () => {
      const lp    = (FEE * 2000n) / 10000n;
      const treas = FEE - (FEE * 6000n) / 10000n - lp;
      await expect(fd.connect(stranger).distributeFees(await usdc.getAddress(), 0))
        .to.emit(fd, "FeesDistributed")
        .withArgs(await usdc.getAddress(), 0n, lp, treas);
    });

    it("accumulates pendingBuyback across multiple distributions", async () => {
      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);
      await seedFee(fd, FEE);
      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);
      const expected = ((FEE * 6000n) / 10000n) * 2n;
      expect(await fd.getPendingBuyback(await usdc.getAddress())).to.equal(expected);
    });
  });

  // ─── executeBuyback ──────────────────────────────────────────────────────────

  describe("executeBuyback", () => {
    let fd: FeeDistributor;
    const BUYBACK = (FEE * 6000n) / 10000n;

    beforeEach(async () => {
      fd = await setupFd(false); // manual mode
      await seedFee(fd);
      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);
      // pendingBuyback[usdc] == BUYBACK now
    });

    it("reverts if unitToken not set", async () => {
      await expect(
        fd.connect(owner).executeBuyback(await usdc.getAddress(), 0)
      ).to.be.revertedWith("FeeDistributor: unitToken not set");
    });

    it("reverts if no pending buyback", async () => {
      await fd.connect(owner).updateUnitToken(await unitToken.getAddress());
      await fd.connect(owner).executeBuyback(await usdc.getAddress(), 0); // drain
      await expect(
        fd.connect(owner).executeBuyback(await usdc.getAddress(), 0)
      ).to.be.revertedWith("FeeDistributor: no pending buyback");
    });

    it("non-owner reverts", async () => {
      await fd.connect(owner).updateUnitToken(await unitToken.getAddress());
      await expect(
        fd.connect(stranger).executeBuyback(await usdc.getAddress(), 0)
      ).to.be.reverted;
    });

    it("executes swap via router after unitToken is set", async () => {
      await fd.connect(owner).updateUnitToken(await unitToken.getAddress());
      await expect(fd.connect(owner).executeBuyback(await usdc.getAddress(), 0))
        .to.emit(router, "SwapExecuted")
        .withArgs(await usdc.getAddress(), await unitToken.getAddress(), BUYBACK, await fd.deadAddress());
    });

    it("emits BuybackExecuted", async () => {
      await fd.connect(owner).updateUnitToken(await unitToken.getAddress());
      await expect(fd.connect(owner).executeBuyback(await usdc.getAddress(), 0))
        .to.emit(fd, "BuybackExecuted")
        .withArgs(await usdc.getAddress(), BUYBACK, 0n);
    });

    it("zeroes pendingBuyback after execution", async () => {
      await fd.connect(owner).updateUnitToken(await unitToken.getAddress());
      await fd.connect(owner).executeBuyback(await usdc.getAddress(), 0);
      expect(await fd.getPendingBuyback(await usdc.getAddress())).to.equal(0);
    });

    it("full lifecycle: manual → set unitToken → executeBuyback → auto mode", async () => {
      // Accumulate a second round in manual mode
      await seedFee(fd, FEE);
      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);
      expect(await fd.getPendingBuyback(await usdc.getAddress())).to.equal(BUYBACK * 2n);

      // Owner sets unitToken (UNIT is now live)
      await fd.connect(owner).updateUnitToken(await unitToken.getAddress());

      // Execute the accumulated buyback
      await fd.connect(owner).executeBuyback(await usdc.getAddress(), 0);
      expect(await fd.getPendingBuyback(await usdc.getAddress())).to.equal(0);

      // Future distributions now auto-swap — no pendingBuyback accumulation
      await seedFee(fd, FEE);
      await fd.connect(stranger).distributeFees(await usdc.getAddress(), 0);
      expect(await fd.getPendingBuyback(await usdc.getAddress())).to.equal(0);
    });
  });

  // ─── updateUnitToken ─────────────────────────────────────────────────────────

  describe("updateUnitToken", () => {
    let fd: FeeDistributor;
    beforeEach(async () => { fd = await setupFd(true); });

    it("owner sets a new unitToken", async () => {
      const newToken = ethers.Wallet.createRandom().address;
      await fd.connect(owner).updateUnitToken(newToken);
      expect(await fd.unitToken()).to.equal(newToken);
    });

    it("owner can set unitToken to address(0) to re-enter manual mode", async () => {
      await fd.connect(owner).updateUnitToken(ethers.ZeroAddress);
      expect(await fd.unitToken()).to.equal(ethers.ZeroAddress);
    });

    it("emits UnitTokenUpdated", async () => {
      const prev = await fd.unitToken();
      const next = await unitToken.getAddress();
      await expect(fd.connect(owner).updateUnitToken(next))
        .to.emit(fd, "UnitTokenUpdated")
        .withArgs(prev, next);
    });

    it("non-owner reverts", async () => {
      await expect(
        fd.connect(stranger).updateUnitToken(await unitToken.getAddress())
      ).to.be.reverted;
    });
  });

  // ─── updateSplit ─────────────────────────────────────────────────────────────

  describe("updateSplit", () => {
    let fd: FeeDistributor;
    beforeEach(async () => { fd = await setupFd(true); });

    it("owner updates split", async () => {
      await fd.connect(owner).updateSplit(5000, 3000, 2000);
      expect(await fd.buybackShare()).to.equal(5000);
      expect(await fd.lpShare()).to.equal(3000);
      expect(await fd.treasuryShare()).to.equal(2000);
    });

    it("reverts if split != 10000", async () => {
      await expect(fd.connect(owner).updateSplit(5000, 3000, 1000)).to.be.revertedWith(
        "FeeDistributor: split != 10000"
      );
    });

    it("non-owner reverts", async () => {
      await expect(fd.connect(stranger).updateSplit(5000, 3000, 2000)).to.be.reverted;
    });
  });

  // ─── authorizeMarket ─────────────────────────────────────────────────────────

  describe("authorizeMarket", () => {
    let fd: FeeDistributor;
    beforeEach(async () => { fd = await setupFd(true); });

    it("owner authorizes a market", async () => {
      await fd.connect(owner).authorizeMarket(stranger.address);
      expect(await fd.authorizedMarkets(stranger.address)).to.be.true;
    });

    it("emits MarketAuthorized", async () => {
      await expect(fd.connect(owner).authorizeMarket(stranger.address))
        .to.emit(fd, "MarketAuthorized")
        .withArgs(stranger.address);
    });

    it("non-owner reverts", async () => {
      await expect(fd.connect(stranger).authorizeMarket(stranger.address)).to.be.reverted;
    });

    it("reverts on zero address", async () => {
      await expect(
        fd.connect(owner).authorizeMarket(ethers.ZeroAddress)
      ).to.be.revertedWith("FeeDistributor: zero market");
    });
  });

  // ─── updateAddresses ─────────────────────────────────────────────────────────

  describe("updateAddresses", () => {
    let fd: FeeDistributor;
    beforeEach(async () => { fd = await setupFd(true); });

    it("owner updates all addresses", async () => {
      const r = ethers.Wallet.createRandom().address;
      const t = ethers.Wallet.createRandom().address;
      const l = ethers.Wallet.createRandom().address;
      await fd.connect(owner).updateAddresses(r, t, l);
      expect(await fd.unitRouter()).to.equal(r);
      expect(await fd.treasury()).to.equal(t);
      expect(await fd.lpRewardPool()).to.equal(l);
    });

    it("reverts on zero unitRouter", async () => {
      await expect(
        fd.connect(owner).updateAddresses(ethers.ZeroAddress, treasury.address, lpRewardPool.address)
      ).to.be.revertedWith("FeeDistributor: zero unitRouter");
    });
  });
});
