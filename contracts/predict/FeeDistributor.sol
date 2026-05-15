// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IUnitFlowRouter.sol";
import "../interfaces/IFeeDistributor.sol";

/// @title FeeDistributor
/// @notice Receives all protocol fees from PredictMarket instances and routes
///         them 60% buyback-and-burn / 20% LP rewards / 20% treasury.
///
/// @dev Buyback modes:
///   - Manual mode  (unitToken == address(0)): the buyback share accumulates in
///     pendingBuyback[currency] and is NOT sent anywhere automatically.
///     The owner calls executeBuyback() when UNIT is live on-chain.
///   - Auto mode    (unitToken != address(0)): distributeFees() swaps the
///     buyback share for UNIT via the V2.5 router and sends it to deadAddress.
///     If the swap reverts the share falls back to treasury so fees are never lost.
///
/// @dev Security properties:
///   - ReentrancyGuard on distributeFees and executeBuyback
///   - SafeERC20 on all token transfers
///   - forceApprove (zero then set) prevents allowance accumulation on router
///   - pendingFees / pendingBuyback zeroed before any external calls (CEI)
///   - Role changes emit events for off-chain monitoring
contract FeeDistributor is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuard,
    IFeeDistributor
{
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant BASIS_POINTS = 10_000;

    // ─── State ────────────────────────────────────────────────────────────────

    address public unitRouter;
    address public treasury;
    address public lpRewardPool;
    address public unitToken;
    address public deadAddress;

    uint256 public buybackShare;  // default 6000
    uint256 public lpShare;       // default 2000
    uint256 public treasuryShare; // default 2000

    mapping(address => uint256) public pendingFees;
    /// @notice Accumulated buyback share awaiting manual executeBuyback() call.
    ///         Only non-zero when unitToken == address(0) (manual mode).
    mapping(address => uint256) public pendingBuyback;
    mapping(address => bool)    public authorizedMarkets;
    mapping(address => bool)    public authorizedCallers;

    // ─── Events (additional to interface) ────────────────────────────────────

    event CallerRoleGranted(address indexed caller);
    event CallerRoleRevoked(address indexed caller);
    event BuybackFailed(address indexed currency, uint256 amount, bytes reason);
    event BuybackExecuted(address indexed currency, uint256 amountIn, uint256 amountOutMin);
    event UnitTokenUpdated(address indexed previous, address indexed next);

    // ─── Initializer ──────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param _unitToken Pass address(0) to start in manual buyback mode.
    ///                   Call updateUnitToken() once UNIT is deployed on-chain.
    function initialize(
        address _unitRouter,
        address _treasury,
        address _lpRewardPool,
        address _unitToken,
        address _owner
    ) external initializer {
        require(_unitRouter   != address(0), "FeeDistributor: zero unitRouter");
        require(_treasury     != address(0), "FeeDistributor: zero treasury");
        require(_lpRewardPool != address(0), "FeeDistributor: zero lpRewardPool");
        require(_owner        != address(0), "FeeDistributor: zero owner");
        // _unitToken may be address(0) — that enables manual buyback mode

        __Ownable_init(_owner);

        unitRouter   = _unitRouter;
        treasury     = _treasury;
        lpRewardPool = _lpRewardPool;
        unitToken    = _unitToken;   // address(0) = manual mode
        deadAddress  = 0x000000000000000000000000000000000000dEaD;

        buybackShare  = 6_000;
        lpShare       = 2_000;
        treasuryShare = 2_000;
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyAuthorized() {
        require(
            authorizedMarkets[msg.sender] || msg.sender == owner(),
            "FeeDistributor: not authorized"
        );
        _;
    }

    // ─── External Functions ───────────────────────────────────────────────────

    /// @inheritdoc IFeeDistributor
    function receiveFee(address currency, uint256 amount) external onlyAuthorized {
        require(currency != address(0), "FeeDistributor: zero currency");
        require(amount > 0,             "FeeDistributor: zero amount");

        pendingFees[currency] += amount;

        emit FeeReceived(msg.sender, currency, amount);
    }

    /// @inheritdoc IFeeDistributor
    /// @dev Keeper-callable. CEI: zero pendingFees before any external calls.
    ///
    ///      Buyback behaviour depends on whether unitToken is set:
    ///
    ///      Manual mode (unitToken == address(0)):
    ///        The buyback share is held in pendingBuyback[currency].
    ///        No swap is attempted. Call executeBuyback() once UNIT is live.
    ///
    ///      Auto mode (unitToken != address(0)):
    ///        The buyback share is swapped for UNIT via the V2.5 router and
    ///        sent to deadAddress. If the swap reverts the share falls back to
    ///        treasury so fees are never permanently locked.
    function distributeFees(address currency) external nonReentrant {
        uint256 total = pendingFees[currency];
        require(total > 0, "FeeDistributor: nothing to distribute");

        // ── Effects (zero before interactions) ────────────────────────────────
        pendingFees[currency] = 0;

        uint256 buybackAmount  = (total * buybackShare)  / BASIS_POINTS;
        uint256 lpAmount       = (total * lpShare)       / BASIS_POINTS;
        uint256 treasuryAmount = total - buybackAmount - lpAmount;

        // ── Interactions ──────────────────────────────────────────────────────

        if (unitToken == address(0)) {
            // ── Manual mode: park the buyback share for later execution ───────
            pendingBuyback[currency] += buybackAmount;
            buybackAmount = 0; // reported as 0 in the event; pendingBuyback tracks it
        } else {
            // ── Auto mode: swap for UNIT and send to dead address ─────────────
            // Uses SupportingFeeOnTransferTokens because UNIT is a
            // deflationary/reflection token — the standard swap reverts on it.
            address[] memory path = new address[](2);
            path[0] = currency;  // USDC or EURC (fee input token)
            path[1] = unitToken; // UNIT token output

            // forceApprove (zero → set) prevents allowance accumulation
            IERC20(currency).forceApprove(unitRouter, buybackAmount);
            try IUnitFlowV25Router(unitRouter)
                .swapExactTokensForTokensSupportingFeeOnTransferTokens(
                    buybackAmount,
                    0,                    // amountOutMin: accept any amount
                    path,
                    deadAddress,          // UNIT goes straight to burn address
                    block.timestamp + 300 // 5-minute deadline
                )
            {
                // success — allowance consumed by router
            } catch (bytes memory reason) {
                // Swap failed: reset allowance, redirect buyback share to treasury
                IERC20(currency).forceApprove(unitRouter, 0);
                treasuryAmount += buybackAmount;
                buybackAmount   = 0;
                emit BuybackFailed(currency, buybackAmount, reason);
            }
        }

        // 20% → LP reward pool
        if (lpAmount > 0) {
            IERC20(currency).safeTransfer(lpRewardPool, lpAmount);
        }

        // 20% → treasury (+ any auto-mode swap fallback)
        if (treasuryAmount > 0) {
            IERC20(currency).safeTransfer(treasury, treasuryAmount);
        }

        emit FeesDistributed(currency, buybackAmount, lpAmount, treasuryAmount);
    }

    /// @notice Executes a manual UNIT buyback using accumulated pendingBuyback funds.
    /// @dev    Only callable by owner. Requires unitToken to be set (auto mode).
    ///         CEI: pendingBuyback zeroed before the swap call.
    /// @param currency     The fee token to spend (USDC or EURC).
    /// @param amountOutMin Minimum UNIT to receive — set via off-chain quote to
    ///                     protect against sandwich attacks.
    function executeBuyback(address currency, uint256 amountOutMin)
        external
        onlyOwner
        nonReentrant
    {
        require(unitToken != address(0), "FeeDistributor: unitToken not set");

        uint256 amount = pendingBuyback[currency];
        require(amount > 0, "FeeDistributor: no pending buyback");

        // ── Effects ───────────────────────────────────────────────────────────
        pendingBuyback[currency] = 0;

        // ── Interactions ──────────────────────────────────────────────────────
        address[] memory path = new address[](2);
        path[0] = currency;
        path[1] = unitToken;

        IERC20(currency).forceApprove(unitRouter, amount);
        IUnitFlowV25Router(unitRouter)
            .swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amount,
                amountOutMin,
                path,
                deadAddress,
                block.timestamp + 300
            );

        emit BuybackExecuted(currency, amount, amountOutMin);
    }

    /// @inheritdoc IFeeDistributor
    function authorizeMarket(address market) external {
        require(
            msg.sender == owner() || authorizedCallers[msg.sender],
            "FeeDistributor: not authorized to register market"
        );
        require(market != address(0), "FeeDistributor: zero market");
        authorizedMarkets[market] = true;
        emit MarketAuthorized(market);
    }

    /// @notice Grants an address (e.g. the Factory) permission to call authorizeMarket
    function grantCallerRole(address caller) external onlyOwner {
        require(caller != address(0), "FeeDistributor: zero caller");
        authorizedCallers[caller] = true;
        emit CallerRoleGranted(caller);
    }

    /// @notice Revokes caller role
    function revokeCallerRole(address caller) external onlyOwner {
        authorizedCallers[caller] = false;
        emit CallerRoleRevoked(caller);
    }

    /// @inheritdoc IFeeDistributor
    function updateSplit(
        uint256 _buyback,
        uint256 _lp,
        uint256 _treasury
    ) external onlyOwner {
        require(_buyback + _lp + _treasury == BASIS_POINTS, "FeeDistributor: split != 10000");
        buybackShare  = _buyback;
        lpShare       = _lp;
        treasuryShare = _treasury;
        emit SplitUpdated(_buyback, _lp, _treasury);
    }

    /// @inheritdoc IFeeDistributor
    function getPendingFees(address currency) external view returns (uint256) {
        return pendingFees[currency];
    }

    /// @notice Returns the accumulated buyback share awaiting manual execution.
    ///         Non-zero only in manual mode (unitToken == address(0)).
    function getPendingBuyback(address currency) external view returns (uint256) {
        return pendingBuyback[currency];
    }

    /// @inheritdoc IFeeDistributor
    function isAuthorizedMarket(address market) external view returns (bool) {
        return authorizedMarkets[market];
    }

    /// @notice Sets the UNIT token address, switching between buyback modes.
    ///         Pass address(0) to return to manual mode (pendingBuyback accumulates).
    ///         Pass the live UNIT address to enable automatic swaps in distributeFees.
    function updateUnitToken(address _unitToken) external onlyOwner {
        emit UnitTokenUpdated(unitToken, _unitToken);
        unitToken = _unitToken;
    }

    /// @inheritdoc IFeeDistributor
    function updateAddresses(
        address _unitRouter,
        address _treasury,
        address _lpRewardPool
    ) external onlyOwner {
        require(_unitRouter   != address(0), "FeeDistributor: zero unitRouter");
        require(_treasury     != address(0), "FeeDistributor: zero treasury");
        require(_lpRewardPool != address(0), "FeeDistributor: zero lpRewardPool");

        unitRouter   = _unitRouter;
        treasury     = _treasury;
        lpRewardPool = _lpRewardPool;

        emit AddressesUpdated(_unitRouter, _treasury, _lpRewardPool);
    }
}
