import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * PredictDeploy — deploys all four UnitFlow Predict contracts behind
 * TransparentUpgradeableProxy in the correct dependency order:
 *
 *   1. FeeDistributor  (proxy)
 *   2. PredictOracle   (proxy)
 *   3. PredictMarketFactory (proxy, wired to FeeDistributor + Oracle)
 *   4. Post-deploy wiring: grantCallerRole + authorizeMarket on FeeDistributor
 *
 * Required environment variables (set in .env):
 *   DEPLOYER_PRIVATE_KEY   — deployer / proxy admin
 *   OWNER_ADDRESS          — Gnosis Safe 3-of-5 multisig (receives ownership)
 *   UNIT_ROUTER_ADDRESS    — UnitFlow DEX router for buyback-and-burn
 *   TREASURY_ADDRESS       — Protocol treasury multisig (20% fees)
 *   LP_REWARD_POOL_ADDRESS — LP reward pool contract (20% fees)
 *   USDC_ADDRESS           — USDC token on Arc
 *   EURC_ADDRESS           — EURC token on Arc
 *   ADMIN_RESOLVER_ADDRESS — Initial authorized resolver (admin wallet)
 */
const PredictDeployModule = buildModule("PredictDeploy", (m) => {
  // ─── Parameters (override via ignition/parameters.json or env) ──────────────

  const owner = m.getParameter("owner", process.env.OWNER_ADDRESS ?? "");
  const unitRouter = m.getParameter("unitRouter", process.env.UNIT_ROUTER_ADDRESS ?? "");
  const treasury = m.getParameter("treasury", process.env.TREASURY_ADDRESS ?? "");
  const lpRewardPool = m.getParameter("lpRewardPool", process.env.LP_REWARD_POOL_ADDRESS ?? "");
  const usdc = m.getParameter("usdc", process.env.USDC_ADDRESS ?? "");
  const eurc = m.getParameter("eurc", process.env.EURC_ADDRESS ?? "");
  const adminResolver = m.getParameter(
    "adminResolver",
    process.env.ADMIN_RESOLVER_ADDRESS ?? ""
  );

  // ─── 1. FeeDistributor ───────────────────────────────────────────────────────

  const feeDistributorImpl = m.contract("FeeDistributor", [], {
    id: "FeeDistributorImpl",
  });

  const feeDistributorProxy = m.contract(
    "TransparentUpgradeableProxy",
    [
      feeDistributorImpl,
      owner,
      m.encodeFunctionCall(feeDistributorImpl, "initialize", [
        unitRouter,
        treasury,
        lpRewardPool,
        owner,
      ]),
    ],
    { id: "FeeDistributorProxy" }
  );

  const feeDistributor = m.contractAt("FeeDistributor", feeDistributorProxy, {
    id: "FeeDistributor",
  });

  // ─── 2. PredictOracle ────────────────────────────────────────────────────────

  const oracleImpl = m.contract("PredictOracle", [], {
    id: "PredictOracleImpl",
  });

  const oracleProxy = m.contract(
    "TransparentUpgradeableProxy",
    [
      oracleImpl,
      owner,
      m.encodeFunctionCall(oracleImpl, "initialize", [owner]),
    ],
    { id: "PredictOracleProxy" }
  );

  const oracle = m.contractAt("PredictOracle", oracleProxy, {
    id: "PredictOracle",
  });

  // Add admin resolver
  m.call(oracle, "addResolver", [adminResolver], { id: "AddAdminResolver" });

  // ─── 3. PredictMarketFactory ─────────────────────────────────────────────────

  const factoryImpl = m.contract("PredictMarketFactory", [], {
    id: "PredictMarketFactoryImpl",
  });

  const factoryProxy = m.contract(
    "TransparentUpgradeableProxy",
    [
      factoryImpl,
      owner,
      m.encodeFunctionCall(factoryImpl, "initialize", [
        feeDistributorProxy,
        oracleProxy,
        usdc,
        eurc,
        owner,
      ]),
    ],
    { id: "PredictMarketFactoryProxy" }
  );

  const factory = m.contractAt("PredictMarketFactory", factoryProxy, {
    id: "PredictMarketFactory",
  });

  // ─── 4. Post-deploy wiring ───────────────────────────────────────────────────

  // Allow factory to call authorizeMarket on FeeDistributor
  m.call(feeDistributor, "grantCallerRole", [factoryProxy], {
    id: "GrantFactoryCallerRole",
  });

  // Allow factory to call receiveFee on FeeDistributor (for creation fees)
  m.call(feeDistributor, "authorizeMarket", [factoryProxy], {
    id: "AuthorizeFactoryAsMarket",
  });

  return {
    feeDistributorImpl,
    feeDistributorProxy,
    feeDistributor,
    oracleImpl,
    oracleProxy,
    oracle,
    factoryImpl,
    factoryProxy,
    factory,
  };
});

export default PredictDeployModule;
