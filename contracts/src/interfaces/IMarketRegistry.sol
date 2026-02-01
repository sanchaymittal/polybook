// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IMarketRegistry
 * @notice Interface for the PolyBook market registry.
 */
interface IMarketRegistry {
    /// @notice Market state enumeration
    enum MarketState {
        PENDING,   // Created but not yet started
        ACTIVE,    // Trading is open
        RESOLVED   // Outcome determined, claims open
    }

    /// @notice Binary outcome for BTC price prediction
    enum Outcome {
        NONE,      // Not yet resolved
        UP,        // Price went up
        DOWN       // Price went down or stayed same
    }

    /// @notice Emitted when a new market is created
    event MarketCreated(
        uint256 indexed marketId,
        address indexed marketContract,
        string slug,
        uint256 startTimestamp,
        uint256 expiryTimestamp
    );

    /**
     * @notice Creates a new binary market.
     * @param slug Unique human-readable identifier
     * @param startTimestamp When trading can begin
     * @param expiryTimestamp When trading ends and resolution occurs
     * @return marketId The unique ID of the created market
     */
    function createMarket(
        string calldata slug,
        uint256 startTimestamp,
        uint256 expiryTimestamp
    ) external returns (uint256 marketId);

    /**
     * @notice Returns the market contract address for a given ID.
     * @param marketId The market ID
     * @return The BinaryMarket contract address
     */
    function getMarket(uint256 marketId) external view returns (address);

    /**
     * @notice Returns the market ID for a given slug.
     * @param slug The market slug
     * @return The market ID (0 if not found)
     */
    function getMarketBySlug(string calldata slug) external view returns (uint256);

    /**
     * @notice Returns the total number of markets created.
     * @return The market count
     */
    function marketCount() external view returns (uint256);
}
