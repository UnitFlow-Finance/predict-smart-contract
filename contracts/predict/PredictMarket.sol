// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPredictMarket.sol";
import "../interfaces/IFeeDistributor.sol";

/// @title PredictMarket
/// @notice AMM-based binary prediction market. One instance per market, deployed
///         by PredictMarketFactory via CREATE2.
///
///         Pricing model (constant-product adapted for binary outcomes):
///           yesPool * noPool = k
///           yesPrice = noPool / (yesPool + noPool)
///           noPrice  = yesPool / (yesPool + noPool)
///
///         Shares on YES stake:
///           sharesIssued = netAmount * noPool / yesPool
///           yesPool     += netAmount
///
///         Shares on NO stake:
///           sharesIssued = netAmount * yesPool / noPool
///           noPool      += netAmount
///
///         Claim (winning side):
///           grossPayout = winningShares * (yesPool + noPool) / totalWinningShares
///           netPayout   = grossPayout - claimFee
contract PredictMarket is ReentrancyGuard, Pausable, IPredictMarket {
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant MIN_STAKE = 1e6; // 1 USDC/EURC (6 decimals)

    // ─── State ────────────────────────────────────────────────────────────────

    MarketInfo private _marketInfo;

    address public factory;
    address public feeDistributor;

    uint256 public yesPool;
    uint256 public noPool;
    uint256 public totalStaked;
    uint256 public totalYesShares;
    uint256 public totalNoShares;

    uint256 public protocolFeeRate; // basis points, e.g. 100 = 1%
    uint256 public claimFeeRate;    // basis points, e.g. 50 = 0.5%

    bool public resolved;
    bool public outcome; // true = YES wins, false = NO wins
    bool public seeded;

    mapping(address => UserPosition) private _positions;
    address[] private _participants;
    mapping(address => bool) private _isParticipant;

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyFactory() {
        require(msg.sender == factory, "PredictMarket: not factory");
        _;
    }

    modifier onlyResolver() {
        require(
            msg.sender == _marketInfo.resolver,
            "PredictMarket: not resolver"
        );
        _;
    }

    modifier notResolved() {
        require(!resolved, "PredictMarket: already resolved");
        _;
    }

    modifier isResolved() {
        require(resolved, "PredictMarket: not resolved");
        _;
    }

    modifier beforeResolutionDate() {
        require(
            block.timestamp < _marketInfo.resolutionDate,
            "PredictMarket: past resolution date"
        );
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @notice Deployed by PredictMarketFactory. All parameters are immutable after construction.
    constructor(
        bytes32 marketId,
        address _factory,
        address _feeDistributor,
        string memory question,
        string memory description,
        string memory category,
        string[] memory tags,
        address currency,
        uint256 resolutionDate,
        address resolver,
        string memory oracleSource,
        address creator,
        uint256 _protocolFeeRate,
        uint256 _claimFeeRate
    ) {
        require(_factory != address(0), "PredictMarket: zero factory");
        require(_feeDistributor != address(0), "PredictMarket: zero feeDistributor");
        require(currency != address(0), "PredictMarket: zero currency");
        require(resolver != address(0), "PredictMarket: zero resolver");
        require(creator != address(0), "PredictMarket: zero creator");
        require(resolutionDate > block.timestamp, "PredictMarket: invalid resolutionDate");

        factory = _factory;
        feeDistributor = _feeDistributor;
        protocolFeeRate = _protocolFeeRate;
        claimFeeRate = _claimFeeRate;

        _marketInfo = MarketInfo({
            marketId: marketId,
            question: question,
            description: description,
            category: category,
            tags: tags,
            currency: currency,
            resolutionDate: resolutionDate,
            resolver: resolver,
            oracleSource: oracleSource,
            creator: creator,
            createdAt: block.timestamp
        });
    }

    // ─── Factory Functions ────────────────────────────────────────────────────

    /// @inheritdoc IPredictMarket
    /// @dev Factory transfers `amount` tokens to this contract before calling.
    ///      Splits 50/50 between yesPool and noPool to bootstrap equal odds.
    function seedLiquidity(uint256 amount) external onlyFactory {
        require(!seeded, "PredictMarket: already seeded");
        require(amount >= 10e6, "PredictMarket: liquidity below minimum");

        seeded = true;

        // 50/50 split; any odd wei goes to yesPool
        uint256 half = amount / 2;
        yesPool = amount - half; // handles odd amounts
        noPool = half;

        emit LiquiditySeeded(yesPool, noPool);
    }

    /// @inheritdoc IPredictMarket
    function emergencyPause() external onlyFactory {
        _pause();
    }

    /// @inheritdoc IPredictMarket
    function emergencyUnpause() external onlyFactory {
        _unpause();
    }

    // ─── Staking ──────────────────────────────────────────────────────────────

    /// @inheritdoc IPredictMarket
    function stakeYes(uint256 amount)
        external
        nonReentrant
        whenNotPaused
        notResolved
        beforeResolutionDate
    {
        _stake(amount, true);
    }

    /// @inheritdoc IPredictMarket
    function stakeNo(uint256 amount)
        external
        nonReentrant
        whenNotPaused
        notResolved
        beforeResolutionDate
    {
        _stake(amount, false);
    }

    /// @dev Core AMM staking logic.
    function _stake(uint256 amount, bool isYes) internal {
        require(amount >= MIN_STAKE, "PredictMarket: below minimum stake");
        require(seeded, "PredictMarket: not seeded");

        IERC20 token = IERC20(_marketInfo.currency);

        // Pull tokens from staker
        token.safeTransferFrom(msg.sender, address(this), amount);

        // Deduct protocol fee
        uint256 fee = (amount * protocolFeeRate) / BASIS_POINTS;
        uint256 netAmount = amount - fee;

        // Route fee to distributor
        token.safeTransfer(feeDistributor, fee);
        IFeeDistributor(feeDistributor).receiveFee(_marketInfo.currency, fee);

        // AMM share calculation
        uint256 sharesIssued;
        if (isYes) {
            sharesIssued = (netAmount * noPool) / yesPool;
            yesPool += netAmount;
            totalYesShares += sharesIssued;
            _positions[msg.sender].yesShares += sharesIssued;
        } else {
            sharesIssued = (netAmount * yesPool) / noPool;
            noPool += netAmount;
            totalNoShares += sharesIssued;
            _positions[msg.sender].noShares += sharesIssued;
        }

        require(sharesIssued > 0, "PredictMarket: zero shares issued");

        _positions[msg.sender].totalStaked += amount;
        totalStaked += amount;

        // Track unique participants
        if (!_isParticipant[msg.sender]) {
            _isParticipant[msg.sender] = true;
            _participants.push(msg.sender);
        }

        (uint256 yesOdds, uint256 noOdds) = getOdds();

        emit Staked(msg.sender, isYes, amount, sharesIssued, fee, yesOdds, noOdds);
    }

    // ─── Resolution & Claims ──────────────────────────────────────────────────

    /// @inheritdoc IPredictMarket
    /// @dev Only callable by the designated resolver, and only after resolutionDate.
    function resolveMarket(bool _outcome)
        external
        onlyResolver
        notResolved
    {
        require(
            block.timestamp >= _marketInfo.resolutionDate,
            "PredictMarket: before resolution date"
        );

        resolved = true;
        outcome = _outcome;

        emit MarketResolved(_outcome, msg.sender);
    }

    /// @inheritdoc IPredictMarket
    function claimReward() external nonReentrant isResolved {
        UserPosition storage pos = _positions[msg.sender];
        require(!pos.claimed, "PredictMarket: already claimed");

        uint256 winningShares = outcome ? pos.yesShares : pos.noShares;
        require(winningShares > 0, "PredictMarket: no winning position");

        uint256 totalWinningShares = outcome ? totalYesShares : totalNoShares;
        uint256 totalPool = yesPool + noPool;

        uint256 grossPayout = (winningShares * totalPool) / totalWinningShares;
        uint256 claimFee = (grossPayout * claimFeeRate) / BASIS_POINTS;
        uint256 netPayout = grossPayout - claimFee;

        pos.claimed = true;

        IERC20 token = IERC20(_marketInfo.currency);

        // Route claim fee to distributor
        token.safeTransfer(feeDistributor, claimFee);
        IFeeDistributor(feeDistributor).receiveFee(_marketInfo.currency, claimFee);

        // Pay winner
        token.safeTransfer(msg.sender, netPayout);

        emit Claimed(msg.sender, winningShares, netPayout, claimFee);
    }

    // ─── View Functions ───────────────────────────────────────────────────────

    /// @inheritdoc IPredictMarket
    /// @dev Returns odds in basis points. Remainder from integer division is assigned
    ///      to noOdds so the two values always sum exactly to BASIS_POINTS (10000).
    function getOdds() public view returns (uint256 yesOdds, uint256 noOdds) {
        uint256 total = yesPool + noPool;
        if (total == 0) {
            return (5_000, 5_000);
        }
        // yesPrice = noPool / total  (probability of YES)
        yesOdds = (noPool * BASIS_POINTS) / total;
        noOdds = BASIS_POINTS - yesOdds;
    }

    /// @inheritdoc IPredictMarket
    function getMarketInfo() external view returns (MarketInfo memory) {
        return _marketInfo;
    }

    /// @inheritdoc IPredictMarket
    function getUserPosition(address user) external view returns (UserPosition memory) {
        return _positions[user];
    }

    /// @inheritdoc IPredictMarket
    function getTotalStaked() external view returns (uint256) {
        return totalStaked;
    }

    /// @inheritdoc IPredictMarket
    function getParticipantCount() external view returns (uint256) {
        return _participants.length;
    }

    /// @inheritdoc IPredictMarket
    function getParticipants() external view returns (address[] memory) {
        return _participants;
    }

    /// @inheritdoc IPredictMarket
    /// @dev Returns (0, 0, 0) if the market is not resolved or user has no winning position.
    function estimatePayout(address user)
        external
        view
        returns (uint256 gross, uint256 net, uint256 fee)
    {
        if (!resolved) return (0, 0, 0);

        UserPosition storage pos = _positions[user];
        if (pos.claimed) return (0, 0, 0);

        uint256 winningShares = outcome ? pos.yesShares : pos.noShares;
        if (winningShares == 0) return (0, 0, 0);

        uint256 totalWinningShares = outcome ? totalYesShares : totalNoShares;
        uint256 totalPool = yesPool + noPool;

        gross = (winningShares * totalPool) / totalWinningShares;
        fee = (gross * claimFeeRate) / BASIS_POINTS;
        net = gross - fee;
    }
}
