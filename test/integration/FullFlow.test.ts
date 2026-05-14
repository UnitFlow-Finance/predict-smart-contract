/**
 * FullFlow integration test
 *
 * Exercises the complete lifecycle across all four contracts:
 *   Deploy → CreateMarket → Stake (5 users) → Resolve → Claim → DistributeFees
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  FeeDistributor,
  PredictMarketFactory,
  PredictOracle,
  PredictMarket,
  MockERC20,
  MockUnitFlowRouter,
} from "../../typechain-types";

const u = (n: number | string) => ethers.parseUnits(String(n), 6);
const BASIS = 10_000n;
const PROTOCOL_FEE_RATE = 100n; // 1%
const CLAIM_FEE_RATE = 50n;     // 0.5%

// ─── Deployment helpers ───────────────────────────────────────────────────────

async function deployProxy<T>(
  contractName: string,
  owner: SignerWithAddress,
  initArgs: unknown[]
): Promise<T> {
  const Impl = await ethers.getContractFactory(contractName);
  const impl = await Impl.deploy();
  const Proxy = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy"
  );
  const data = Impl.interface.encodeFunctionData("initialize", initArgs);
  const proxy = await Proxy.deploy(await impl.getAddress(), owner.address, data);
  return Impl.attach(await proxy.getAddress()) as T;
}

interface Suite {
  owner: SignerWithAddress;
  resolver: SignerWithAddress;
  treasury: SignerWithAddress;
  lpPool: SignerWithAddress;
  yesUsers: SignerWithAddress[];  // 3 YES stakers
  noUsers: SignerWithAddress[];   // 2 NO stakers
  usdc: MockERC20;
  eurc: MockERC20;
  router: MockUnitFlowRouter;
  fd: FeeDistributor;
  oracle: PredictOracle;
  factory: PredictMarketFactory;
  market: PredictMarket;
  resolutionDate: number;
}

async function deployAll(): Promise<Suite> {
  const signers = await ethers.getSigners();
  const [owner, resolver, treasury, lpPool, y1, y2, y3, n1, n2] = signers;

  // Tokens
  const Token = await ethers.getContractFactory("MockERC20");
  const usdc = (await Token.deploy("Mock USDC", "USDC", 6)) as MockERC20;
  const eurc = (await Token.deploy("Mock EURC", "EURC", 6)) as MockERC20;

  // Router
  const Router = await ethers.getContractFactory("MockUnitFlowRouter");
  const router = (await Router.deploy()) as MockUnitFlowRouter;

  // FeeDistributor
  const fd = await deployProxy<FeeDistributor>("FeeDistributor", owner, [
    await router.getAddress(),
    treasury.address,
    lpPool.address,
    owner.address,
  ]);

  // PredictOracle
  const oracle = await deployProxy<PredictOracle>("PredictOracle", owner, [
    owner.address,
  ]);
  await oracle.connect(owner).addResolver(resolver.address);

  // PredictMarketFactory
  const factory = await deployProxy<PredictMarketFactory>("PredictMarketFactory", owner, [
    await fd.getAddress(),
    await oracle.getAddress(),
    await usdc.getAddress(),
    await eurc.getAddress(),
    owner.address,
  ]);

  // Grant factory permission to call receiveFee and authorizeMarket on FeeDistributor
  await fd.connect(owner).grantCallerRole(await factory.getAddress());
  await fd.connect(owner).authorizeMarket(await factory.getAddress());

  // Fund creator (owner) for market creation
  const CREATION_TOTAL = u(5) + u(10_000); // 5 USDC fee + 10k initial liquidity
  await usdc.mint(owner.address, CREATION_TOTAL);
  await usdc.connect(owner).approve(await factory.getAddress(), ethers.MaxUint256);

  const now = await time.latest();
  const resolutionDate = now + 7 * 24 * 3600;

  // Create market — resolver is the oracle contract so it can call resolveMarket
  const tx = await factory.connect(owner).createMarket({
    question: "Will ETH hit $5,000 before July 1, 2025?",
    description: "ETH price prediction market",
    category: "Crypto",
    tags: ["eth", "price"],
    currency: await usdc.getAddress(),
    resolutionDate,
    resolver: await oracle.getAddress(), // oracle contract is the on-chain resolver
    oracleSource: "manual",
    initialLiquidity: u(10_000),
  });
  await tx.wait();

  const markets = await factory.getAllMarkets();
  const Market = await ethers.getContractFactory("PredictMarket");
  const market = Market.attach(markets[0]) as PredictMarket;

  // Fund stakers
  for (const staker of [y1, y2, y3, n1, n2]) {
    await usdc.mint(staker.address, u(10_000));
    await usdc.connect(staker).approve(await market.getAddress(), ethers.MaxUint256);
  }

  return {
    owner, resolver, treasury, lpPool,
    yesUsers: [y1, y2, y3],
    noUsers: [n1, n2],
    usdc, eurc, router, fd, oracle, factory, market, resolutionDate,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("FullFlow Integration", () => {
  let s: Suite;

  // Stake amounts
  const YES_STAKES = [u(500), u(300), u(200)];  // y1, y2, y3
  const NO_STAKES  = [u(400), u(100)];           // n1, n2

  before(async () => {
    s = await deployAll();
  });

  // ─── 1. Deployment ──────────────────────────────────────────────────────────

  it("deploys all 4 contracts correctly", async () => {
    expect(await s.factory.getMarketCount()).to.equal(1);
    expect(await s.market.seeded()).to.be.true;
    expect(await s.oracle.authorizedResolvers(s.resolver.address)).to.be.true;
    expect(await s.fd.authorizedMarkets(await s.market.getAddress())).to.be.true;
  });

  it("market is seeded 50/50 with 10,000 USDC", async () => {
    expect(await s.market.yesPool()).to.equal(u(5_000));
    expect(await s.market.noPool()).to.equal(u(5_000));
  });

  // ─── 2. Staking ─────────────────────────────────────────────────────────────

  it("3 YES users stake successfully", async () => {
    for (let i = 0; i < 3; i++) {
      await s.market.connect(s.yesUsers[i]).stakeYes(YES_STAKES[i]);
    }
    expect(await s.market.getParticipantCount()).to.equal(3);
  });

  it("2 NO users stake successfully", async () => {
    for (let i = 0; i < 2; i++) {
      await s.market.connect(s.noUsers[i]).stakeNo(NO_STAKES[i]);
    }
    expect(await s.market.getParticipantCount()).to.equal(5);
  });

  it("AMM odds update correctly after all stakes", async () => {
    const [yes, no] = await s.market.getOdds();
    // YES pool grew more than NO pool → yesOdds (= noPool/total) should be < 5000
    expect(yes + no).to.equal(10_000);
    expect(yes).to.be.lt(5_000); // YES is now more expensive (lower implied prob)
  });

  it("protocol fees are routed to FeeDistributor after each stake", async () => {
    const totalStaked =
      YES_STAKES.reduce((a, b) => a + b, 0n) +
      NO_STAKES.reduce((a, b) => a + b, 0n);
    const expectedFees = (totalStaked * PROTOCOL_FEE_RATE) / BASIS;
    const pending = await s.fd.pendingFees(await s.usdc.getAddress());
    // pending also includes the 5 USDC creation fee
    expect(pending).to.be.gte(expectedFees);
  });

  // ─── 3. Resolution ──────────────────────────────────────────────────────────

  it("oracle cannot finalize resolution before dispute window expires", async () => {
    // Propose a resolution on a fresh stub to test the window guard
    // (the main market hasn't been proposed yet at this point in the flow)
    const Stub = await ethers.getContractFactory("MockMarketStub");
    const stub = await Stub.deploy(await s.oracle.getAddress());
    await s.oracle.connect(s.resolver).proposeResolution(await stub.getAddress(), true);
    await expect(
      s.oracle.connect(s.owner).finalizeResolution(await stub.getAddress())
    ).to.be.revertedWith("PredictOracle: dispute window still open");
  });

  it("oracle proposes resolution after advancing time", async () => {
    await time.increaseTo(s.resolutionDate);
    await s.oracle.connect(s.resolver).proposeResolution(
      await s.market.getAddress(),
      true // YES wins
    );
    const res = await s.oracle.resolutions(await s.market.getAddress());
    expect(res.status).to.equal(1); // Proposed
  });

  it("dispute window is open immediately after proposal", async () => {
    // Should not revert — window is still open
    await expect(
      s.oracle.connect(s.noUsers[0]).disputeResolution(await s.market.getAddress())
    ).to.not.be.reverted;
  });

  it("owner overrides the disputed resolution to YES", async () => {
    await s.oracle.connect(s.owner).overrideResolution(
      await s.market.getAddress(),
      true // confirm YES wins
    );
    expect(await s.market.resolved()).to.be.true;
    expect(await s.market.outcome()).to.be.true;
  });

  // ─── 4. Claims ──────────────────────────────────────────────────────────────

  it("all YES stakers claim correct pro-rata payouts", async () => {
    const totalYesShares = await s.market.totalYesShares();
    const totalPool = (await s.market.yesPool()) + (await s.market.noPool());

    for (let i = 0; i < 3; i++) {
      const pos = await s.market.getUserPosition(s.yesUsers[i].address);
      const gross = (pos.yesShares * totalPool) / totalYesShares;
      const fee = (gross * CLAIM_FEE_RATE) / BASIS;
      const expectedNet = gross - fee;

      const balBefore = await s.usdc.balanceOf(s.yesUsers[i].address);
      await s.market.connect(s.yesUsers[i]).claimReward();
      const balAfter = await s.usdc.balanceOf(s.yesUsers[i].address);

      expect(balAfter - balBefore).to.equal(expectedNet);
    }
  });

  it("claim fees are routed to FeeDistributor", async () => {
    // pendingFees should have grown after claims
    const pending = await s.fd.pendingFees(await s.usdc.getAddress());
    expect(pending).to.be.gt(0);
  });

  it("NO stakers cannot claim when YES wins", async () => {
    for (const noUser of s.noUsers) {
      await expect(s.market.connect(noUser).claimReward()).to.be.revertedWith(
        "PredictMarket: no winning position"
      );
    }
  });

  it("double-claim reverts for YES stakers", async () => {
    for (const yesUser of s.yesUsers) {
      await expect(s.market.connect(yesUser).claimReward()).to.be.revertedWith(
        "PredictMarket: already claimed"
      );
    }
  });

  // ─── 5. Fee Distribution ────────────────────────────────────────────────────

  it("distributeFees routes 60/20/20 correctly", async () => {
    const usdcAddr = await s.usdc.getAddress();
    const total = await s.fd.pendingFees(usdcAddr);
    expect(total).to.be.gt(0);

    const treasuryBefore = await s.usdc.balanceOf(s.treasury.address);
    const lpBefore = await s.usdc.balanceOf(s.lpPool.address);

    await s.fd.connect(s.owner).distributeFees(usdcAddr);

    const buyback = (total * 6000n) / BASIS;
    const lp = (total * 2000n) / BASIS;
    const treas = total - buyback - lp;

    expect(await s.usdc.balanceOf(s.treasury.address)).to.equal(treasuryBefore + treas);
    expect(await s.usdc.balanceOf(s.lpPool.address)).to.equal(lpBefore + lp);
    expect(await s.fd.pendingFees(usdcAddr)).to.equal(0);
  });

  it("buybackAndBurn was called on the router", async () => {
    // Router received tokens during distributeFees — verify its balance is non-zero
    const routerBal = await s.usdc.balanceOf(await s.router.getAddress());
    expect(routerBal).to.be.gt(0);
  });

  // ─── 6. Post-resolution invariants ──────────────────────────────────────────

  it("staking is blocked after resolution (notResolved guard fires)", async () => {
    // Market is resolved; notResolved modifier fires before beforeResolutionDate
    await expect(
      s.market.connect(s.yesUsers[0]).stakeYes(u(10))
    ).to.be.revertedWith("PredictMarket: already resolved");
  });

  it("market participant count is exactly 5", async () => {
    expect(await s.market.getParticipantCount()).to.equal(5);
  });

  it("estimatePayout returns zero for all claimed winners", async () => {
    for (const yesUser of s.yesUsers) {
      const [gross] = await s.market.estimatePayout(yesUser.address);
      expect(gross).to.equal(0); // already claimed
    }
  });
});
