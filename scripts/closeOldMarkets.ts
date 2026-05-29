/**
 * closeOldMarkets.ts — Batch-resolve all markets on the OLD PredictMarketFactory
 * so users can withdraw their funds.
 *
 * Strategy: resolve every market as NO.
 *   - If nobody staked NO → emergencyWithdraw() available (full stake refund)
 *   - If people staked NO → NO stakers claimReward(), YES stakers lost
 *
 * Usage:
 *   npx hardhat run scripts/closeOldMarkets.ts --network arcTestnet
 */

import { ethers } from "hardhat";
import "dotenv/config";

const OLD_FACTORY = process.env.OLD_FACTORY_ADDRESS ?? "0x7Ec112983011db79f907285daBc759643A9D8304";
const OLD_ORACLE  = process.env.OLD_ORACLE_ADDRESS  ?? "0xc40E6653D3a76FAA8F3F68060f1D09AEB5153A15";

const FACTORY_ABI = ["function getAllMarkets() external view returns (address[])"];
const ORACLE_ABI = [
  "function proposeResolution(address market, bool outcome) external",
  "function finalizeResolution(address market) external",
  "function overrideResolution(address market, bool outcome) external",
  "function resolutions(address market) external view returns (bool proposedOutcome, uint256 proposedAt, address proposedBy, uint8 status, address disputedBy)",
  "function DISPUTE_WINDOW() external view returns (uint256)",
  "function authorizedResolvers(address) external view returns (bool)",
  "function owner() external view returns (address)",
];
const MARKET_ABI = [
  "function resolved() external view returns (bool)",
  "function totalStaked() external view returns (uint256)",
  "function getMarketInfo() external view returns (tuple(bytes32 marketId, string question, string description, string category, string[] tags, address currency, uint256 resolutionDate, address resolver, string oracleSource, address creator, uint256 createdAt))",
];

const S = { None: 0, Proposed: 1, Disputed: 2, Finalized: 3 };

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const now        = Math.floor(Date.now() / 1000);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  closeOldMarkets — force-close old Predict markets");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`  Network:     chainId ${network.chainId}`);
  console.log(`  Old Factory: ${OLD_FACTORY}`);
  console.log(`  Old Oracle:  ${OLD_ORACLE}\n`);

  const factory = new ethers.Contract(OLD_FACTORY, FACTORY_ABI, deployer);
  const oracle  = new ethers.Contract(OLD_ORACLE,  ORACLE_ABI,  deployer);

  // Auth check
  const [isResolver, oracleOwner, disputeWindow] = await Promise.all([
    oracle.authorizedResolvers(deployer.address),
    oracle.owner(),
    oracle.DISPUTE_WINDOW(),
  ]);

  const isOwner = oracleOwner.toLowerCase() === deployer.address.toLowerCase();
  if (!isResolver && !isOwner) {
    throw new Error(`${deployer.address} is not an authorized resolver or oracle owner.\nOracle owner: ${oracleOwner}`);
  }
  console.log(`  Auth: ${isResolver ? "authorized resolver" : "oracle owner"} ✓`);
  console.log(`  Dispute window: ${Number(disputeWindow) / 3600}h\n`);

  // Fetch all market addresses
  const marketAddresses: string[] = await factory.getAllMarkets();
  console.log(`  Markets on old factory: ${marketAddresses.length}`);
  if (marketAddresses.length === 0) { console.log("  Nothing to do."); return; }

  // Batch-read all state in parallel
  console.log("  Reading market state (parallel)…");
  const [resolvedArr, resolutionsArr, infoArr, stakedArr] = await Promise.all([
    Promise.all(marketAddresses.map((a) => new ethers.Contract(a, MARKET_ABI, deployer).resolved().catch(() => false))),
    Promise.all(marketAddresses.map((a) => oracle.resolutions(a).catch(() => ({ status: 0, proposedAt: 0 })))),
    Promise.all(marketAddresses.map((a) => new ethers.Contract(a, MARKET_ABI, deployer).getMarketInfo().catch(() => null))),
    Promise.all(marketAddresses.map((a) => new ethers.Contract(a, MARKET_ABI, deployer).totalStaked().catch(() => 0n))),
  ]);

  // Categorise
  const toPropose:  string[] = [];
  const toOverride: string[] = [];
  const toFinalize: string[] = [];
  let alreadyDone = 0;

  for (let i = 0; i < marketAddresses.length; i++) {
    const addr   = marketAddresses[i];
    const status = Number(resolutionsArr[i].status);
    if (resolvedArr[i] || status === S.Finalized) { alreadyDone++; }
    else if (status === S.Disputed) { toOverride.push(addr); }
    else if (status === S.Proposed) {
      const deadline = Number(resolutionsArr[i].proposedAt) + Number(disputeWindow);
      if (now > deadline) toFinalize.push(addr);
    } else { toPropose.push(addr); }
  }

  console.log(`\n  Already resolved/finalized: ${alreadyDone}`);
  console.log(`  Need proposal:              ${toPropose.length}`);
  console.log(`  Need override (disputed):   ${toOverride.length}`);
  console.log(`  Ready to finalize now:      ${toFinalize.length}`);

  // Phase 1a: propose
  if (toPropose.length > 0) {
    console.log("\n── Proposing resolutions ─────────────────────────────");
    for (const addr of toPropose) {
      const idx   = marketAddresses.indexOf(addr);
      const staked = stakedArr[idx];
      const q     = infoArr[idx]?.question?.slice(0, 55) ?? addr;
      console.log(`  → ${addr.slice(0, 10)}… "${q}" (staked: ${ethers.formatUnits(staked, 6)})`);
      try {
        const tx = await oracle.proposeResolution(addr, false);
        await tx.wait();
        console.log(`    ✓ proposed (NO) — tx: ${tx.hash}`);
      } catch (e: any) {
        console.error(`    ✗ failed: ${e.message?.slice(0, 120)}`);
      }
    }
  }

  // Phase 1b: override disputed
  if (toOverride.length > 0) {
    console.log("\n── Overriding disputed resolutions ───────────────────");
    for (const addr of toOverride) {
      const idx = marketAddresses.indexOf(addr);
      const q   = infoArr[idx]?.question?.slice(0, 55) ?? addr;
      console.log(`  → ${addr.slice(0, 10)}… "${q}"`);
      try {
        const tx = await oracle.overrideResolution(addr, false);
        await tx.wait();
        console.log(`    ✓ overridden (NO) — tx: ${tx.hash}`);
      } catch (e: any) {
        console.error(`    ✗ failed: ${e.message?.slice(0, 120)}`);
      }
    }
  }

  // Phase 2: finalize any already past window
  if (toFinalize.length > 0) {
    console.log("\n── Finalizing (past dispute window) ──────────────────");
    for (const addr of toFinalize) {
      const idx = marketAddresses.indexOf(addr);
      const q   = infoArr[idx]?.question?.slice(0, 55) ?? addr;
      console.log(`  → ${addr.slice(0, 10)}… "${q}"`);
      try {
        const tx = await oracle.finalizeResolution(addr);
        await tx.wait();
        console.log(`    ✓ finalized — tx: ${tx.hash}`);
      } catch (e: any) {
        console.error(`    ✗ failed: ${e.message?.slice(0, 120)}`);
      }
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
  if (toPropose.length > 0) {
    console.log(`  ${toPropose.length} market(s) proposed — run finalizeOldMarkets.ts`);
    console.log(`  in ${Number(disputeWindow) / 3600}h to complete resolution.`);
  } else {
    console.log("  All markets resolved. Users can now withdraw funds.");
  }
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((err) => { console.error(err); process.exit(1); });
