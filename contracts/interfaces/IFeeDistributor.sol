// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IFeeDistributor
/// @notice Interface for the protocol fee collection and distribution contract
interface IFeeDistributor {
    // ─── Events ───────────────────────────────────────────────────────────────

    event FeeReceived(address indexed market, address indexed currency, uint256 amount);
    event FeesDistributed(
        address indexed currency,
        uint256 buybackAmount,
        uint256 lpAmount,
        uint256 treasuryAmount
    );
    event MarketAuthorized(address indexed market);
    event SplitUpdated(uint256 buybackShare, uint256 lpShare, uint256 treasuryShare);
    event AddressesUpdated(address unitRouter, address treasury, address lpRewardPool);

    // ─── Functions ────────────────────────────────────────────────────────────

    /// @notice Records incoming fee from an authorized market
    /// @param currency The ERC-20 token address (USDC or EURC)
    /// @param amount   The fee amount transferred to this contract
    function receiveFee(address currency, uint256 amount) external;

    /// @notice Distributes accumulated fees for a given currency (60/20/20)
    /// @param currency The ERC-20 token address to distribute
    function distributeFees(address currency) external;

    /// @notice Authorizes a market contract to call receiveFee
    /// @param market The market contract address
    function authorizeMarket(address market) external;

    /// @notice Updates the fee split percentages (must sum to 10000)
    function updateSplit(uint256 buyback, uint256 lp, uint256 treasury) external;

    /// @notice Updates destination addresses
    function updateAddresses(
        address unitRouter,
        address treasury,
        address lpRewardPool
    ) external;

    /// @notice Returns pending undistributed fees for a currency
    function getPendingFees(address currency) external view returns (uint256);

    /// @notice Returns whether a market is authorized to submit fees
    function isAuthorizedMarket(address market) external view returns (bool);
}
