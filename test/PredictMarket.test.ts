import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  PredictMarket,
  MockERC20,
  FeeDistributor,
  MockUnitFlowRouter,
} from "../typechain-types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USDC_DEC = 6n;
const u = (n: number | string) => ethers.parseUnits(String(n), USDC_DEC);

const PROTOCOL_FEE = 100n; // 1%
const CLAIM_FEE = 50n;     // 0.5%
const BASIS = 10_000n;

function applyProtocolFee(amount: bigint): { fee: bigint; net: bigint } {
  const fee = (amount * PROTOCOL_FEE) / BASIS;
  return { fee, net: amount - fee };
}

async function deployFeeDistributor(
  owner: SignerWithAddress,
  router: string,
  treasury: string,
  lp: string,
  unitToken: string
): Promise<FeeDistributor> {
  const Impl = await ethers.getContractFactory("FeeDistributor");
  const impl = await Impl.deploy();
  const Proxy = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy"
  );
  const data = Impl.interface.encodeFunctionData("initialize", [
    router,
    treasury,
    lp,
    unitToken,
    owner.address,
  ]);
  const proxy = await Proxy.deploy(await impl.getAddress(), owner.address, data);
  return Impl.attach(await proxy.getAddress()) as FeeDistributor;
}

interface MarketFixture {
  market: PredictMarket;
  usdc: MockERC20;
  fd: FeeDistributor;
  factory: SignerWithAddress;
  resolver: SignerWithAddress;
  resolutionDate: number;
}

async function deployMarket(
  factory: SignerWithAddress,
  resolver: SignerWithAddress,
  fd: FeeDistributor,
  usdc: MockERC20,
  resolutionDate: number
): Promise<PredictMarket> {
  const marketId = ethers.keccak256(ethers.toUtf8Bytes("test-market"));
  const Market = await ethers.getContractFactory("PredictMarket");
  const m = await Market.connect(factory).deploy(
    marketId,
    factory.address,
    await fd.getAddress(),
    "Will ETH hit $5k?",
    "Description",
    "Crypto",
    ["eth", "price"],
    await usdc.getAddress(),
    resolutionDate,
    resolver.address,
    "manual",
    factory.address,
    PROTOCOL_FEE,
    CLAIM_FEE
  );
  return m as PredictMarket;
}

async function setup(): Promise<MarketFixture> {
  const [owner, factory, resolver, treasury, lp] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("MockERC20");
  const usdc = (await Token.deploy("Mock USDC", "USDC", 6)) as MockERC20;

  const Router = await ethers.getContractFactory("MockUnitFlowRouter");
  const router = await Router.deploy();

  const UnitToken = await ethers.getContractFactory("MockERC20");
  const unitToken = await UnitToken.deploy("Mock UNIT", "UNIT", 18);

  const fd = await deployFeeDistributor(
    owner,
    await router.getAddress(),
    treasury.address,
    lp.address,
    await unitToken.getAddress()
  );

  const now = await time.latest();
  const resolutionDate = now + 7 * 24 * 3600; // 1 week from now

  const market = await deployMarket(factory, resolver, fd, usdc, resolutionDate);
  await fd.connect(owner).authorizeMarket(await market.getAddress());

  // Seed 50/50 with 1000 USDC
  const seedAmount = u(1000);
  await usdc.mint(factory.address, seedAmount);
  await usdc.connect(factory).transfer(await market.getAddress(), seedAmount);
  await market.connect(factory).seedLiquidity(seedAmount);

  return { market, usdc, fd, factory, resolver, resolutionDate };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PredictMarket", () => {
  let ctx: MarketFixture;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    [, , , , , user1, user2, user3] = signers;
    ctx = await setup();

    // Fund users
    for (const u_ of [user1, user2, user3]) {
      await ctx.usdc.mint(u_.address, u(100_000));
      await ctx.usdc.connect(u_).approve(await ctx.market.getAddress(), ethers.MaxUint256);
    }
  });

  // ─── seedLiquidity ───────────────────────────────────────────────────────────

  describe("seedLiquidity", () => {
    it("only factory can seed", async () => {
      const Market = await ethers.getContractFactory("PredictMarket");
      const now = await time.latest();
      const m = await deployMarket(
        ctx.factory,
        ctx.resolver,
        ctx.fd,
        ctx.usdc,
        now + 3600
      );
      await ctx.usdc.mint(user1.address, u(1000));
      await ctx.usdc.connect(user1).transfer(await m.getAddress(), u(1000));
      await expect(m.connect(user1).seedLiquidity(u(1000))).to.be.revertedWith(
        "PredictMarket: not factory"
      );
    });

    it("splits 50/50 and sets seeded flag", async () => {
      expect(await ctx.market.seeded()).to.be.true;
      expect(await ctx.market.yesPool()).to.equal(u(500));
      expect(await ctx.market.noPool()).to.equal(u(500));
    });

    it("reverts if already seeded", async () => {
      await ctx.usdc.mint(ctx.factory.address, u(1000));
      await ctx.usdc.connect(ctx.factory).transfer(await ctx.market.getAddress(), u(1000));
      await expect(
        ctx.market.connect(ctx.factory).seedLiquidity(u(1000))
      ).to.be.revertedWith("PredictMarket: already seeded");
    });

    it("reverts if below minimum liquidity", async () => {
      const Market = await ethers.getContractFactory("PredictMarket");
      const now = await time.latest();
      const m = await deployMarket(
        ctx.factory,
        ctx.resolver,
        ctx.fd,
        ctx.usdc,
        now + 3600
      );
      const tiny = u(5); // 5 USDC < 10 USDC minimum
      await ctx.usdc.mint(ctx.factory.address, tiny);
      await ctx.usdc.connect(ctx.factory).transfer(await m.getAddress(), tiny);
      await expect(m.connect(ctx.factory).seedLiquidity(tiny)).to.be.revertedWith(
        "PredictMarket: liquidity below minimum"
      );
    });

    it("emits LiquiditySeeded", async () => {
      const Market = await ethers.getContractFactory("PredictMarket");
      const now = await time.latest();
      const m = await deployMarket(
        ctx.factory,
        ctx.resolver,
        ctx.fd,
        ctx.usdc,
        now + 3600
      );
      const amt = u(1000);
      await ctx.usdc.mint(ctx.factory.address, amt);
      await ctx.usdc.connect(ctx.factory).transfer(await m.getAddress(), amt);
      await expect(m.connect(ctx.factory).seedLiquidity(amt))
        .to.emit(m, "LiquiditySeeded")
        .withArgs(amt - amt / 2n, amt / 2n);
    });
  });

  // ─── stakeYes ────────────────────────────────────────────────────────────────

  describe("stakeYes", () => {
    it("correct AMM math and fee on YES stake", async () => {
      const stakeAmt = u(100);
      const { fee, net } = applyProtocolFee(stakeAmt);

      const yesBefore = await ctx.market.yesPool();
      const noBefore = await ctx.market.noPool();
      const expectedShares = (net * noBefore) / yesBefore;

      await ctx.market.connect(user1).stakeYes(stakeAmt);

      const pos = await ctx.market.getUserPosition(user1.address);
      expect(pos.yesShares).to.equal(expectedShares);
      expect(await ctx.market.yesPool()).to.equal(yesBefore + net);
      expect(await ctx.market.noPool()).to.equal(noBefore);
    });

    it("routes protocol fee to FeeDistributor", async () => {
      const stakeAmt = u(100);
      const { fee } = applyProtocolFee(stakeAmt);
      const fdAddr = await ctx.fd.getAddress();
      const usdcAddr = await ctx.usdc.getAddress();

      const pendingBefore = await ctx.fd.pendingFees(usdcAddr);
      await ctx.market.connect(user1).stakeYes(stakeAmt);
      expect(await ctx.fd.pendingFees(usdcAddr)).to.equal(pendingBefore + fee);
    });

    it("emits Staked event", async () => {
      const stakeAmt = u(100);
      await expect(ctx.market.connect(user1).stakeYes(stakeAmt)).to.emit(
        ctx.market,
        "Staked"
      );
    });

    it("enforces minimum stake of 1e6", async () => {
      await expect(ctx.market.connect(user1).stakeYes(u(0.5))).to.be.revertedWith(
        "PredictMarket: below minimum stake"
      );
    });

    it("reverts after resolutionDate", async () => {
      await time.increaseTo(ctx.resolutionDate + 1);
      await expect(ctx.market.connect(user1).stakeYes(u(10))).to.be.revertedWith(
        "PredictMarket: past resolution date"
      );
    });

    it("reverts if market is resolved", async () => {
      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(true);
      await expect(ctx.market.connect(user1).stakeYes(u(10))).to.be.revertedWith(
        "PredictMarket: already resolved"
      );
    });
  });

  // ─── stakeNo ─────────────────────────────────────────────────────────────────

  describe("stakeNo", () => {
    it("correct AMM math and fee on NO stake", async () => {
      const stakeAmt = u(100);
      const { fee, net } = applyProtocolFee(stakeAmt);

      const yesBefore = await ctx.market.yesPool();
      const noBefore = await ctx.market.noPool();
      const expectedShares = (net * yesBefore) / noBefore;

      await ctx.market.connect(user1).stakeNo(stakeAmt);

      const pos = await ctx.market.getUserPosition(user1.address);
      expect(pos.noShares).to.equal(expectedShares);
      expect(await ctx.market.noPool()).to.equal(noBefore + net);
      expect(await ctx.market.yesPool()).to.equal(yesBefore);
    });

    it("enforces minimum stake", async () => {
      await expect(ctx.market.connect(user1).stakeNo(500_000n)).to.be.revertedWith(
        "PredictMarket: below minimum stake"
      );
    });

    it("reverts after resolutionDate", async () => {
      await time.increaseTo(ctx.resolutionDate + 1);
      await expect(ctx.market.connect(user1).stakeNo(u(10))).to.be.revertedWith(
        "PredictMarket: past resolution date"
      );
    });
  });

  // ─── getOdds ─────────────────────────────────────────────────────────────────

  describe("getOdds", () => {
    it("returns 5000/5000 on equal pools", async () => {
      const [yes, no] = await ctx.market.getOdds();
      expect(yes).to.equal(5000);
      expect(no).to.equal(5000);
    });

    it("odds shift correctly after YES stake", async () => {
      await ctx.market.connect(user1).stakeYes(u(100));
      const [yes, no] = await ctx.market.getOdds();
      // After YES stake, yesPool grows → noPool/total < 0.5 → yesOdds < 5000
      expect(yes).to.be.lt(5000);
      expect(no).to.be.gt(5000);
      expect(yes + no).to.equal(10000);
    });

    it("odds shift correctly after NO stake", async () => {
      await ctx.market.connect(user1).stakeNo(u(100));
      const [yes, no] = await ctx.market.getOdds();
      expect(yes).to.be.gt(5000);
      expect(no).to.be.lt(5000);
      expect(yes + no).to.equal(10000);
    });
  });

  // ─── resolveMarket ───────────────────────────────────────────────────────────

  describe("resolveMarket", () => {
    it("resolver can resolve after resolutionDate", async () => {
      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(true);
      expect(await ctx.market.resolved()).to.be.true;
      expect(await ctx.market.outcome()).to.be.true;
    });

    it("non-resolver reverts", async () => {
      await time.increaseTo(ctx.resolutionDate);
      await expect(ctx.market.connect(user1).resolveMarket(true)).to.be.revertedWith(
        "PredictMarket: not resolver"
      );
    });

    it("reverts before resolutionDate", async () => {
      await expect(
        ctx.market.connect(ctx.resolver).resolveMarket(true)
      ).to.be.revertedWith("PredictMarket: before resolution date");
    });

    it("reverts if already resolved", async () => {
      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(true);
      await expect(
        ctx.market.connect(ctx.resolver).resolveMarket(false)
      ).to.be.revertedWith("PredictMarket: already resolved");
    });

    it("emits MarketResolved", async () => {
      await time.increaseTo(ctx.resolutionDate);
      await expect(ctx.market.connect(ctx.resolver).resolveMarket(true))
        .to.emit(ctx.market, "MarketResolved")
        .withArgs(true, ctx.resolver.address);
    });
  });

  // ─── claimReward ─────────────────────────────────────────────────────────────

  describe("claimReward", () => {
    beforeEach(async () => {
      // Stake within pool cap (10% of 1000 USDC = 100 USDC)
      const cap = await ctx.market.getMaxStake();
      const yesAmt = cap;           // 100 USDC
      const noAmt  = cap / 2n;      // 50 USDC (pool grows after YES stake)

      await ctx.market.connect(user1).stakeYes(yesAmt);
      // Recalculate cap after pool changed
      const cap2 = await ctx.market.getMaxStake();
      const noStake = noAmt < cap2 ? noAmt : cap2;
      await ctx.market.connect(user2).stakeNo(noStake);

      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(true); // YES wins
    });

    it("YES winner receives correct pro-rata payout minus claim fee", async () => {
      const pos = await ctx.market.getUserPosition(user1.address);
      const totalYes = await ctx.market.totalYesShares();
      const totalPool = (await ctx.market.yesPool()) + (await ctx.market.noPool());

      const gross = (pos.yesShares * totalPool) / totalYes;
      const fee = (gross * CLAIM_FEE) / BASIS;
      const net = gross - fee;

      const balBefore = await ctx.usdc.balanceOf(user1.address);
      await ctx.market.connect(user1).claimReward();
      const balAfter = await ctx.usdc.balanceOf(user1.address);

      expect(balAfter - balBefore).to.equal(net);
    });

    it("routes claim fee to FeeDistributor", async () => {
      const pos = await ctx.market.getUserPosition(user1.address);
      const totalYes = await ctx.market.totalYesShares();
      const totalPool = (await ctx.market.yesPool()) + (await ctx.market.noPool());
      const gross = (pos.yesShares * totalPool) / totalYes;
      const claimFee = (gross * CLAIM_FEE) / BASIS;

      const pendingBefore = await ctx.fd.pendingFees(await ctx.usdc.getAddress());
      await ctx.market.connect(user1).claimReward();
      expect(await ctx.fd.pendingFees(await ctx.usdc.getAddress())).to.equal(
        pendingBefore + claimFee
      );
    });

    it("emits Claimed event", async () => {
      await expect(ctx.market.connect(user1).claimReward()).to.emit(
        ctx.market,
        "Claimed"
      );
    });

    it("reverts on double claim", async () => {
      await ctx.market.connect(user1).claimReward();
      await expect(ctx.market.connect(user1).claimReward()).to.be.revertedWith(
        "PredictMarket: already claimed"
      );
    });

    it("NO staker cannot claim when YES wins", async () => {
      await expect(ctx.market.connect(user2).claimReward()).to.be.revertedWith(
        "PredictMarket: no winning position"
      );
    });

    it("reverts if market not resolved", async () => {
      const [owner] = await ethers.getSigners();
      const now = await time.latest();
      const m = await deployMarket(
        ctx.factory,
        ctx.resolver,
        ctx.fd,
        ctx.usdc,
        now + 3600
      );
      // Authorize the new market in FeeDistributor so staking works
      await ctx.fd.connect(owner).authorizeMarket(await m.getAddress());

      await ctx.usdc.mint(ctx.factory.address, u(1000));
      await ctx.usdc.connect(ctx.factory).transfer(await m.getAddress(), u(1000));
      await m.connect(ctx.factory).seedLiquidity(u(1000));
      await ctx.usdc.connect(user1).approve(await m.getAddress(), ethers.MaxUint256);
      await m.connect(user1).stakeYes(u(50));
      await expect(m.connect(user1).claimReward()).to.be.revertedWith(
        "PredictMarket: not resolved"
      );
    });
  });

  // ─── estimatePayout ──────────────────────────────────────────────────────────

  describe("estimatePayout", () => {
    it("matches actual claimReward output", async () => {
      const cap = await ctx.market.getMaxStake();
      await ctx.market.connect(user1).stakeYes(cap);
      const cap2 = await ctx.market.getMaxStake();
      await ctx.market.connect(user2).stakeNo(cap2 / 2n);

      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(true);

      const [gross, net, fee] = await ctx.market.estimatePayout(user1.address);

      const balBefore = await ctx.usdc.balanceOf(user1.address);
      await ctx.market.connect(user1).claimReward();
      const balAfter = await ctx.usdc.balanceOf(user1.address);

      expect(balAfter - balBefore).to.equal(net);
      expect(gross - fee).to.equal(net);
    });

    it("returns zeros before resolution", async () => {
      await ctx.market.connect(user1).stakeYes(u(100));
      const [gross, net, fee] = await ctx.market.estimatePayout(user1.address);
      expect(gross).to.equal(0);
      expect(net).to.equal(0);
      expect(fee).to.equal(0);
    });

    it("returns zeros for loser", async () => {
      await ctx.market.connect(user1).stakeYes(u(100));
      await ctx.market.connect(user2).stakeNo(u(100));
      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(true);

      const [gross, net, fee] = await ctx.market.estimatePayout(user2.address);
      expect(gross).to.equal(0);
      expect(net).to.equal(0);
      expect(fee).to.equal(0);
    });
  });

  // ─── AMM edge cases ──────────────────────────────────────────────────────────

  describe("AMM edge cases", () => {
    it("stake at exactly pool cap (10%) issues shares and updates pool", async () => {
      // Pool = 1000 USDC, 10% = 100 USDC
      const maxStake = await ctx.market.getMaxStake();
      await ctx.usdc.mint(user1.address, maxStake);
      await ctx.usdc.connect(user1).approve(await ctx.market.getAddress(), ethers.MaxUint256);
      await expect(ctx.market.connect(user1).stakeYes(maxStake)).to.not.be.reverted;
      const pos = await ctx.market.getUserPosition(user1.address);
      expect(pos.yesShares).to.be.gt(0);
    });

    it("stake above pool cap reverts", async () => {
      const maxStake = await ctx.market.getMaxStake();
      const overCap = maxStake + 1n;
      await ctx.usdc.mint(user1.address, overCap);
      await ctx.usdc.connect(user1).approve(await ctx.market.getAddress(), ethers.MaxUint256);
      await expect(ctx.market.connect(user1).stakeYes(overCap)).to.be.revertedWith(
        "PredictMarket: stake exceeds pool cap"
      );
    });

    it("highly lopsided pool: NO stake still issues shares", async () => {
      // Skew pool by staking at cap repeatedly
      for (let i = 0; i < 5; i++) {
        const maxStake = await ctx.market.getMaxStake();
        await ctx.usdc.mint(user1.address, maxStake);
        await ctx.usdc.connect(user1).approve(await ctx.market.getAddress(), ethers.MaxUint256);
        await ctx.market.connect(user1).stakeYes(maxStake);
      }
      // Now stake NO on lopsided pool
      const maxStake = await ctx.market.getMaxStake();
      const noStake = maxStake < u(10) ? maxStake : u(10);
      await expect(ctx.market.connect(user2).stakeNo(noStake)).to.not.be.reverted;
      const pos = await ctx.market.getUserPosition(user2.address);
      expect(pos.noShares).to.be.gt(0);
    });

    it("multiple users stake and odds sum to 10000 after each stake", async () => {
      // Use 5% of pool each time to stay within the 10% cap
      for (const [usr, side] of [
        [user1, "yes"],
        [user2, "no"],
        [user3, "yes"],
      ] as [SignerWithAddress, string][]) {
        const poolTotal = (await ctx.market.yesPool()) + (await ctx.market.noPool());
        const amt = (poolTotal * 500n) / 10000n; // 5% of pool
        if (side === "yes") await ctx.market.connect(usr).stakeYes(amt);
        else await ctx.market.connect(usr).stakeNo(amt);

        const [yes, no] = await ctx.market.getOdds();
        expect(yes + no).to.equal(10000);
      }
    });

  });

  // ─── Reentrancy simulation ────────────────────────────────────────────────────

  describe("reentrancy protection", () => {
    it("claimReward cannot be called twice (double-claim reverts)", async () => {
      await ctx.market.connect(user1).stakeYes(u(100));
      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(true);

      // First claim succeeds
      await ctx.market.connect(user1).claimReward();

      // Second call — simulates what a re-entrant attacker would attempt
      await expect(ctx.market.connect(user1).claimReward()).to.be.revertedWith(
        "PredictMarket: already claimed"
      );
    });

    it("MockReentrantClaimer attack reverts", async () => {
      const [owner] = await ethers.getSigners();
      const Attacker = await ethers.getContractFactory("MockReentrantClaimer");
      const attacker = await Attacker.deploy(await ctx.market.getAddress());

      // Authorize attacker's market interactions via FeeDistributor
      await ctx.fd.connect(owner).authorizeMarket(await ctx.market.getAddress());

      // Stake within pool cap (10% of 1000 USDC pool = 100 USDC)
      const stakeAmt = await ctx.market.getMaxStake();
      await ctx.usdc.mint(await attacker.getAddress(), stakeAmt);
      await attacker.approveMarket(await ctx.usdc.getAddress());
      await attacker.stakeYes(stakeAmt);

      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(true);

      // attack() calls claimReward once; the fallback is not triggered by MockERC20
      // but the claimed flag is set, so any subsequent call reverts
      await attacker.attack();
      await expect(attacker.attack()).to.be.reverted;
    });
  });

  // ─── Participant tracking ─────────────────────────────────────────────────────

  describe("participant tracking", () => {
    it("tracks unique participants", async () => {
      await ctx.market.connect(user1).stakeYes(u(10));
      await ctx.market.connect(user1).stakeNo(u(10)); // same user again
      await ctx.market.connect(user2).stakeYes(u(10));

      expect(await ctx.market.getParticipantCount()).to.equal(2);
    });

    it("getParticipants returns all unique addresses", async () => {
      await ctx.market.connect(user1).stakeYes(u(10));
      await ctx.market.connect(user2).stakeNo(u(10));
      const participants = await ctx.market.getParticipants();
      expect(participants).to.include(user1.address);
      expect(participants).to.include(user2.address);
    });
  });

  // ─── emergencyWithdraw ────────────────────────────────────────────────────────

  describe("emergencyWithdraw", () => {
    it("reverts when market has winners (normal case)", async () => {
      // user1 stakes YES, user2 stakes NO — both sides have shares
      await ctx.market.connect(user1).stakeYes(u(10));
      await ctx.market.connect(user2).stakeNo(u(10));
      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(true); // YES wins

      // user2 lost but cannot use emergencyWithdraw — winners exist
      await expect(
        ctx.market.connect(user2).emergencyWithdraw()
      ).to.be.revertedWith("PredictMarket: market has winners, use claimReward");
    });

    it("reverts before resolution", async () => {
      await ctx.market.connect(user1).stakeYes(u(10));
      await expect(
        ctx.market.connect(user1).emergencyWithdraw()
      ).to.be.revertedWith("PredictMarket: not resolved");
    });

    it("allows staker to recover funds when winning side has zero shares (M-1 fix)", async () => {
      // Only YES stakers — nobody staked NO. Resolve NO wins → totalNoShares == 0.
      await ctx.market.connect(user1).stakeYes(u(100));
      await ctx.market.connect(user2).stakeYes(u(50));
      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(false); // NO wins, but nobody staked NO

      const staked1 = (await ctx.market.getUserPosition(user1.address)).totalStaked;
      const balBefore = await ctx.usdc.balanceOf(user1.address);
      await ctx.market.connect(user1).emergencyWithdraw();
      const balAfter = await ctx.usdc.balanceOf(user1.address);

      expect(balAfter - balBefore).to.equal(staked1);
    });

    it("reverts on double emergencyWithdraw", async () => {
      await ctx.market.connect(user1).stakeYes(u(100));
      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(false);

      await ctx.market.connect(user1).emergencyWithdraw();
      await expect(
        ctx.market.connect(user1).emergencyWithdraw()
      ).to.be.revertedWith("PredictMarket: already claimed");
    });

    it("reverts for address with no stake", async () => {
      await ctx.market.connect(user1).stakeYes(u(100));
      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(false);

      // user2 never staked
      await expect(
        ctx.market.connect(user2).emergencyWithdraw()
      ).to.be.revertedWith("PredictMarket: no stake to recover");
    });

    it("emits EmergencyWithdraw event", async () => {
      await ctx.market.connect(user1).stakeYes(u(100));
      await time.increaseTo(ctx.resolutionDate);
      await ctx.market.connect(ctx.resolver).resolveMarket(false);

      const staked = (await ctx.market.getUserPosition(user1.address)).totalStaked;
      await expect(ctx.market.connect(user1).emergencyWithdraw())
        .to.emit(ctx.market, "EmergencyWithdraw")
        .withArgs(user1.address, staked);
    });
  });
});
