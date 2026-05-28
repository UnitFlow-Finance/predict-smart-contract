// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../predict/PredictMarket.sol";
import "../interfaces/IPredictMarketFactory.sol";
import "../interfaces/IFeeDistributor.sol";

/// @title PredictMarketFactory
/// @notice Protocol deployer and market registry. Deploys PredictMarket instances
///         via CREATE2, seeds initial liquidity, and maintains the global market registry.
contract PredictMarketFactory is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    IPredictMarketFactory
{
    using SafeERC20 for IERC20;

    // ─── Constants ────────────────────────────────────────────────────────────

    uint256 public constant MAX_FEE_RATE = 500;       // 5% ceiling
    uint256 public constant MAX_QUESTION_LENGTH = 200;
    uint256 public constant MIN_INITIAL_LIQUIDITY = 10e6; // 10 USDC/EURC

    // ─── State ────────────────────────────────────────────────────────────────

    address public feeDistributor;
    address public oracle;
    address public usdc;
    address public eurc;

    uint256 public protocolFeeRate;     // default 100 bps (1%)
    uint256 public claimFeeRate;        // default 50 bps (0.5%)
    uint256 public marketCreationFee;   // default 5e6 (5 USDC)

    /// @dev marketId → market address
    mapping(bytes32 => address) public markets;

    /// @dev Ordered list of all deployed market addresses
    address[] private _allMarkets;

    /// @dev Nonce for CREATE2 salt uniqueness
    uint256 private _marketNonce;

    // ─── Initializer ──────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the factory
    /// @param _feeDistributor FeeDistributor proxy address
    /// @param _oracle         PredictOracle proxy address
    /// @param _usdc           USDC token address on Arc
    /// @param _eurc           EURC token address on Arc
    /// @param _owner          Protocol owner (Gnosis Safe)
    function initialize(
        address _feeDistributor,
        address _oracle,
        address _usdc,
        address _eurc,
        address _owner
    ) external initializer {
        require(_feeDistributor != address(0), "Factory: zero feeDistributor");
        require(_oracle != address(0), "Factory: zero oracle");
        require(_usdc != address(0), "Factory: zero usdc");
        require(_eurc != address(0), "Factory: zero eurc");
        require(_owner != address(0), "Factory: zero owner");

        __Ownable_init(_owner);
        __Pausable_init();

        feeDistributor = _feeDistributor;
        oracle = _oracle;
        usdc = _usdc;
        eurc = _eurc;

        protocolFeeRate = 100;   // 1%
        claimFeeRate = 50;       // 0.5%
        marketCreationFee = 5e6; // 5 USDC
    }

    // ─── Market Creation ──────────────────────────────────────────────────────

    /// @inheritdoc IPredictMarketFactory
    function createMarket(MarketParams calldata params)
        external
        nonReentrant
        whenNotPaused
        returns (address marketAddress)
    {
        _validateParams(params);

        IERC20 currency = IERC20(params.currency);

        // Collect creation fee + initial liquidity from caller
        uint256 totalRequired = marketCreationFee + params.initialLiquidity;
        currency.safeTransferFrom(msg.sender, address(this), totalRequired);

        // Route creation fee to distributor (skip if fee is zero to avoid revert)
        if (marketCreationFee > 0) {
            currency.safeTransfer(feeDistributor, marketCreationFee);
            IFeeDistributor(feeDistributor).receiveFee(params.currency, marketCreationFee);
        }

        // Derive deterministic marketId and CREATE2 salt
        bytes32 marketId = _computeMarketId(params, msg.sender);
        bytes32 salt = keccak256(abi.encodePacked(marketId, _marketNonce));
        _marketNonce++;

        // Deploy market
        marketAddress = _deployMarket(params, marketId, salt);

        // Register
        markets[marketId] = marketAddress;
        _allMarkets.push(marketAddress);

        // Authorize market in FeeDistributor
        IFeeDistributor(feeDistributor).authorizeMarket(marketAddress);

        // Seed initial liquidity: transfer tokens then call seedLiquidity
        currency.safeTransfer(marketAddress, params.initialLiquidity);
        PredictMarket(marketAddress).seedLiquidity(params.initialLiquidity);

        emit MarketCreated(
            marketId,
            marketAddress,
            msg.sender,
            params.question,
            params.currency,
            params.resolutionDate
        );
    }

    // ─── Admin Functions ──────────────────────────────────────────────────────

    /// @inheritdoc IPredictMarketFactory
    function updateFeeConfig(uint256 _protocolFeeRate, uint256 _claimFeeRate)
        external
        onlyOwner
    {
        require(_protocolFeeRate <= MAX_FEE_RATE, "Factory: protocolFeeRate too high");
        require(_claimFeeRate <= MAX_FEE_RATE, "Factory: claimFeeRate too high");
        protocolFeeRate = _protocolFeeRate;
        claimFeeRate = _claimFeeRate;
        emit FeeConfigUpdated(_protocolFeeRate, _claimFeeRate);
    }

    /// @inheritdoc IPredictMarketFactory
    function updateMarketCreationFee(uint256 newFee) external onlyOwner {
        marketCreationFee = newFee;
        emit MarketCreationFeeUpdated(newFee);
    }

    /// @inheritdoc IPredictMarketFactory
    function updateFeeDistributor(address newFeeDistributor) external onlyOwner {
        require(newFeeDistributor != address(0), "Factory: zero feeDistributor");
        feeDistributor = newFeeDistributor;
        emit FeeDistributorUpdated(newFeeDistributor);
    }

    /// @inheritdoc IPredictMarketFactory
    function pause() external onlyOwner {
        _pause();
    }

    /// @inheritdoc IPredictMarketFactory
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Emergency pause on a specific market (kills staking)
    function pauseMarket(address market) external onlyOwner {
        PredictMarket(market).emergencyPause();
    }

    /// @notice Emergency unpause on a specific market
    function unpauseMarket(address market) external onlyOwner {
        PredictMarket(market).emergencyUnpause();
    }

    // ─── View Functions ───────────────────────────────────────────────────────

    /// @inheritdoc IPredictMarketFactory
    function getAllMarkets() external view returns (address[] memory) {
        return _allMarkets;
    }

    /// @inheritdoc IPredictMarketFactory
    function getMarketCount() external view returns (uint256) {
        return _allMarkets.length;
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    function _validateParams(MarketParams calldata params) internal view {
        require(
            params.currency == usdc || params.currency == eurc,
            "Factory: unsupported currency"
        );
        require(
            params.resolutionDate > block.timestamp,
            "Factory: resolutionDate in past"
        );
        require(
            params.initialLiquidity >= MIN_INITIAL_LIQUIDITY,
            "Factory: initialLiquidity too low"
        );
        require(
            bytes(params.question).length > 0 &&
                bytes(params.question).length <= MAX_QUESTION_LENGTH,
            "Factory: invalid question length"
        );
        // Resolver must be the oracle contract — prevents arbitrary EOA resolvers
        // that would bypass the 24-hour dispute window and allow direct fund drain.
        require(params.resolver == oracle, "Factory: resolver must be oracle");
    }

    function _computeMarketId(MarketParams calldata params, address creator)
        internal
        view
        returns (bytes32)
    {
        // block.timestamp intentionally excluded — nonce + question + creator
        // provides sufficient uniqueness without validator-manipulable entropy
        return keccak256(
            abi.encodePacked(
                params.question,
                params.currency,
                params.resolutionDate,
                creator,
                _marketNonce,
                block.chainid
            )
        );
    }

    function _deployMarket(
        MarketParams calldata params,
        bytes32 marketId,
        bytes32 salt
    ) internal returns (address) {
        PredictMarket market = new PredictMarket{salt: salt}(
            marketId,
            address(this),
            feeDistributor,
            params.question,
            params.description,
            params.category,
            params.tags,
            params.currency,
            params.resolutionDate,
            params.resolver,
            params.oracleSource,
            msg.sender,
            protocolFeeRate,
            claimFeeRate
        );
        return address(market);
    }
}
