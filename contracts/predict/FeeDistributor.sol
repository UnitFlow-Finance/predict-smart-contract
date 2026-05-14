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

    uint256 public buybackShare;   // default 6000
    uint256 public lpShare;        // default 2000
    uint256 public treasuryShare;  // default 2000

    mapping(address => uint256) public pendingFees;
    mapping(address => bool) public authorizedMarkets;

    /// @dev Addresses (e.g. the Factory) that may call authorizeMarket
    mapping(address => bool) public authorizedCallers;

    // ─── Initializer ──────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the contract
    /// @param _unitRouter  UnitFlow router for UNIT buyback-and-burn
    /// @param _treasury    Treasury multisig address (20%)
    /// @param _lpRewardPool LP reward pool address (20%)
    /// @param _owner       Protocol owner (Gnosis Safe)
    function initialize(
        address _unitRouter,
        address _treasury,
        address _lpRewardPool,
        address _owner
    ) external initializer {
        require(_unitRouter != address(0), "FeeDistributor: zero unitRouter");
        require(_treasury != address(0), "FeeDistributor: zero treasury");
        require(_lpRewardPool != address(0), "FeeDistributor: zero lpRewardPool");
        require(_owner != address(0), "FeeDistributor: zero owner");

        __Ownable_init(_owner);

        unitRouter = _unitRouter;
        treasury = _treasury;
        lpRewardPool = _lpRewardPool;

        buybackShare = 6_000;
        lpShare = 2_000;
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
    /// @dev Caller must have already transferred `amount` tokens to this contract
    ///      before calling (or this contract must be the recipient of a safeTransfer).
    ///      Markets call this after transferring fees via SafeERC20.
    function receiveFee(address currency, uint256 amount) external onlyAuthorized {
        require(currency != address(0), "FeeDistributor: zero currency");
        require(amount > 0, "FeeDistributor: zero amount");

        pendingFees[currency] += amount;

        emit FeeReceived(msg.sender, currency, amount);
    }

    /// @inheritdoc IFeeDistributor
    /// @dev Keeper-callable. Distributes all pending fees for `currency`.
    function distributeFees(address currency) external nonReentrant {
        uint256 total = pendingFees[currency];
        require(total > 0, "FeeDistributor: nothing to distribute");

        pendingFees[currency] = 0;

        uint256 buybackAmount = (total * buybackShare) / BASIS_POINTS;
        uint256 lpAmount = (total * lpShare) / BASIS_POINTS;
        // Assign remainder to treasury to avoid dust from integer division
        uint256 treasuryAmount = total - buybackAmount - lpAmount;

        // 60% → UNIT buyback-and-burn via UnitFlow router
        IERC20(currency).safeIncreaseAllowance(unitRouter, buybackAmount);
        IUnitFlowRouter(unitRouter).buybackAndBurn(currency, buybackAmount);

        // 20% → LP reward pool
        IERC20(currency).safeTransfer(lpRewardPool, lpAmount);

        // 20% → treasury
        IERC20(currency).safeTransfer(treasury, treasuryAmount);

        emit FeesDistributed(currency, buybackAmount, lpAmount, treasuryAmount);
    }

    /// @inheritdoc IFeeDistributor
    /// @dev Callable by owner or any address granted via grantCallerRole
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
    }

    /// @notice Revokes caller role
    function revokeCallerRole(address caller) external onlyOwner {
        authorizedCallers[caller] = false;
    }

    /// @inheritdoc IFeeDistributor
    function updateSplit(
        uint256 _buyback,
        uint256 _lp,
        uint256 _treasury
    ) external onlyOwner {
        require(_buyback + _lp + _treasury == BASIS_POINTS, "FeeDistributor: split != 10000");
        buybackShare = _buyback;
        lpShare = _lp;
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

    /// @inheritdoc IFeeDistributor
    function updateAddresses(
        address _unitRouter,
        address _treasury,
        address _lpRewardPool
    ) external onlyOwner {
        require(_unitRouter != address(0), "FeeDistributor: zero unitRouter");
        require(_treasury != address(0), "FeeDistributor: zero treasury");
        require(_lpRewardPool != address(0), "FeeDistributor: zero lpRewardPool");

        unitRouter = _unitRouter;
        treasury = _treasury;
        lpRewardPool = _lpRewardPool;

        emit AddressesUpdated(_unitRouter, _treasury, _lpRewardPool);
    }
}
