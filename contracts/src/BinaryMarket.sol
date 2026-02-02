// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IConditionalTokens} from "./interfaces/IConditionalTokens.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";

/**
 * @title BinaryMarket
 * @notice A binary prediction market for BTC price (UP/DOWN) using Gnosis CTF.
 * @dev Lifecycle: PENDING → ACTIVE → RESOLVED
 *
 * Integration with Gnosis Conditional Tokens Framework:
 * - prepareCondition: Creates the binary condition
 * - splitPosition: Mints UP and DOWN tokens from collateral
 * - reportPayouts: Oracle adapter resolves the market
 * - redeemPositions: Winners redeem tokens for collateral
 */
contract BinaryMarket is ERC1155Holder {
    // ============ Constants ============

    /// @notice Number of outcomes (UP, DOWN)
    uint256 private constant OUTCOME_COUNT = 2;

    /// @notice Index set for UP outcome (binary: 01)
    uint256 private constant UP_INDEX_SET = 1;

    /// @notice Index set for DOWN outcome (binary: 10)
    uint256 private constant DOWN_INDEX_SET = 2;

    // ============ Immutable State ============

    /// @notice Gnosis Conditional Tokens contract
    IConditionalTokens public immutable ctf;

    /// @notice Oracle adapter for price resolution
    IOracleAdapter public immutable oracleAdapter;

    /// @notice Collateral token (ytest.usd)
    IERC20 public immutable collateralToken;

    /// @notice Unique market identifier
    uint256 public immutable marketId;

    /// @notice Human-readable unique slug
    string public slug;

    /// @notice When trading can begin
    uint256 public immutable startTimestamp;

    /// @notice When trading ends and resolution occurs
    uint256 public immutable expiryTimestamp;

    /// @notice The market registry that created this market
    address public immutable registry;

    // ============ Mutable State ============

    /// @notice Unique question ID for CTF condition
    bytes32 public questionId;

    /// @notice CTF condition ID
    bytes32 public conditionId;

    /// @notice Whether the condition has been prepared
    bool public initialized;

    /// @notice Whether the market has started
    bool public started;

    /// @notice Whether the market has been resolved
    bool public resolved;

    /// @notice BTC price at market start
    int256 public priceAtStart;

    // ============ Events ============

    /// @notice Emitted when market is initialized
    event MarketInitialized(bytes32 indexed conditionId, bytes32 indexed questionId);

    /// @notice Emitted when positions are minted
    event PositionsMinted(address indexed account, uint256 amount);

    /// @notice Emitted when market trading starts
    event MarketStarted(uint256 indexed marketId, int256 priceAtStart);

    /// @notice Emitted when market is resolved
    event MarketResolved(uint256 indexed marketId, bool isUp);

    // ============ Errors ============

    error AlreadyInitialized();
    error NotInitialized();
    error TooEarly();
    error AlreadyStarted();
    error NotStarted();
    error NotExpired();
    error AlreadyResolved();
    error InsufficientAllowance();
    error OnlyRegistry();

    // ============ Modifiers ============

    modifier onlyRegistry() {
        if (msg.sender != registry) revert OnlyRegistry();
        _;
    }

    // ============ Constructor ============

    /**
     * @notice Creates a new binary market.
     * @param _marketId Unique market ID
     * @param _slug Human-readable identifier
     * @param _startTimestamp When trading begins
     * @param _expiryTimestamp When trading ends
     * @param _ctf Gnosis Conditional Tokens contract
     * @param _oracleAdapter Oracle adapter for resolution
     * @param _collateralToken Collateral token (ytest.usd)
     */
    constructor(
        uint256 _marketId,
        string memory _slug,
        uint256 _startTimestamp,
        uint256 _expiryTimestamp,
        address _ctf,
        address _oracleAdapter,
        address _collateralToken
    ) {
        registry = msg.sender;
        marketId = _marketId;
        slug = _slug;
        startTimestamp = _startTimestamp;
        expiryTimestamp = _expiryTimestamp;
        ctf = IConditionalTokens(_ctf);
        oracleAdapter = IOracleAdapter(_oracleAdapter);
        collateralToken = IERC20(_collateralToken);
    }

    // ============ Initialization ============

    /**
     * @notice Initializes the market by preparing the CTF condition.
     * @dev Must be called before any other operations.
     */
    function initialize() external {
        if (initialized) revert AlreadyInitialized();

        // Generate unique question ID from market parameters
        questionId = keccak256(
            abi.encodePacked(address(this), marketId, slug, startTimestamp, expiryTimestamp)
        );

        // Get the oracle address from the adapter
        address oracle = oracleAdapter.oracle();

        // Prepare the condition in CTF
        ctf.prepareCondition(oracle, questionId, OUTCOME_COUNT);

        // Compute and store the condition ID
        conditionId = ctf.getConditionId(oracle, questionId, OUTCOME_COUNT);

        initialized = true;

        emit MarketInitialized(conditionId, questionId);
    }

    // ============ Minting ============

    /**
     * @notice Mints UP and DOWN tokens by depositing collateral.
     * @dev Caller must approve this contract for collateral transfer.
     * @param amount Amount of collateral to deposit
     */
    function mint(uint256 amount) external {
        if (!initialized) revert NotInitialized();

        // Transfer collateral from caller to this contract
        bool success = collateralToken.transferFrom(msg.sender, address(this), amount);
        if (!success) revert InsufficientAllowance();

        // Approve CTF to spend collateral
        collateralToken.approve(address(ctf), amount);

        // Build partition for binary outcomes [UP, DOWN]
        uint256[] memory partition = new uint256[](2);
        partition[0] = UP_INDEX_SET;   // 0b01 = UP
        partition[1] = DOWN_INDEX_SET; // 0b10 = DOWN

        // Split collateral into UP and DOWN tokens
        ctf.splitPosition(
            collateralToken,
            bytes32(0), // No parent collection
            conditionId,
            partition,
            amount
        );

        // Transfer the minted tokens to the caller
        // Note: CTF mints tokens to msg.sender of splitPosition (this contract)
        // We need to transfer them to the actual user
        _transferPositionsToCaller(amount);

        emit PositionsMinted(msg.sender, amount);
    }

    /**
     * @dev Transfers minted position tokens from this contract to the caller.
     */
    function _transferPositionsToCaller(uint256 amount) internal {
        // Get position IDs
        bytes32 upCollectionId = ctf.getCollectionId(bytes32(0), conditionId, UP_INDEX_SET);
        bytes32 downCollectionId = ctf.getCollectionId(bytes32(0), conditionId, DOWN_INDEX_SET);

        uint256 upPosId = ctf.getPositionId(collateralToken, upCollectionId);
        uint256 downPosId = ctf.getPositionId(collateralToken, downCollectionId);

        // CTF is ERC-1155, so we use safeTransferFrom
        // Note: This requires the caller to implement ERC1155Receiver if it's a contract
        IERC1155(address(ctf)).safeTransferFrom(
            address(this),
            msg.sender,
            upPosId,
            amount,
            ""
        );
        IERC1155(address(ctf)).safeTransferFrom(
            address(this),
            msg.sender,
            downPosId,
            amount,
            ""
        );
    }

    // ============ Market Lifecycle ============

    /**
     * @notice Starts the market and records the initial BTC price.
     * @dev Can be called by anyone after startTimestamp.
     */
    function start() external {
        if (block.timestamp < startTimestamp) revert TooEarly();
        if (!initialized) revert NotInitialized();
        if (started) revert AlreadyStarted();

        // Snapshot the current price
        priceAtStart = oracleAdapter.getPrice();
        started = true;

        emit MarketStarted(marketId, priceAtStart);
    }

    /**
     * @notice Resolves the market via the oracle adapter.
     * @dev Can be called by anyone after expiryTimestamp.
     */
    function resolve() external {
        if (block.timestamp < expiryTimestamp) revert NotExpired();
        if (!started) revert NotStarted();
        if (resolved) revert AlreadyResolved();

        // Oracle adapter will call reportPayouts on CTF
        oracleAdapter.resolve(questionId, priceAtStart);

        resolved = true;

        // Determine outcome for event
        int256 priceAtEnd = oracleAdapter.getPrice();
        bool isUp = priceAtEnd > priceAtStart;

        emit MarketResolved(marketId, isUp);
    }

    // ============ Redemption ============

    /**
     * @notice Redeems winning positions for collateral.
     * @dev Caller must hold winning position tokens.
     */
    function redeem() external {
        if (!resolved) revert AlreadyResolved();

        // Build index sets for redemption (both UP and DOWN)
        uint256[] memory indexSets = new uint256[](2);
        indexSets[0] = UP_INDEX_SET;
        indexSets[1] = DOWN_INDEX_SET;

        // CTF will burn tokens and transfer collateral to caller
        ctf.redeemPositions(
            collateralToken,
            bytes32(0),
            conditionId,
            indexSets
        );
    }

    // ============ View Functions ============

    /**
     * @notice Returns the current market state.
     */
    function state() external view returns (MarketState) {
        if (resolved) return MarketState.RESOLVED;
        if (started) return MarketState.ACTIVE;
        if (initialized) return MarketState.PENDING;
        return MarketState.UNINITIALIZED;
    }

    /**
     * @notice Returns the UP position ID.
     */
    function upPositionId() external view returns (uint256) {
        bytes32 collectionId = ctf.getCollectionId(bytes32(0), conditionId, UP_INDEX_SET);
        return ctf.getPositionId(collateralToken, collectionId);
    }

    /**
     * @notice Returns the DOWN position ID.
     */
    function downPositionId() external view returns (uint256) {
        bytes32 collectionId = ctf.getCollectionId(bytes32(0), conditionId, DOWN_INDEX_SET);
        return ctf.getPositionId(collateralToken, collectionId);
    }

    // ============ Types ============

    enum MarketState {
        UNINITIALIZED,
        PENDING,
        ACTIVE,
        RESOLVED
    }
}

/**
 * @dev Minimal ERC-1155 interface for token transfers.
 */
interface IERC1155 {
    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) external;
}
