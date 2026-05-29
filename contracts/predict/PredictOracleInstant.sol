// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "../interfaces/IPredictOracle.sol";
import "../interfaces/IPredictMarket.sol";

/// @title PredictOracleInstant
/// @notice Drop-in replacement for PredictOracle with DISPUTE_WINDOW = 0.
///         Used to upgrade the old oracle proxy so all pending resolutions
///         can be finalized immediately, unblocking user withdrawals.
///
///         Storage layout is identical to PredictOracle — safe to upgrade.
contract PredictOracleInstant is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    IPredictOracle
{
    // ── DISPUTE_WINDOW = 0 so finalizeResolution is callable immediately ──────
    uint256 public constant DISPUTE_WINDOW = 0;

    // ── Storage (identical layout to PredictOracle) ───────────────────────────
    mapping(address => Resolution) public resolutions;
    mapping(address => bool)       public authorizedResolvers;
    mapping(address => bool)       public authorizedDisputers;

    event ResolutionCallFailed(address indexed market, bytes reason);
    event DisputerAdded(address indexed disputer);
    event DisputerRemoved(address indexed disputer);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address _owner) external initializer {
        require(_owner != address(0), "PredictOracleInstant: zero owner");
        __Ownable_init(_owner);
        __Pausable_init();
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function addResolver(address resolver) external onlyOwner {
        require(resolver != address(0), "PredictOracleInstant: zero resolver");
        authorizedResolvers[resolver] = true;
        emit ResolverAdded(resolver);
    }

    function removeResolver(address resolver) external onlyOwner {
        authorizedResolvers[resolver] = false;
        emit ResolverRemoved(resolver);
    }

    function addDisputer(address disputer) external onlyOwner {
        require(disputer != address(0), "PredictOracleInstant: zero disputer");
        authorizedDisputers[disputer] = true;
        emit DisputerAdded(disputer);
    }

    function removeDisputer(address disputer) external onlyOwner {
        authorizedDisputers[disputer] = false;
        emit DisputerRemoved(disputer);
    }

    function proposeResolution(address market, bool outcome)
        external
        whenNotPaused
    {
        require(
            authorizedResolvers[msg.sender] || msg.sender == owner(),
            "PredictOracleInstant: not authorized"
        );
        require(market != address(0), "PredictOracleInstant: zero market");
        require(
            resolutions[market].status == ResolutionStatus.None,
            "PredictOracleInstant: already proposed"
        );

        resolutions[market] = Resolution({
            proposedOutcome: outcome,
            proposedAt:      block.timestamp,
            proposedBy:      msg.sender,
            status:          ResolutionStatus.Proposed,
            disputedBy:      address(0)
        });

        // deadline = now (window = 0)
        emit ResolutionProposed(market, outcome, msg.sender, block.timestamp);
    }

    function disputeResolution(address market) external {
        require(
            authorizedDisputers[msg.sender] || msg.sender == owner(),
            "PredictOracleInstant: not authorized to dispute"
        );
        Resolution storage res = resolutions[market];
        require(res.status == ResolutionStatus.Proposed, "PredictOracleInstant: not proposed");
        // Window = 0, so dispute window is always closed — disputes not possible
        require(
            block.timestamp <= res.proposedAt + DISPUTE_WINDOW,
            "PredictOracleInstant: dispute window closed"
        );
        res.status     = ResolutionStatus.Disputed;
        res.disputedBy = msg.sender;
        emit ResolutionDisputed(market, msg.sender);
    }

    /// @notice Finalizes immediately — DISPUTE_WINDOW = 0 so no waiting required.
    function finalizeResolution(address market) external {
        Resolution storage res = resolutions[market];
        require(res.status == ResolutionStatus.Proposed, "PredictOracleInstant: not proposed");
        // block.timestamp > proposedAt + 0 is always true (same block is fine too)

        res.status = ResolutionStatus.Finalized;

        try IPredictMarket(market).resolveMarket(res.proposedOutcome) {
            emit ResolutionFinalized(market, res.proposedOutcome);
        } catch (bytes memory reason) {
            res.status = ResolutionStatus.Proposed;
            emit ResolutionCallFailed(market, reason);
        }
    }

    function getResolution(address market) external view returns (Resolution memory) {
        return resolutions[market];
    }

    function overrideResolution(address market, bool outcome) external onlyOwner {
        Resolution storage res = resolutions[market];
        require(res.status == ResolutionStatus.Disputed, "PredictOracleInstant: not disputed");

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
