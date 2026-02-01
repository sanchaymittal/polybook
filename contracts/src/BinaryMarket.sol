// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMarketRegistry} from "./interfaces/IMarketRegistry.sol";
import {IYellowVerifier} from "./interfaces/IYellowVerifier.sol";

/**
 * @title IBinaryMarket
 * @notice Interface for individual binary prediction markets.
 */
interface IBinaryMarket {
    /// @notice Emitted when market trading starts
    event MarketStarted(uint256 indexed marketId, int256 priceAtStart);

    /// @notice Emitted when market is resolved
    event MarketResolved(uint256 indexed marketId, IMarketRegistry.Outcome outcome);

    /// @notice Emitted when an agent claims their payout
    event PayoutClaimed(uint256 indexed marketId, address indexed agent, uint256 amount);

    function marketId() external view returns (uint256);
    function slug() external view returns (string memory);
    function startTimestamp() external view returns (uint256);
    function expiryTimestamp() external view returns (uint256);
    function started() external view returns (bool);
    function resolved() external view returns (bool);
    function priceAtStart() external view returns (int256);
    function outcome() external view returns (IMarketRegistry.Outcome);

    function startMarket() external;
    function resolveMarket(bytes32 stateRoot, bytes calldata proof) external;
    function claim() external;
}

/**
 * @title BinaryMarket
 * @notice A binary prediction market for BTC price (UP/DOWN).
 * @dev Template: BTC_UP_DOWN
 *
 * Lifecycle:
 * 1. PENDING: Market created, waiting for startTimestamp
 * 2. ACTIVE: Trading open between startTimestamp and expiryTimestamp
 * 3. RESOLVED: Outcome determined, payouts available
 */
contract BinaryMarket is IBinaryMarket {
    // ============ Immutable State ============

    /// @notice The market registry that created this market
    address public immutable registry;

    /// @notice Unique market identifier
    uint256 public immutable override marketId;

    /// @notice Human-readable unique slug
    string public override slug;

    /// @notice When trading can begin
    uint256 public immutable override startTimestamp;

    /// @notice When trading ends
    uint256 public immutable override expiryTimestamp;

    /// @notice Chainlink BTC/USD price feed
    address public immutable oracleFeed;

    /// @notice Yellow state verifier contract
    IYellowVerifier public immutable verifier;

    // ============ Mutable State ============

    /// @notice Whether the market has started
    bool public override started;

    /// @notice Whether the market has been resolved
    bool public override resolved;

    /// @notice BTC/USD price at market start
    int256 public override priceAtStart;

    /// @notice The resolved outcome
    IMarketRegistry.Outcome public override outcome;

    /// @notice Final state root from Yellow L2
    bytes32 public finalStateRoot;

    /// @notice Tracks which agents have claimed
    mapping(address => bool) public claimed;

    // ============ Errors ============

    error TooEarly();
    error AlreadyStarted();
    error NotStarted();
    error NotExpired();
    error AlreadyResolved();
    error NotResolved();
    error InvalidProof();
    error AlreadyClaimed();
    error NoPayout();
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
     * @param _oracleFeed Chainlink BTC/USD feed address
     * @param _verifier Yellow state verifier address
     */
    constructor(
        uint256 _marketId,
        string memory _slug,
        uint256 _startTimestamp,
        uint256 _expiryTimestamp,
        address _oracleFeed,
        address _verifier
    ) {
        registry = msg.sender;
        marketId = _marketId;
        slug = _slug;
        startTimestamp = _startTimestamp;
        expiryTimestamp = _expiryTimestamp;
        oracleFeed = _oracleFeed;
        verifier = IYellowVerifier(_verifier);
    }

    // ============ External Functions ============

    /**
     * @notice Starts the market and records the initial BTC price.
     * @dev Can only be called after startTimestamp.
     */
    function startMarket() external override {
        if (block.timestamp < startTimestamp) revert TooEarly();
        if (started) revert AlreadyStarted();

        // Fetch current BTC/USD price from Chainlink
        (, int256 price, , , ) = IChainlinkAggregatorMinimal(oracleFeed).latestRoundData();
        priceAtStart = price;
        started = true;

        emit MarketStarted(marketId, price);
    }

    /**
     * @notice Resolves the market with the final state from Yellow L2.
     * @param stateRoot The Merkle root of final positions
     * @param proof Proof signed by Yellow validators
     */
    function resolveMarket(bytes32 stateRoot, bytes calldata proof) external override {
        if (block.timestamp < expiryTimestamp) revert NotExpired();
        if (!started) revert NotStarted();
        if (resolved) revert AlreadyResolved();

        // Verify the Yellow state proof
        if (!verifier.verify(stateRoot, proof)) revert InvalidProof();

        // Fetch final BTC/USD price
        (, int256 priceAtEnd, , , ) = IChainlinkAggregatorMinimal(oracleFeed).latestRoundData();

        // Determine outcome: UP if price increased, DOWN otherwise
        outcome = priceAtEnd > priceAtStart
            ? IMarketRegistry.Outcome.UP
            : IMarketRegistry.Outcome.DOWN;

        finalStateRoot = stateRoot;
        resolved = true;

        emit MarketResolved(marketId, outcome);
    }

    /**
     * @notice Claims payout for the calling agent.
     * @dev Payout is based on positions held for the winning outcome.
     */
    function claim() external override {
        if (!resolved) revert NotResolved();
        if (claimed[msg.sender]) revert AlreadyClaimed();

        // Get agent's positions from the final state
        (uint256 upPosition, uint256 downPosition) = verifier.getAgentPosition(
            finalStateRoot,
            msg.sender,
            marketId
        );

        // Calculate payout based on winning outcome
        uint256 payout;
        if (outcome == IMarketRegistry.Outcome.UP) {
            payout = upPosition; // 1:1 payout for winning position
        } else {
            payout = downPosition;
        }

        if (payout == 0) revert NoPayout();

        claimed[msg.sender] = true;

        // Transfer payout (handled by escrow in full implementation)
        // For MVP, emit event for off-chain settlement
        emit PayoutClaimed(marketId, msg.sender, payout);
    }

    // ============ View Functions ============

    /**
     * @notice Returns the current market state.
     */
    function state() external view returns (IMarketRegistry.MarketState) {
        if (resolved) return IMarketRegistry.MarketState.RESOLVED;
        if (started) return IMarketRegistry.MarketState.ACTIVE;
        return IMarketRegistry.MarketState.PENDING;
    }
}

/**
 * @dev Minimal Chainlink interface to avoid import issues.
 */
interface IChainlinkAggregatorMinimal {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
