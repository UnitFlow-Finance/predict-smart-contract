// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IUnitFlowV25Router
/// @notice Interface for the UnitFlow V2.5 DEX router.
///         Uses swapExactTokensForTokensSupportingFeeOnTransferTokens
///         because UNIT is a deflationary/reflection token — the standard
///         swapExactTokensForTokens reverts on fee-on-transfer tokens.
interface IUnitFlowV25Router {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}
