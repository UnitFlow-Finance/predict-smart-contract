// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPredictMarket.sol";

/// @dev Attempts to re-enter claimReward via a fallback triggered by token receipt.
///      Used only in tests to verify ReentrancyGuard is effective.
contract MockReentrantClaimer {
    using SafeERC20 for IERC20;

    IPredictMarket public market;
    bool private _attacking;

    constructor(address _market) {
        market = IPredictMarket(_market);
    }

    function approveMarket(address token) external {
        IERC20(token).approve(address(market), type(uint256).max);
    }

    function stakeYes(uint256 amount) external {
        market.stakeYes(amount);
    }

    /// @notice Initiates the attack: calls claimReward, which will attempt re-entry
    function attack() external {
        _attacking = true;
        market.claimReward();
    }

    /// @notice ERC-20 transfer hook — attempts re-entry when tokens arrive
    /// @dev MockERC20 does not call this hook; the reentrancy guard on claimReward
    ///      will revert the second call regardless.
    fallback() external {
        if (_attacking) {
            _attacking = false;
            market.claimReward(); // This should revert due to ReentrancyGuard
        }
    }
}
