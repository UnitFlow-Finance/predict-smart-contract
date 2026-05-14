// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPredictMarket
/// @notice Interface for a single AMM-based binary prediction market
interface IPredictMarket {
    // ─── Structs ──────────────────────────────────────────────────────────────

    struct MarketInfo {
        bytes32 marketId;
        string question;
        string description;
        string category;
        string[] tags;
        address currency;
        uint256 resolutionDate;
        address resolver;
        string oracleSource;
        address creator;
        uint256 createdAt;
    }

    struct UserPosition {
        uint256 yesShares;
        uint256 noShares;
        uint256 totalStaked;
        bool claimed;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event Staked(
        address indexed user,
        bool isYes,
        uint256 amount,
        uint256 sharesIssued,
        uint256 fee,
        uint256 yesOdds,
        uint256 noOdds
    );
    event Claimed(
        address indexed user,
        uint256 shares,
        uint256 payout,
        uint256 fee
    );
    event MarketResolved(bool outcome, address indexed resolver);
    event LiquiditySeeded(uint256 yesPool, uint256 noPool);

    // ─── Functions ────────────────────────────────────────────────────────────

    /// @notice Seeds initial 50/50 liquidity (factory only)
    function seedLiquidity(uint256 amount) external;

    /// @notice Stakes on YES outcome
    function stakeYes(uint256 amount) external;

    /// @notice Stakes on NO outcome
    function stakeNo(uint256 amount) external;

    /// @notice Claims winning payout after resolution
    function claimReward() external;

    /// @notice Resolves the market with a final outcome (resolver only)
    function resolveMarket(bool outcome) external;

    /// @notice Returns current odds in basis points (sum = 10000)
    function getOdds() external view returns (uint256 yesOdds, uint256 noOdds);

    /// @notice Returns the market metadata struct
    function getMarketInfo() external view returns (MarketInfo memory);

    /// @notice Returns a user's position
    function getUserPosition(address user) external view returns (UserPosition memory);

    /// @notice Returns total USDC/EURC staked across all participants
    function getTotalStaked() external view returns (uint256);

    /// @notice Returns the number of unique participants
    function getParticipantCount() external view returns (uint256);

    /// @notice Returns all participant addresses
    function getParticipants() external view returns (address[] memory);

    /// @notice Estimates payout for a user if they were to claim now
    function estimatePayout(address user)
        external
        view
        returns (uint256 gross, uint256 net, uint256 fee);

    /// @notice Emergency pause — kills staking (factory only)
    function emergencyPause() external;

    /// @notice Emergency unpause (factory only)
    function emergencyUnpause() external;
}
