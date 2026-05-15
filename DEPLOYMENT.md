# UnitFlow Predict — Arc Testnet Deployment

**Network:** Arc Testnet (chainId: 5042002)  
**RPC:** https://rpc.testnet.arc.network  
**Explorer:** https://testnet.arcscan.app  
**Deployed:** 2026-05-15  
**Deployer:** `0x3682652cD0995E6972CCF7245a1CAea95C2955b8`

---

## Token Addresses

| Token | Address |
|-------|---------|
| USDC  | `0x3600000000000000000000000000000000000000` |
| EURC  | `0x89b50855aa3be2f677cd6303cec089b5f319d72a` |

---

## Contract Addresses

### MockUnitFlowRouter *(testnet stub — replace with real UnitFlow router on mainnet)*
- **Address:** `0x285562e96B281791270090Ead5239b9747fe9197`
- **ArcScan:** https://testnet.arcscan.app/address/0x285562e96B281791270090Ead5239b9747fe9197#code

---

### FeeDistributor
| | Address |
|--|---------|
| **Proxy** | `0x0d0425413284ebB4023913ef78Eb207241d3b2eC` |
| **Implementation** | `0x7b528bC0AF9Cd45F3C37982987E99ADD43B9a49E` |

- **Proxy ArcScan:** https://testnet.arcscan.app/address/0x0d0425413284ebB4023913ef78Eb207241d3b2eC#code
- **Impl ArcScan:** https://testnet.arcscan.app/address/0x7b528bC0AF9Cd45F3C37982987E99ADD43B9a49E#code

Fee split: 60% buyback-and-burn → 20% LP rewards → 20% treasury

---

### PredictOracle
| | Address |
|--|---------|
| **Proxy** | `0xc40E6653D3a76FAA8F3F68060f1D09AEB5153A15` |
| **Implementation** | `0xbdB7FD8E6FB1a0F3976E46B49C2c92BC532450F1` |

- **Proxy ArcScan:** https://testnet.arcscan.app/address/0xc40E6653D3a76FAA8F3F68060f1D09AEB5153A15#code
- **Impl ArcScan:** https://testnet.arcscan.app/address/0xbdB7FD8E6FB1a0F3976E46B49C2c92BC532450F1#code

24-hour dispute window. Authorized resolver: `0x3682652cD0995E6972CCF7245a1CAea95C2955b8`

---

### PredictMarketFactory
| | Address |
|--|---------|
| **Proxy** | `0x7Ec112983011db79f907285daBc759643A9D8304` |
| **Implementation** | `0x2EA73225038E9D8b9767B722425c1d69dB8EB748` |

- **Proxy ArcScan:** https://testnet.arcscan.app/address/0x7Ec112983011db79f907285daBc759643A9D8304#code
- **Impl ArcScan:** https://testnet.arcscan.app/address/0x2EA73225038E9D8b9767B722425c1d69dB8EB748#code

Market creation fee: 5 USDC. Supported currencies: USDC, EURC.

---

## Security Hardening Applied

| # | Issue | Fix |
|---|-------|-----|
| 1 | Zero-fee transfer to FeeDistributor reverts | Skip `safeTransfer` + `receiveFee` when fee = 0 |
| 2 | Whale single-tx pool manipulation | Max stake = 10% of pool per tx (+ 100k USDC hard cap) |
| 3 | `getParticipants()` gas DoS | Added `getParticipantsPaginated(offset, limit)` |
| 4 | Fee-on-transfer token griefing | Balance-diff check after `safeTransferFrom` |
| 5 | `seedLiquidity` accounting mismatch | Balance verification before pool split |
| 6 | `safeIncreaseAllowance` residual on router | `forceApprove` (zero → set) pattern |
| 7 | Router revert locks fees permanently | `try/catch` on `buybackAndBurn`; fallback to treasury |
| 8 | `finalizeResolution` stuck on market revert | `try/catch` rolls status back to `Proposed` for retry |
| 9 | `overrideResolution` stuck on market revert | Same `try/catch` rollback to `Disputed` |
| 10 | Oracle has no emergency stop | `PausableUpgradeable` added; `pause()`/`unpause()` |
| 11 | `block.timestamp` in marketId (validator-manipulable) | Replaced with `block.chainid` + nonce |
| 12 | No events for role grants | `CallerRoleGranted`/`CallerRoleRevoked` events added |

---

## Next Steps for Mainnet

1. Replace `MockUnitFlowRouter` with the real UnitFlow DEX router address
2. Replace `OWNER_ADDRESS` / `TREASURY_ADDRESS` / `LP_REWARD_POOL_ADDRESS` with Gnosis Safe multisig addresses
3. Transfer proxy admin ownership to the Gnosis Safe after deployment
4. Run `scripts/seedMarkets.ts` to deploy the 12 initial markets
5. Deploy subgraph to The Graph (update `subgraph.yaml` with factory proxy address)
