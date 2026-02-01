// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMarketRegistry} from "./interfaces/IMarketRegistry.sol";
import {BinaryMarket} from "./BinaryMarket.sol";

/**
 * @title MarketRegistry
 * @notice Factory and registry for PolyBook binary prediction markets.
 * @dev Creates BinaryMarket instances and enforces slug uniqueness.
 */
contract MarketRegistry is IMarketRegistry {
    // ============ State Variables ============

    /// @notice Auto-incrementing market ID counter
    uint256 private _nextMarketId = 1;

    /// @notice Chainlink BTC/USD price feed address
    address public immutable oracleFeed;

    /// @notice Yellow state verifier contract
    address public immutable verifier;

    /// @notice Mapping from market ID to contract address
    mapping(uint256 => address) private _markets;

    /// @notice Mapping from slug to market ID (0 if unused)
    mapping(bytes32 => uint256) private _slugToMarketId;

    // ============ Errors ============

    error InvalidTimestamps();
    error SlugAlreadyExists();
    error MarketNotFound();

    // ============ Constructor ============

    /**
     * @notice Initializes the registry with oracle and verifier addresses.
     * @param _oracleFeed Chainlink BTC/USD feed address
     * @param _verifier Yellow state verifier address
     */
    constructor(address _oracleFeed, address _verifier) {
        oracleFeed = _oracleFeed;
        verifier = _verifier;
    }

    // ============ External Functions ============

    /**
     * @notice Creates a new binary market.
     * @param slug Unique human-readable identifier
     * @param startTimestamp When trading can begin (must be in future)
     * @param expiryTimestamp When trading ends (must be after start)
     * @return marketId The unique ID of the created market
     */
    function createMarket(
        string calldata slug,
        uint256 startTimestamp,
        uint256 expiryTimestamp
    ) external override returns (uint256 marketId) {
        // Validate timestamps
        if (startTimestamp <= block.timestamp) revert InvalidTimestamps();
        if (expiryTimestamp <= startTimestamp) revert InvalidTimestamps();

        // Check slug uniqueness
        bytes32 slugHash = keccak256(abi.encodePacked(slug));
        if (_slugToMarketId[slugHash] != 0) revert SlugAlreadyExists();

        // Assign market ID
        marketId = _nextMarketId++;

        // Deploy new BinaryMarket contract
        BinaryMarket market = new BinaryMarket(
            marketId,
            slug,
            startTimestamp,
            expiryTimestamp,
            oracleFeed,
            verifier
        );

        // Store mappings
        _markets[marketId] = address(market);
        _slugToMarketId[slugHash] = marketId;

        emit MarketCreated(
            marketId,
            address(market),
            slug,
            startTimestamp,
            expiryTimestamp
        );
    }

    // ============ View Functions ============

    /**
     * @notice Returns the market contract address for a given ID.
     * @param marketId The market ID
     * @return The BinaryMarket contract address
     */
    function getMarket(uint256 marketId) external view override returns (address) {
        address market = _markets[marketId];
        if (market == address(0)) revert MarketNotFound();
        return market;
    }

    /**
     * @notice Returns the market ID for a given slug.
     * @param slug The market slug
     * @return The market ID (reverts if not found)
     */
    function getMarketBySlug(string calldata slug) external view override returns (uint256) {
        bytes32 slugHash = keccak256(abi.encodePacked(slug));
        uint256 marketId = _slugToMarketId[slugHash];
        if (marketId == 0) revert MarketNotFound();
        return marketId;
    }

    /**
     * @notice Returns the total number of markets created.
     * @return The market count
     */
    function marketCount() external view override returns (uint256) {
        return _nextMarketId - 1;
    }
}
