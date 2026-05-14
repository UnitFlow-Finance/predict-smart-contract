import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  PredictMarketFactory,
  FeeDistributor,
  MockERC20,
  MockUnitFlowRouter,
} from "../typechain-types";

const u = (n: number | string) => ethers.parseUnits(String(n), 6);

async function deployFeeDistributor(
  owner: SignerWithAddress,
  router: string,
  treasury: string,
  lp: string
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
    owner.address,
  ]);
  const proxy = await Proxy.deploy(await impl.getAddress(), owner.address, data);
  return Impl.attach(await proxy.getAddress()) as FeeDistributor;
}

async function deployFactory(
  owner: SignerWithAddress,
  fd: FeeDistributor,
  oracle: string,
  usdc: string,
  eurc: string
): Promise<PredictMarketFactory> {
  const Impl = await ethers.getContractFactory("PredictMarketFactory");
  const impl = await Impl.deploy();
  const Proxy = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy"
  );
  const data = Impl.interface.encodeFunctionData("initialize", [
    await fd.getAddress(),
    oracle,
    usdc,
    eurc,
    owner.address,
  ]);
  const proxy = await Proxy.deploy(await impl.getAddress(), owner.address, data);
  return Impl.attach(await proxy.getAddress()) as PredictMarketFactory;
}

describe("PredictMarketFactory", () => {
  let owner: SignerWithAddress;
  let creator: SignerWithAddress;
  let resolver: SignerWithAddress;
  let treasury: SignerWithAddress;
  let lp: SignerWithAddress;
  let stranger: SignerWithAddress;

  let factory: PredictMarketFactory;
  let fd: FeeDistributor;
  let usdc: MockERC20;
  let eurc: MockERC20;
  let oracleAddr: string;

  let resolutionDate: number;

  const CREATION_FEE = u(5);
  const INIT_LIQ = u(1000);

  function defaultParams(overrides: Partial<any> = {}) {
    return {
      question: "Will ETH hit $5k?",
      description: "ETH price prediction",
      category: "Crypto",
      tags: ["eth", "price"],
      currency: usdc.target as string,
      resolutionDate,
      resolver: resolver.address,
      oracleSource: "manual",
      initialLiquidity: INIT_LIQ,
      ...overrides,
    };
  }

  beforeEach(async () => {
    [owner, creator, resolver, treasury, lp, stranger] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    usdc = (await Token.deploy("Mock USDC", "USDC", 6)) as MockERC20;
    eurc = (await Token.deploy("Mock EURC", "EURC", 6)) as MockERC20;

    const Router = await ethers.getContractFactory("MockUnitFlowRouter");
    const router = await Router.deploy();

    fd = await deployFeeDistributor(
      owner,
      await router.getAddress(),
      treasury.address,
      lp.address
    );

    // Use a random address as oracle stub (factory only stores the address)
    oracleAddr = ethers.Wallet.createRandom().address;

    factory = await deployFactory(
      owner,
      fd,
      oracleAddr,
      await usdc.getAddress(),
      await eurc.getAddress()
    );

    // Grant factory permission to call authorizeMarket and receiveFee on FeeDistributor
    await fd.connect(owner).grantCallerRole(await factory.getAddress());
    await fd.connect(owner).authorizeMarket(await factory.getAddress());

    const now = await time.latest();
    resolutionDate = now + 7 * 24 * 3600;

    // Fund creator
    await usdc.mint(creator.address, u(1_000_000));
    await eurc.mint(creator.address, u(1_000_000));
    await usdc.connect(creator).approve(await factory.getAddress(), ethers.MaxUint256);
    await eurc.connect(creator).approve(await factory.getAddress(), ethers.MaxUint256);
  });

  // ─── Initialization ──────────────────────────────────────────────────────────

  describe("initialization", () => {
    it("initializes with correct fee config", async () => {
      expect(await factory.protocolFeeRate()).to.equal(100);
      expect(await factory.claimFeeRate()).to.equal(50);
      expect(await factory.marketCreationFee()).to.equal(CREATION_FEE);
    });

    it("stores correct addresses", async () => {
      expect(await factory.feeDistributor()).to.equal(await fd.getAddress());
      expect(await factory.oracle()).to.equal(oracleAddr);
      expect(await factory.usdc()).to.equal(await usdc.getAddress());
      expect(await factory.eurc()).to.equal(await eurc.getAddress());
    });
  });

  // ─── createMarket ────────────────────────────────────────────────────────────

  describe("createMarket", () => {
    it("valid params: deploys market and registers it", async () => {
      await factory.connect(creator).createMarket(defaultParams());
      expect(await factory.getMarketCount()).to.equal(1);
      const markets = await factory.getAllMarkets();
      expect(markets.length).to.equal(1);
      expect(markets[0]).to.not.equal(ethers.ZeroAddress);
    });

    it("emits MarketCreated with correct fields", async () => {
      const tx = await factory.connect(creator).createMarket(defaultParams());
      const receipt = await tx.wait();
      const iface = factory.interface;
      const log = receipt!.logs.find(
        (l) => l.topics[0] === iface.getEvent("MarketCreated")!.topicHash
      );
      expect(log).to.not.be.undefined;
    });

    it("collects creation fee + initial liquidity from creator", async () => {
      const balBefore = await usdc.balanceOf(creator.address);
      await factory.connect(creator).createMarket(defaultParams());
      const balAfter = await usdc.balanceOf(creator.address);
      expect(balBefore - balAfter).to.equal(CREATION_FEE + INIT_LIQ);
    });

    it("routes creation fee to FeeDistributor", async () => {
      const pendingBefore = await fd.pendingFees(await usdc.getAddress());
      await factory.connect(creator).createMarket(defaultParams());
      expect(await fd.pendingFees(await usdc.getAddress())).to.equal(
        pendingBefore + CREATION_FEE
      );
    });

    it("seeds market with correct 50/50 liquidity", async () => {
      await factory.connect(creator).createMarket(defaultParams());
      const markets = await factory.getAllMarkets();
      const Market = await ethers.getContractFactory("PredictMarket");
      const market = Market.attach(markets[0]) as any;
      expect(await market.yesPool()).to.equal(INIT_LIQ - INIT_LIQ / 2n);
      expect(await market.noPool()).to.equal(INIT_LIQ / 2n);
      expect(await market.seeded()).to.be.true;
    });

    it("rejects unsupported currency", async () => {
      const fakeCurrency = ethers.Wallet.createRandom().address;
      await expect(
        factory.connect(creator).createMarket(defaultParams({ currency: fakeCurrency }))
      ).to.be.revertedWith("Factory: unsupported currency");
    });

    it("rejects past resolutionDate", async () => {
      const past = (await time.latest()) - 1;
      await expect(
        factory.connect(creator).createMarket(defaultParams({ resolutionDate: past }))
      ).to.be.revertedWith("Factory: resolutionDate in past");
    });

    it("rejects initialLiquidity below 10e6", async () => {
      await expect(
        factory.connect(creator).createMarket(defaultParams({ initialLiquidity: u(5) }))
      ).to.be.revertedWith("Factory: initialLiquidity too low");
    });

    it("rejects empty question", async () => {
      await expect(
        factory.connect(creator).createMarket(defaultParams({ question: "" }))
      ).to.be.revertedWith("Factory: invalid question length");
    });

    it("rejects question longer than 200 chars", async () => {
      const longQ = "A".repeat(201);
      await expect(
        factory.connect(creator).createMarket(defaultParams({ question: longQ }))
      ).to.be.revertedWith("Factory: invalid question length");
    });

    it("accepts EURC as currency", async () => {
      await expect(
        factory
          .connect(creator)
          .createMarket(defaultParams({ currency: await eurc.getAddress() }))
      ).to.not.be.reverted;
    });

    it("increments market count on each creation", async () => {
      await factory.connect(creator).createMarket(defaultParams());
      await factory.connect(creator).createMarket(defaultParams({ question: "Will BTC hit $100k?" }));
      expect(await factory.getMarketCount()).to.equal(2);
    });
  });

  // ─── updateFeeConfig ─────────────────────────────────────────────────────────

  describe("updateFeeConfig", () => {
    it("owner can update fee config", async () => {
      await factory.connect(owner).updateFeeConfig(200, 100);
      expect(await factory.protocolFeeRate()).to.equal(200);
      expect(await factory.claimFeeRate()).to.equal(100);
    });

    it("emits FeeConfigUpdated", async () => {
      await expect(factory.connect(owner).updateFeeConfig(200, 100))
        .to.emit(factory, "FeeConfigUpdated")
        .withArgs(200, 100);
    });

    it("rejects protocolFeeRate > 500", async () => {
      await expect(factory.connect(owner).updateFeeConfig(501, 50)).to.be.revertedWith(
        "Factory: protocolFeeRate too high"
      );
    });

    it("rejects claimFeeRate > 500", async () => {
      await expect(factory.connect(owner).updateFeeConfig(100, 501)).to.be.revertedWith(
        "Factory: claimFeeRate too high"
      );
    });

    it("non-owner reverts", async () => {
      await expect(factory.connect(stranger).updateFeeConfig(200, 100)).to.be.reverted;
    });
  });

  // ─── pause / unpause ─────────────────────────────────────────────────────────

  describe("pause / unpause", () => {
    it("owner can pause", async () => {
      await factory.connect(owner).pause();
      await expect(
        factory.connect(creator).createMarket(defaultParams())
      ).to.be.revertedWithCustomError(factory, "EnforcedPause");
    });

    it("owner can unpause", async () => {
      await factory.connect(owner).pause();
      await factory.connect(owner).unpause();
      await expect(factory.connect(creator).createMarket(defaultParams())).to.not.be
        .reverted;
    });

    it("non-owner cannot pause", async () => {
      await expect(factory.connect(stranger).pause()).to.be.reverted;
    });
  });

  // ─── updateMarketCreationFee ──────────────────────────────────────────────────

  describe("updateMarketCreationFee", () => {
    it("owner updates creation fee", async () => {
      await factory.connect(owner).updateMarketCreationFee(u(10));
      expect(await factory.marketCreationFee()).to.equal(u(10));
    });

    it("emits MarketCreationFeeUpdated", async () => {
      await expect(factory.connect(owner).updateMarketCreationFee(u(10)))
        .to.emit(factory, "MarketCreationFeeUpdated")
        .withArgs(u(10));
    });

    it("non-owner reverts", async () => {
      await expect(factory.connect(stranger).updateMarketCreationFee(u(10))).to.be.reverted;
    });
  });

  // ─── updateFeeDistributor ─────────────────────────────────────────────────────

  describe("updateFeeDistributor", () => {
    it("owner updates feeDistributor", async () => {
      const newFd = ethers.Wallet.createRandom().address;
      await factory.connect(owner).updateFeeDistributor(newFd);
      expect(await factory.feeDistributor()).to.equal(newFd);
    });

    it("reverts on zero address", async () => {
      await expect(
        factory.connect(owner).updateFeeDistributor(ethers.ZeroAddress)
      ).to.be.revertedWith("Factory: zero feeDistributor");
    });
  });
});
