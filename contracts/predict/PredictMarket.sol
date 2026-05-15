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
///           yesPrice = noPool / (yesPool + noPool)   → P(YES)
///           noPrice  = yesPool / (yesPool + noPool)  → P(NO)
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
///
/// @dev Security properties:
///   - ReentrancyGuard on all state-mutating external functions
///   - SafeERC20 on every token transfer
///   - Strict Checks-Effects-Interactions ordering throughout
///   - Pausable: staking halted on pause; claims always remain open
///   - Max stake cap (10% of pool) prevents single-tx price manipulation
///   - Zero-fee transfers skipped to avoid FeeDistributor revert on zero amount
///   - seedLiquidity verifies actual token balance before splitting
///   - Fee-on-transfer token guard (balance diff check)
contract PredictMarket is ReentrancyGuard, Pausable, IPredictMarket {
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant BASIS_POINTS  = 10_000;
    uint256 public constant MIN_STAKE     = 1e6;       // 1 USDC/EURC (6 decimals)
    /// @dev Single stake capped at 10% of total pool to limit price manipulation
    uint256 public constant MAX_STAKE_BPS = 1_000;     // 10% of (yesPool + noPool)
    uint256 public constant MAX_STAKE_ABS = 100_000e6; // hard cap: 100,000 USDC/EURC

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
        require(_factory != address(0),        "PredictMarket: zero factory");
        require(_feeDistributor != address(0), "PredictMarket: zero feeDistributor");
        require(currency != address(0),        "PredictMarket: zero currency");
        require(resolver != address(0),        "PredictMarket: zero resolver");
        require(creator != address(0),         "PredictMarket: zero creator");
        require(resolutionDate > block.timestamp, "PredictMarket: invalid resolutionDate");
        require(_protocolFeeRate <= 500,       "PredictMarket: protocolFeeRate too high");
        require(_claimFeeRate <= 500,          "PredictMarket: claimFeeRate too high");

        factory         = _factory;
        feeDistributor  = _feeDistributor;
        protocolFeeRate = _protocolFeeRate;
        claimFeeRate    = _claimFeeRate;

        _marketInfo = MarketInfo({
            marketId:       marketId,
            question:       question,
            description:    description,
            category:       category,
            tags:           tags,
            currency:       currency,
            resolutionDate: resolutionDate,
            resolver:       resolver,
            oracleSource:   oracleSource,
            creator:        creator,
            createdAt:      block.timestamp
        });
    }

    // ─── Factory Functions ────────────────────────────────────────────────────

    /// @inheritdoc IPredictMarket
    /// @dev Factory transfers `amount` tokens before calling. Balance is verified
    ///      to guard against any accounting mismatch.
    function seedLiquidity(uint256 amount) external onlyFactory {
        require(!seeded, "PredictMarket: already seeded");
        require(amount >= 10e6, "PredictMarket: liquidity below minimum");

        uint256 bal = IERC20(_marketInfo.currency).balanceOf(address(this));
        require(bal >= amount, "PredictMarket: insufficient balance for seed");

        seeded = true;

        uint256 half = amount / 2;
        yesPool = amount - half; // odd wei goes to yesPool
        noPool  = half;

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

    /// @dev Core AMM staking logic. Strict Checks-Effects-Interactions.
    function _stake(uint256 amount, bool isYes) internal {
        // ── Checks ───────────────────────────────────────────────────────────
        require(amount >= MIN_STAKE,     "PredictMarket: below minimum stake");
        require(amount <= MAX_STAKE_ABS, "PredictMarket: exceeds absolute max stake");
        require(seeded,                  "PredictMarket: not seeded");

        // Pool-relative cap: max 10% of current pool per stake
        uint256 poolTotal    = yesPool + noPool;
        uint256 maxFromPool  = (poolTotal * MAX_STAKE_BPS) / BASIS_POINTS;
        if (maxFromPool > MAX_STAKE_ABS) maxFromPool = MAX_STAKE_ABS;
        require(amount <= maxFromPool, "PredictMarket: stake exceeds pool cap");

        // ── Pull tokens (verify exact amount received) ────────────────────────
        IERC20 token = IERC20(_marketInfo.currency);
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balBefore;
        require(received == amount, "PredictMarket: transfer amount mismatch");

        // ── Compute fee and net ───────────────────────────────────────────────
        uint256 fee       = (amount * protocolFeeRate) / BASIS_POINTS;
        uint256 netAmount = amount - fee;

        // ── Effects (all state updates before external calls) ─────────────────
        uint256 sharesIssued;
        if (isYes) {
            sharesIssued = (netAmount * noPool) / yesPool;
            yesPool      += netAmount;
            totalYesShares += sharesIssued;
            _positions[msg.sender].yesShares += sharesIssued;
        } else {
            sharesIssued = (netAmount * yesPool) / noPool;
            noPool       += netAmount;
            totalNoShares += sharesIssued;
            _positions[msg.sender].noShares += sharesIssued;
        }

        require(sharesIssued > 0, "PredictMarket: zero shares issued");

        _positions[msg.sender].totalStaked += amount;
        totalStaked += amount;

        if (!_isParticipant[msg.sender]) {
            _isParticipant[msg.sender] = true;
            _participants.push(msg.sender);
        }

        // ── Interactions (fee routing — after all state updates) ──────────────
        if (fee > 0) {
            token.safeTransfer(feeDistributor, fee);
            IFeeDistributor(feeDistributor).receiveFee(_marketInfo.currency, fee);
        }

        (uint256 yesOdds, uint256 noOdds) = getOdds();
        emit Staked(msg.sender, isYes, amount, sharesIssued, fee, yesOdds, noOdds);
    }

    // ─── Resolution & Claims ──────────────────────────────────────────────────

    /// @inheritdoc IPredictMarket
    function resolveMarket(bool _outcome)
        external
        onlyResolver
        notResolved
    {
        require(
            block.timestamp >= _marketInfo.resolutionDate,
            "PredictMarket: before resolution date"
        );

        // Effects before event
        resolved = true;
        outcome  = _outcome;

        emit MarketResolved(_outcome, msg.sender);
    }

    /// @inheritdoc IPredictMarket
    /// @dev Claims remain open even when paused. Strict CEI ordering.
    function claimReward() external nonReentrant isResolved {
        UserPosition storage pos = _positions[msg.sender];

        // ── Checks ───────────────────────────────────────────────────────────
        require(!pos.claimed, "PredictMarket: already claimed");

        uint256 winningShares      = outcome ? pos.yesShares : pos.noShares;
        require(winningShares > 0, "PredictMarket: no winning position");

        uint256 totalWinningShares = outcome ? totalYesShares : totalNoShares;
        require(totalWinningShares > 0, "PredictMarket: no winning shares");

        uint256 totalPool  = yesPool + noPool;
        uint256 grossPayout = (winningShares * totalPool) / totalWinningShares;
        require(grossPayout > 0, "PredictMarket: zero payout");

        uint256 claimFee  = (grossPayout * claimFeeRate) / BASIS_POINTS;
        uint256 netPayout = grossPayout - claimFee;

        // ── Effects ───────────────────────────────────────────────────────────
        pos.claimed = true;

        // ── Interactions ──────────────────────────────────────────────────────
        IERC20 token = IERC20(_marketInfo.currency);

        if (claimFee > 0) {
            token.safeTransfer(feeDistributor, claimFee);
            IFeeDistributor(feeDistributor).receiveFee(_marketInfo.currency, claimFee);
        }

        token.safeTransfer(msg.sender, netPayout);

        emit Claimed(msg.sender, winningShares, netPayout, claimFee);
    }

    // ─── View Functions ───────────────────────────────────────────────────────

    /// @inheritdoc IPredictMarket
    function getOdds() public view returns (uint256 yesOdds, uint256 noOdds) {
        uint256 total = yesPool + noPool;
        if (total == 0) return (5_000, 5_000);
        yesOdds = (noPool * BASIS_POINTS) / total;
        noOdds  = BASIS_POINTS - yesOdds;
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

    /// @notice Returns a paginated slice of participants to avoid gas DoS
    function getParticipantsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page, uint256 total)
    {
        total = _participants.length;
        if (offset >= total) return (new address[](0), total);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = _participants[i];
        }
    }

    /// @inheritdoc IPredictMarket
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
        if (totalWinningShares == 0) return (0, 0, 0);

        uint256 totalPool = yesPool + noPool;
        gross = (winningShares * totalPool) / totalWinningShares;
        fee   = (gross * claimFeeRate) / BASIS_POINTS;
        net   = gross - fee;
    }

    /// @notice Returns the current maximum allowed stake based on pool size
    function getMaxStake() external view returns (uint256) {
        uint256 poolTotal = yesPool + noPool;
        uint256 fromPool  = (poolTotal * MAX_STAKE_BPS) / BASIS_POINTS;
        return fromPool < MAX_STAKE_ABS ? fromPool : MAX_STAKE_ABS;
    }
}
