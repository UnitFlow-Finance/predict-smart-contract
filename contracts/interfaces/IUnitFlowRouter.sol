// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IUnitFlowRouter
/// @notice Interface for the UnitFlow DEX router used to execute UNIT buyback-and-burn
interface IUnitFlowRouter {
    /// @notice Swaps `amount` of `token` for UNIT and burns the received UNIT
    /// @param token The ERC-20 token to sell (USDC or EURC)
    /// @param amount The amount of `token` to sell
    function buybackAndBurn(address token, uint256 amount) external;
}
