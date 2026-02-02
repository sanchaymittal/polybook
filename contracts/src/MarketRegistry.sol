// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BinaryMarket} from "./BinaryMarket.sol";

/**
 * @title MarketRegistry
 * @notice Factory and registry for PolyBook binary prediction markets.
 * @dev Creates BinaryMarket instances and enforces slug uniqueness.
 */
contract MarketRegistry {
    // ============ State Variables ============

    /// @notice Auto-incrementing market ID counter
    uint256 private _nextMarketId = 1;

    /// @notice Gnosis Conditional Tokens contract
    address public immutable ctf;

    /// @notice Oracle adapter for all markets
    address public immutable oracleAdapter;

    /// @notice Collateral token (ytest.usd)
    address public immutable collateralToken;

    /// @notice Mapping from market ID to contract address
    mapping(uint256 => address) private _markets;

    /// @notice Mapping from slug to market ID (0 if unused)
    mapping(bytes32 => uint256) private _slugToMarketId;

    // ============ Events ============

    /// @notice Emitted when a new market is created
    event MarketCreated(
        uint256 indexed marketId,
        address indexed marketContract,
        string slug,
        uint256 startTimestamp,
        uint256 expiryTimestamp
    );

    // ============ Errors ============

    error InvalidTimestamps();
    error SlugAlreadyExists();
    error MarketNotFound();

    // ============ Constructor ============

    /**
     * @notice Initializes the registry with CTF and oracle addresses.
     * @param _ctf Gnosis Conditional Tokens contract
     * @param _oracleAdapter Oracle adapter for resolution
     * @param _collateralToken Collateral token (ytest.usd)
     */
    constructor(address _ctf, address _oracleAdapter, address _collateralToken) {
        ctf = _ctf;
        oracleAdapter = _oracleAdapter;
        collateralToken = _collateralToken;
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
    ) external returns (uint256 marketId) {
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
            ctf,
            oracleAdapter,
            collateralToken
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
    function getMarket(uint256 marketId) external view returns (address) {
        address market = _markets[marketId];
        if (market == address(0)) revert MarketNotFound();
        return market;
    }

    /**
     * @notice Returns the market ID for a given slug.
     * @param slug The market slug
     * @return The market ID (reverts if not found)
     */
    function getMarketBySlug(string calldata slug) external view returns (uint256) {
        bytes32 slugHash = keccak256(abi.encodePacked(slug));
        uint256 marketId = _slugToMarketId[slugHash];
        if (marketId == 0) revert MarketNotFound();
        return marketId;
    }

    /**
     * @notice Returns the total number of markets created.
     * @return The market count
     */
    function marketCount() external view returns (uint256) {
        return _nextMarketId - 1;
    }
}
