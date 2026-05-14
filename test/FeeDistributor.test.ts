import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { FeeDistributor, MockERC20, MockUnitFlowRouter } from "../typechain-types";

async function deployFeeDistributor(
  owner: SignerWithAddress,
  routerAddr: string,
  treasuryAddr: string,
  lpAddr: string
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

  let fd: FeeDistributor;
  let usdc: MockERC20;
  let router: MockUnitFlowRouter;

  const MINT = ethers.parseUnits("1000000", 6);

  beforeEach(async () => {
    [owner, market, stranger, treasury, lpRewardPool] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    usdc = (await Token.deploy("Mock USDC", "USDC", 6)) as MockERC20;
    await usdc.mint(owner.address, MINT);

    const Router = await ethers.getContractFactory("MockUnitFlowRouter");
    router = (await Router.deploy()) as MockUnitFlowRouter;

    fd = await deployFeeDistributor(
      owner,
      await router.getAddress(),
      treasury.address,
      lpRewardPool.address
    );

    await fd.connect(owner).authorizeMarket(market.address);
  });

  describe("receiveFee", () => {
    it("authorized market increments pendingFees", async () => {
      const amount = ethers.parseUnits("100", 6);
      await usdc.mint(await fd.getAddress(), amount);
      await fd.connect(market).receiveFee(await usdc.getAddress(), amount);
      expect(await fd.pendingFees(await usdc.getAddress())).to.equal(amount);
    });

    it("owner can call receiveFee", async () => {
      const amount = ethers.parseUnits("50", 6);
      await usdc.mint(await fd.getAddress(), amount);
      await expect(fd.connect(owner).receiveFee(await usdc.getAddress(), amount)).to.not.be
        .reverted;
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

  describe("distributeFees", () => {
    const FEE = ethers.parseUnits("1000", 6);

    beforeEach(async () => {
      await usdc.mint(await fd.getAddress(), FEE);
      await fd.connect(market).receiveFee(await usdc.getAddress(), FEE);
    });

    it("splits 60/20/20 correctly", async () => {
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      const lpBefore = await usdc.balanceOf(lpRewardPool.address);

      await fd.connect(stranger).distributeFees(await usdc.getAddress());

      const buyback = (FEE * 6000n) / 10000n;
      const lp = (FEE * 2000n) / 10000n;
      const treas = FEE - buyback - lp;

      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + treas);
      expect(await usdc.balanceOf(lpRewardPool.address)).to.equal(lpBefore + lp);
    });

    it("calls buybackAndBurn on router with correct amount", async () => {
      const buyback = (FEE * 6000n) / 10000n;
      await expect(fd.connect(stranger).distributeFees(await usdc.getAddress()))
        .to.emit(router, "BuybackAndBurnCalled")
        .withArgs(await usdc.getAddress(), buyback);
    });

    it("emits FeesDistributed", async () => {
      const buyback = (FEE * 6000n) / 10000n;
      const lp = (FEE * 2000n) / 10000n;
      const treas = FEE - buyback - lp;
      await expect(fd.connect(stranger).distributeFees(await usdc.getAddress()))
        .to.emit(fd, "FeesDistributed")
        .withArgs(await usdc.getAddress(), buyback, lp, treas);
    });

    it("resets pendingFees to zero", async () => {
      await fd.connect(stranger).distributeFees(await usdc.getAddress());
      expect(await fd.pendingFees(await usdc.getAddress())).to.equal(0);
    });

    it("reverts when nothing to distribute", async () => {
      await fd.connect(stranger).distributeFees(await usdc.getAddress());
      await expect(
        fd.connect(stranger).distributeFees(await usdc.getAddress())
      ).to.be.revertedWith("FeeDistributor: nothing to distribute");
    });
  });

  describe("updateSplit", () => {
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

  describe("authorizeMarket", () => {
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

  describe("updateAddresses", () => {
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
        fd
          .connect(owner)
          .updateAddresses(ethers.ZeroAddress, treasury.address, lpRewardPool.address)
      ).to.be.revertedWith("FeeDistributor: zero unitRouter");
    });
  });
});
