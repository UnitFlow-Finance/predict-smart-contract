// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal market stub used by oracle tests to verify resolveMarket calls
contract MockMarketStub {
    address public resolver;
    bool public resolveMarketCalled;
    bool public resolvedOutcome;

    constructor(address _resolver) {
        resolver = _resolver;
    }

    /// @notice Mimics PredictMarket.resolveMarket — callable by the oracle (acting as resolver)
    function resolveMarket(bool outcome) external {
        resolveMarketCalled = true;
        resolvedOutcome = outcome;
    }
}
