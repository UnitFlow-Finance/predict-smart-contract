// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "../interfaces/IPredictOracle.sol";
import "../interfaces/IPredictMarket.sol";

/// @title PredictOracle
/// @notice Modular resolution authority with a 24-hour dispute window.
///         Flow: proposeResolution → (optional) disputeResolution → finalizeResolution
///         Disputed resolutions require owner override via overrideResolution.
///
/// @dev Security properties:
///   - Pausable: owner can halt new proposals in an emergency
///   - try/catch on resolveMarket: if the market call reverts, the resolution
///     status is rolled back to Proposed so it can be retried or disputed
///   - Resolver removal is immediate (no pending-removal delay needed at this stage)
///   - All state changes emit events for off-chain monitoring
contract PredictOracle is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    IPredictOracle
{
    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant DISPUTE_WINDOW = 24 hours;

    // ─── State ────────────────────────────────────────────────────────────────

    mapping(address => Resolution) public resolutions;
    mapping(address => bool)       public authorizedResolvers;
    /// @notice Addresses permitted to dispute resolutions.
    ///         Prevents costless griefing by anonymous actors.
    mapping(address => bool)       public authorizedDisputers;

    // ─── Additional events ────────────────────────────────────────────────────

    event ResolutionCallFailed(address indexed market, bytes reason);
    event DisputerAdded(address indexed disputer);
    event DisputerRemoved(address indexed disputer);

    // ─── Initializer ──────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _owner) external initializer {
        require(_owner != address(0), "PredictOracle: zero owner");
        __Ownable_init(_owner);
        __Pausable_init();
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

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

    /// @notice Grants an address permission to dispute resolutions.
    function addDisputer(address disputer) external onlyOwner {
        require(disputer != address(0), "PredictOracle: zero disputer");
        authorizedDisputers[disputer] = true;
        emit DisputerAdded(disputer);
    }

    /// @notice Revokes dispute permission from an address.
    function removeDisputer(address disputer) external onlyOwner {
        authorizedDisputers[disputer] = false;
        emit DisputerRemoved(disputer);
    }

    // ─── Resolution Flow ──────────────────────────────────────────────────────

    /// @inheritdoc IPredictOracle
    /// @dev New proposals blocked when paused.
    function proposeResolution(address market, bool outcome)
        external
        whenNotPaused
    {
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
            proposedAt:      block.timestamp,
            proposedBy:      msg.sender,
            status:          ResolutionStatus.Proposed,
            disputedBy:      address(0)
        });

        emit ResolutionProposed(market, outcome, msg.sender, deadline);
    }

    /// @inheritdoc IPredictOracle
    /// @dev Only authorized disputers or the owner can dispute. This prevents
    ///      costless griefing by anonymous actors that would force owner
    ///      intervention on every market resolution.
    function disputeResolution(address market) external {
        require(
            authorizedDisputers[msg.sender] || msg.sender == owner(),
            "PredictOracle: not authorized to dispute"
        );
        Resolution storage res = resolutions[market];
        require(res.status == ResolutionStatus.Proposed, "PredictOracle: not proposed");
        require(
            block.timestamp <= res.proposedAt + DISPUTE_WINDOW,
            "PredictOracle: dispute window closed"
        );

        res.status     = ResolutionStatus.Disputed;
        res.disputedBy = msg.sender;

        emit ResolutionDisputed(market, msg.sender);
    }

    /// @inheritdoc IPredictOracle
    /// @dev Keeper-callable. If resolveMarket reverts on the market contract,
    ///      the resolution status is rolled back to Proposed so it can be retried.
    function finalizeResolution(address market) external {
        Resolution storage res = resolutions[market];
        require(res.status == ResolutionStatus.Proposed, "PredictOracle: not in proposed state");
        require(
            block.timestamp > res.proposedAt + DISPUTE_WINDOW,
            "PredictOracle: dispute window still open"
        );

        // Optimistically set Finalized; roll back on failure
        res.status = ResolutionStatus.Finalized;

        try IPredictMarket(market).resolveMarket(res.proposedOutcome) {
            emit ResolutionFinalized(market, res.proposedOutcome);
        } catch (bytes memory reason) {
            // Roll back so the resolution can be retried or overridden
            res.status = ResolutionStatus.Proposed;
            emit ResolutionCallFailed(market, reason);
        }
    }

    /// @inheritdoc IPredictOracle
    function getResolution(address market) external view returns (Resolution memory) {
        return resolutions[market];
    }

    /// @inheritdoc IPredictOracle
    /// @dev Owner-only override for disputed resolutions. Same rollback pattern.
    function overrideResolution(address market, bool outcome) external onlyOwner {
        Resolution storage res = resolutions[market];
        require(res.status == ResolutionStatus.Disputed, "PredictOracle: not disputed");

        res.status          = ResolutionStatus.Finalized;
        res.proposedOutcome = outcome;

        try IPredictMarket(market).resolveMarket(outcome) {
            emit ResolutionOverridden(market, outcome, msg.sender);
        } catch (bytes memory reason) {
            res.status = ResolutionStatus.Disputed;
            emit ResolutionCallFailed(market, reason);
        }
    }
}
