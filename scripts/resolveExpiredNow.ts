/**
 * resolveExpiredNow.ts
 * Resolves all markets whose resolutionDate has already passed.
 * Markets with future dates cannot be resolved until their date arrives —
 * this is enforced by the immutable PredictMarket contract.
 *
 * For future-dated markets, users must wait for the date to pass,
 * then run this script again (or the oracle will auto-finalize them).
 */
import { ethers } from "hardhat";
import "dotenv/config";

const OLD_FACTORY = process.env.OLD_FACTORY_ADDRESS ?? "0x7Ec112983011db79f907285daBc759643A9D8304";
const OLD_ORACLE  = process.env.OLD_ORACLE_ADDRESS  ?? "0xc40E6653D3a76FAA8F3F68060f1D09AEB5153A15";

const FACTORY_ABI = ["function getAllMarkets() external view returns (address[])"];
const ORACLE_ABI  = [
  "function proposeResolution(address market, bool outcome) external",
  "function finalizeResolution(address market) external",
  "function resolutions(address market) external view returns (bool proposedOutcome, uint256 proposedAt, address proposedBy, uint8 status, address disputedBy)",
  "function DISPUTE_WINDOW() external view returns (uint256)",
];
const MARKET_ABI  = [
  "function resolved() external view returns (bool)",
  "function totalStaked() external view returns (uint256)",
  "function getMarketInfo() external view returns (tuple(bytes32 marketId, string question, string description, string category, string[] tags, address currency, uint256 resolutionDate, address resolver, string oracleSource, address creator, uint256 createdAt))",
];

const S = { None: 0, Proposed: 1, Disputed: 2, Finalized: 3 };

async function main() {
  const [deployer] = await ethers.getSigners();
  const now = Math.floor(Date.now() / 1000);

  const factory = new ethers.Contract(OLD_FACTORY, FACTORY_ABI, deployer);
  const oracle  = new ethers.Contract(OLD_ORACLE,  ORACLE_ABI,  deployer);

  const dw = await oracle.DISPUTE_WINDOW();
  console.log(`DISPUTE_WINDOW: ${dw}s (must be 0 for instant finalization)`);

  const addrs: string[] = await factory.getAllMarkets();
  console.log(`Total markets: ${addrs.length}\nReading state…`);

  const [resolvedArr, infoArr, resArr] = await Promise.all([
    Promise.all(addrs.map(a => new ethers.Contract(a, MARKET_ABI, deployer).resolved().catch(() => false))),
    Promise.all(addrs.map(a => new ethers.Contract(a, MARKET_ABI, deployer).getMarketInfo().catch(() => null))),
    Promise.all(addrs.map(a => oracle.resolutions(a).catch(() => ({ status: 0 })))),
  ]);

  // Only target markets that are: not resolved + past resolutionDate
  const toPropose:  string[] = [];
  const toFinalize: string[] = [];
  let alreadyResolved = 0, futureBlocked = 0;

  for (let i = 0; i < addrs.length; i++) {
    if (resolvedArr[i]) { alreadyResolved++; continue; }
    const resDate = infoArr[i] ? Number(infoArr[i].resolutionDate) : 0;
    if (now < resDate) { futureBlocked++; continue; } // can't resolve yet

    const st = Number(resArr[i].status);
    if (st === S.None)     toPropose.push(addrs[i]);
    else if (st === S.Proposed) toFinalize.push(addrs[i]);
    // Disputed/Finalized already handled
  }

  console.log(`Already resolved:      ${alreadyResolved}`);
  console.log(`Future date (blocked): ${futureBlocked} — must wait for resolutionDate`);
  console.log(`Past date, need propose: ${toPropose.length}`);
  console.log(`Past date, need finalize: ${toFinalize.length}`);

  if (toPropose.length === 0 && toFinalize.length === 0) {
    console.log("\nNothing to do right now.");
    console.log("All remaining markets have future resolution dates.");
    console.log("Re-run this script after each market's resolutionDate passes.");
    return;
  }

  if (toPropose.length > 0) {
    console.log(`\n── Proposing ${toPropose.length} past-date markets…`);
    let ok = 0;
    for (const addr of toPropose) {
      try {
        const tx = await oracle.proposeResolution(addr, false);
        await tx.wait();
        toFinalize.push(addr);
        ok++;
        process.stdout.write(`\r  ${ok}/${toPropose.length}`);
      } catch (e: any) {
        console.error(`\n  ✗ ${addr.slice(0,10)}: ${e.message?.slice(0,80)}`);
      }
    }
    console.log();
  }

  if (toFinalize.length > 0) {
    console.log(`\n── Finalizing ${toFinalize.length} markets (DISPUTE_WINDOW=0)…`);
    let ok = 0, fail = 0;
    for (const addr of toFinalize) {
      try {
        const tx = await oracle.finalizeResolution(addr);
        await tx.wait();
        ok++;
        process.stdout.write(`\r  ${ok}/${toFinalize.length}`);
      } catch (e: any) {
        fail++;
        console.error(`\n  ✗ ${addr.slice(0,10)}: ${e.message?.slice(0,80)}`);
      }
    }
    console.log(`\n  ok: ${ok}, failed: ${fail}`);
  }

  // Summary
  const finalCheck = await Promise.all(
    addrs.map(a => new ethers.Contract(a, MARKET_ABI, deployer).resolved().catch(() => false))
  );
  const totalResolved = finalCheck.filter(Boolean).length;
  console.log(`\n${"═".repeat(55)}`);
  console.log(`  Resolved: ${totalResolved}/${addrs.length}`);
  console.log(`  Blocked (future date): ${futureBlocked}`);
  console.log(`  → Re-run after each market's resolutionDate passes`);
  console.log(`${"═".repeat(55)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
