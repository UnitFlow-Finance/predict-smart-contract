// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPredictMarketFactory
/// @notice Interface for the protocol deployer and market registry
interface IPredictMarketFactory {
    // ─── Structs ──────────────────────────────────────────────────────────────

    struct MarketParams {
        string question;        // max 200 chars
        string description;
        string category;
        string[] tags;
        address currency;       // USDC or EURC only
        uint256 resolutionDate; // must be > block.timestamp
        address resolver;
        string oracleSource;
        uint256 initialLiquidity; // min 10e6 (10 USDC/EURC)
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event MarketCreated(
        bytes32 indexed marketId,
        address indexed marketAddress,
        address indexed creator,
        string question,
        address currency,
        uint256 resolutionDate
    );
    event FeeConfigUpdated(uint256 protocolFeeRate, uint256 claimFeeRate);
    event MarketCreationFeeUpdated(uint256 newFee);
    event FeeDistributorUpdated(address newFeeDistributor);

    // ─── Functions ────────────────────────────────────────────────────────────

    /// @notice Deploys a new PredictMarket and seeds initial liquidity
    /// @param params Market configuration parameters
    /// @return marketAddress The address of the newly deployed market
    function createMarket(MarketParams calldata params) external returns (address marketAddress);

    /// @notice Returns all deployed market addresses
    function getAllMarkets() external view returns (address[] memory);

    /// @notice Returns the total number of deployed markets
    function getMarketCount() external view returns (uint256);

    /// @notice Updates protocol and claim fee rates (owner only)
    function updateFeeConfig(uint256 protocolFeeRate, uint256 claimFeeRate) external;

    /// @notice Updates the flat market creation fee (owner only)
    function updateMarketCreationFee(uint256 newFee) external;

    /// @notice Updates the fee distributor address (owner only)
    function updateFeeDistributor(address newFeeDistributor) external;

    /// @notice Pauses new market creation
    function pause() external;

    /// @notice Unpauses new market creation
    function unpause() external;
}
