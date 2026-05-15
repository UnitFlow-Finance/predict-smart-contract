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
/// @dev Security properties:
///   - ReentrancyGuard on distributeFees
///   - SafeERC20 on all token transfers
///   - forceApprove (zero then set) prevents allowance accumulation on router
///   - try/catch on buybackAndBurn: if router reverts, buyback share falls back
///     to treasury so fees are never lost
///   - pendingFees zeroed before any external calls (CEI)
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
    mapping(address => bool)    public authorizedMarkets;
    mapping(address => bool)    public authorizedCallers;

    // ─── Events (additional to interface) ────────────────────────────────────

    event CallerRoleGranted(address indexed caller);
    event CallerRoleRevoked(address indexed caller);
    event BuybackFailed(address indexed currency, uint256 amount, bytes reason);

    // ─── Initializer ──────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

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
        require(_unitToken    != address(0), "FeeDistributor: zero unitToken");
        require(_owner        != address(0), "FeeDistributor: zero owner");

        __Ownable_init(_owner);

        unitRouter   = _unitRouter;
        treasury     = _treasury;
        lpRewardPool = _lpRewardPool;
        unitToken    = _unitToken;
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
    ///      If the router's buybackAndBurn reverts, the buyback share is redirected
    ///      to treasury so fees are never permanently locked.
    function distributeFees(address currency) external nonReentrant {
        uint256 total = pendingFees[currency];
        require(total > 0, "FeeDistributor: nothing to distribute");

        // ── Effects (zero before interactions) ────────────────────────────────
        pendingFees[currency] = 0;

        uint256 buybackAmount  = (total * buybackShare)  / BASIS_POINTS;
        uint256 lpAmount       = (total * lpShare)       / BASIS_POINTS;
        uint256 treasuryAmount = total - buybackAmount - lpAmount;

        // ── Interactions ──────────────────────────────────────────────────────

        // 60% → UNIT buyback via UnitFlow V2.5 router,
        // UNIT sent directly to dead address for burn.
        // Uses SupportingFeeOnTransferTokens variant because UNIT is a
        // deflationary/reflection token — the standard swap reverts on it.
        address[] memory path = new address[](2);
        path[0] = currency;   // USDC or EURC (fee input token)
        path[1] = unitToken;  // UNIT token output

        // Use forceApprove (zero → set) to avoid allowance accumulation
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
            // Router failed: reset allowance and redirect buyback share to treasury
            IERC20(currency).forceApprove(unitRouter, 0);
            treasuryAmount += buybackAmount;
            buybackAmount   = 0;
            emit BuybackFailed(currency, buybackAmount, reason);
        }

        // 20% → LP reward pool
        if (lpAmount > 0) {
            IERC20(currency).safeTransfer(lpRewardPool, lpAmount);
        }

        // 20% → treasury (+ any buyback fallback)
        if (treasuryAmount > 0) {
            IERC20(currency).safeTransfer(treasury, treasuryAmount);
        }

        emit FeesDistributed(currency, buybackAmount, lpAmount, treasuryAmount);
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

    /// @inheritdoc IFeeDistributor
    function isAuthorizedMarket(address market) external view returns (bool) {
        return authorizedMarkets[market];
    }

    /// @notice Updates the UNIT token address used for buyback routing
    function updateUnitToken(address _unitToken) external onlyOwner {
        require(_unitToken != address(0), "FeeDistributor: zero unitToken");
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
