// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IUnitFlowRouter.sol";

/// @dev Test-only router that accepts tokens and emits an event (simulates buyback)
contract MockUnitFlowRouter is IUnitFlowRouter {
    using SafeERC20 for IERC20;

    event BuybackAndBurnCalled(address indexed token, uint256 amount);

    function buybackAndBurn(address token, uint256 amount) external override {
        // Pull tokens from caller (FeeDistributor approves before calling)
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit BuybackAndBurnCalled(token, amount);
    }
}
