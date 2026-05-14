// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../interfaces/IPredictOracle.sol";
import "../interfaces/IPredictMarket.sol";

/// @title PredictOracle
/// @notice Modular resolution authority with a 24-hour dispute window.
///         Flow: proposeResolution → (optional) disputeResolution → finalizeResolution
///         Disputed resolutions require owner override via overrideResolution.
contract PredictOracle is Initializable, OwnableUpgradeable, IPredictOracle {
    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant DISPUTE_WINDOW = 24 hours;

    // ─── State ────────────────────────────────────────────────────────────────

    mapping(address => Resolution) public resolutions;
    mapping(address => bool) public authorizedResolvers;

    // ─── Initializer ──────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the oracle
    /// @param _owner Protocol owner (Gnosis Safe)
    function initialize(address _owner) external initializer {
        require(_owner != address(0), "PredictOracle: zero owner");
        __Ownable_init(_owner);
    }

    // ─── External Functions ───────────────────────────────────────────────────

    /// @inheritdoc IPredictOracle
    function addResolver(address resolver) external onlyOwner {
        require(resolver != address(0), "PredictOracle: zero resolver");
        authorizedResolvers[resolver] = true;
        emit ResolverAdded(resolver);
    }

    /// @inheritdoc IPredictOracle
    function removeResolver(address resolver) external onlyOwner {
        authorizedResolvers[resolver] = false;
        emit ResolverRemoved(resolver);
    }

    /// @inheritdoc IPredictOracle
    /// @dev Authorized resolvers or the owner may propose. Status must be None.
    function proposeResolution(address market, bool outcome) external {
        require(
            authorizedResolvers[msg.sender] || msg.sender == owner(),
            "PredictOracle: not authorized"
        );
        require(market != address(0), "PredictOracle: zero market");
        require(
            resolutions[market].status == ResolutionStatus.None,
            "PredictOracle: already proposed"
        );

        uint256 deadline = block.timestamp + DISPUTE_WINDOW;

        resolutions[market] = Resolution({
            proposedOutcome: outcome,
            proposedAt: block.timestamp,
            proposedBy: msg.sender,
            status: ResolutionStatus.Proposed,
            disputedBy: address(0)
        });

        emit ResolutionProposed(market, outcome, msg.sender, deadline);
    }

    /// @inheritdoc IPredictOracle
    /// @dev Anyone can dispute within the 24-hour window.
    function disputeResolution(address market) external {
        Resolution storage res = resolutions[market];
        require(res.status == ResolutionStatus.Proposed, "PredictOracle: not proposed");
        require(
            block.timestamp <= res.proposedAt + DISPUTE_WINDOW,
            "PredictOracle: dispute window closed"
        );

        res.status = ResolutionStatus.Disputed;
        res.disputedBy = msg.sender;

        emit ResolutionDisputed(market, msg.sender);
    }

    /// @inheritdoc IPredictOracle
    /// @dev Keeper-callable. Finalizes after the dispute window without a dispute.
    function finalizeResolution(address market) external {
        Resolution storage res = resolutions[market];
        require(res.status == ResolutionStatus.Proposed, "PredictOracle: not in proposed state");
        require(
            block.timestamp > res.proposedAt + DISPUTE_WINDOW,
            "PredictOracle: dispute window still open"
        );

        res.status = ResolutionStatus.Finalized;

        IPredictMarket(market).resolveMarket(res.proposedOutcome);

        emit ResolutionFinalized(market, res.proposedOutcome);
    }

    /// @inheritdoc IPredictOracle
    function getResolution(address market) external view returns (Resolution memory) {
        return resolutions[market];
    }

    /// @inheritdoc IPredictOracle
    /// @dev Owner-only. Resolves a disputed market with a definitive outcome.
    function overrideResolution(address market, bool outcome) external onlyOwner {
        Resolution storage res = resolutions[market];
        require(res.status == ResolutionStatus.Disputed, "PredictOracle: not disputed");

        res.status = ResolutionStatus.Finalized;
        res.proposedOutcome = outcome;

        IPredictMarket(market).resolveMarket(outcome);

        emit ResolutionOverridden(market, outcome, msg.sender);
    }
}
