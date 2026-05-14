// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPredictOracle
/// @notice Interface for the modular resolution authority with dispute window
interface IPredictOracle {
    // ─── Enums ────────────────────────────────────────────────────────────────

    enum ResolutionStatus {
        None,
        Proposed,
        Disputed,
        Finalized
    }

    // ─── Structs ──────────────────────────────────────────────────────────────

    struct Resolution {
        bool proposedOutcome;
        uint256 proposedAt;
        address proposedBy;
        ResolutionStatus status;
        address disputedBy;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event ResolutionProposed(
        address indexed market,
        bool outcome,
        address indexed proposer,
        uint256 disputeDeadline
    );
    event ResolutionDisputed(address indexed market, address indexed disputer);
    event ResolutionFinalized(address indexed market, bool outcome);
    event ResolutionOverridden(address indexed market, bool outcome, address indexed admin);
    event ResolverAdded(address indexed resolver);
    event ResolverRemoved(address indexed resolver);

    // ─── Functions ────────────────────────────────────────────────────────────

    /// @notice Proposes an outcome for a market (authorized resolvers only)
    function proposeResolution(address market, bool outcome) external;

    /// @notice Disputes a proposed resolution within the dispute window
    function disputeResolution(address market) external;

    /// @notice Finalizes a resolution after the dispute window has passed
    function finalizeResolution(address market) external;

    /// @notice Overrides a disputed resolution (owner only)
    function overrideResolution(address market, bool outcome) external;

    /// @notice Adds an authorized resolver
    function addResolver(address resolver) external;

    /// @notice Removes an authorized resolver
    function removeResolver(address resolver) external;

    /// @notice Returns the resolution record for a market
    function getResolution(address market) external view returns (Resolution memory);

    /// @notice Returns whether an address is an authorized resolver
    function authorizedResolvers(address resolver) external view returns (bool);
}
