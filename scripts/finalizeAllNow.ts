/**
 * finalizeAllNow.ts
 * Oracle proxy is now upgraded to DISPUTE_WINDOW=0.
 * Propose + finalize every unresolved market in one pass.
 */
import { ethers } from "hardhat";
import "dotenv/config";

const OLD_FACTORY = process.env.OLD_FACTORY_ADDRESS ?? "0x7Ec112983011db79f907285daBc759643A9D8304";
const OLD_ORACLE  = process.env.OLD_ORACLE_ADDRESS  ?? "0xc40E6653D3a76FAA8F3F68060f1D09AEB5153A15";

const FACTORY_ABI = ["function getAllMarkets() external view returns (address[])"];
const ORACLE_ABI  = [
  "function proposeResolution(address market, bool outcome) external",
  "function finalizeResolution(address market) external",
  "function overrideResolution(address market, bool outcome) external",
  "function resolutions(address market) external view returns (bool proposedOutcome, uint256 proposedAt, address proposedBy, uint8 status, address disputedBy)",
  "function DISPUTE_WINDOW() external view returns (uint256)",
  "function authorizedResolvers(address) external view returns (bool)",
];
const MARKET_ABI  = ["function resolved() external view returns (bool)"];

const S = { None: 0, Proposed: 1, Disputed: 2, Finalized: 3 };

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const factory = new ethers.Contract(OLD_FACTORY, FACTORY_ABI, deployer);
  const oracle  = new ethers.Contract(OLD_ORACLE,  ORACLE_ABI,  deployer);

  // Confirm window is 0
  const dw = await oracle.DISPUTE_WINDOW();
  console.log(`DISPUTE_WINDOW: ${dw}s  ← must be 0`);
  if (Number(dw) !== 0) throw new Error("Oracle not upgraded yet — DISPUTE_WINDOW != 0");

  const isResolver = await oracle.authorizedResolvers(deployer.address);
  console.log(`Authorized resolver: ${isResolver}`);

  // Fetch all markets
  const addrs: string[] = await factory.getAllMarkets();
  console.log(`\nTotal markets: ${addrs.length}`);
  console.log("Reading state (parallel)…");

  const [resolvedArr, resArr] = await Promise.all([
    Promise.all(addrs.map(a => new ethers.Contract(a, MARKET_ABI, deployer).resolved().catch(() => false))),
    Promise.all(addrs.map(a => oracle.resolutions(a).catch(() => ({ status: 0 })))),
  ]);

  const toPropose:  string[] = [];
  const toFinalize: string[] = [];
  const toOverride: string[] = [];
  let done = 0;

  for (let i = 0; i < addrs.length; i++) {
    const st = Number(resArr[i].status);
    if (resolvedArr[i] || st === S.Finalized) { done++; }
    else if (st === S.Disputed)  { toOverride.push(addrs[i]); }
    else if (st === S.Proposed)  { toFinalize.push(addrs[i]); }
    else                         { toPropose.push(addrs[i]); }
  }

  console.log(`Already resolved: ${done}`);
  console.log(`Need propose:     ${toPropose.length}`);
  console.log(`Need override:    ${toOverride.length}`);
  console.log(`Need finalize:    ${toFinalize.length}`);

  // ── Propose unproposed markets ────────────────────────────────────────────
  if (toPropose.length > 0) {
    console.log(`\n── Proposing ${toPropose.length} markets…`);
    let ok = 0, fail = 0;
    for (const addr of toPropose) {
      try {
        const tx = await oracle.proposeResolution(addr, false);
        await tx.wait();
        toFinalize.push(addr); // window=0, ready immediately
        ok++;
        process.stdout.write(`\r  Proposed: ${ok}/${toPropose.length}`);
      } catch (e: any) {
        fail++;
        console.error(`\n  ✗ ${addr.slice(0,10)}: ${e.message?.slice(0,80)}`);
      }
    }
    console.log(`\n  Done — ok: ${ok}, failed: ${fail}`);
  }

  // ── Override disputed markets ─────────────────────────────────────────────
  if (toOverride.length > 0) {
    console.log(`\n── Overriding ${toOverride.length} disputed markets…`);
    let ok = 0, fail = 0;
    for (const addr of toOverride) {
      try {
        const tx = await oracle.overrideResolution(addr, false);
        await tx.wait();
        ok++;
        process.stdout.write(`\r  Overridden: ${ok}/${toOverride.length}`);
      } catch (e: any) {
        fail++;
        console.error(`\n  ✗ ${addr.slice(0,10)}: ${e.message?.slice(0,80)}`);
      }
    }
    console.log(`\n  Done — ok: ${ok}, failed: ${fail}`);
  }

  // ── Finalize all proposed (window=0, all ready) ───────────────────────────
  if (toFinalize.length > 0) {
    console.log(`\n── Finalizing ${toFinalize.length} markets…`);
    let ok = 0, fail = 0;
    for (const addr of toFinalize) {
      try {
        const tx = await oracle.finalizeResolution(addr);
        await tx.wait();
        ok++;
        process.stdout.write(`\r  Finalized: ${ok}/${toFinalize.length}`);
      } catch (e: any) {
        fail++;
        console.error(`\n  ✗ ${addr.slice(0,10)}: ${e.message?.slice(0,80)}`);
      }
    }
    console.log(`\n  Done — ok: ${ok}, failed: ${fail}`);
  }

  // ── Final verification ────────────────────────────────────────────────────
  console.log("\n── Verifying…");
  const check = await Promise.all(
    addrs.map(a => new ethers.Contract(a, MARKET_ABI, deployer).resolved().catch(() => false))
  );
  const resolved   = check.filter(Boolean).length;
  const unresolved = check.length - resolved;

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  Resolved:   ${resolved}/${addrs.length}`);
  if (unresolved > 0) {
    console.log(`  ⚠ Still unresolved: ${unresolved}`);
    addrs.forEach((a, i) => { if (!check[i]) console.log(`    - ${a}`); });
  } else {
    console.log("  ✓ ALL MARKETS RESOLVED");
    console.log("  Users can now emergencyWithdraw() or claimReward()");
  }
  console.log(`${"═".repeat(55)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
