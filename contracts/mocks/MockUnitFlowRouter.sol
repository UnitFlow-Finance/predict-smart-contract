// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IUnitFlowRouter.sol";

/// @dev Test-only router that simulates the V2.5 swap by pulling the input
///      token and emitting an event. Mirrors the real router's signature so
///      FeeDistributor tests work without a live DEX.
contract MockUnitFlowRouter is IUnitFlowV25Router {
    using SafeERC20 for IERC20;

    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        address to
    );

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external override {
        require(path.length >= 2, "MockRouter: invalid path");
        // Pull input token from caller (FeeDistributor approves before calling)
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        emit SwapExecuted(path[0], path[path.length - 1], amountIn, to);
    }
}
