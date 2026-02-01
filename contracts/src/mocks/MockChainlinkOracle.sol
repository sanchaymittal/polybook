// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IChainlinkAggregator} from "../interfaces/IChainlinkAggregator.sol";

/**
 * @title MockChainlinkOracle
 * @notice Mock Chainlink price feed for testing.
 * @dev Allows setting arbitrary prices for test scenarios.
 */
contract MockChainlinkOracle is IChainlinkAggregator {
    // ============ State Variables ============

    int256 private _price;
    uint8 private constant DECIMALS = 8;
    string private constant DESCRIPTION = "BTC / USD (Mock)";
    uint80 private _roundId;

    // ============ Constructor ============

    /**
     * @notice Initializes with a default price.
     * @param initialPrice The initial BTC/USD price (8 decimals)
     */
    constructor(int256 initialPrice) {
        _price = initialPrice;
        _roundId = 1;
    }

    // ============ External Functions ============

    /**
     * @notice Sets the price for testing.
     * @param newPrice The new price to return
     */
    function setPrice(int256 newPrice) external {
        _price = newPrice;
        _roundId++;
    }

    // ============ IChainlinkAggregator Implementation ============

    function latestRoundData()
        external
        view
        override
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (
            _roundId,
            _price,
            block.timestamp - 1,
            block.timestamp,
            _roundId
        );
    }

    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    function description() external pure override returns (string memory) {
        return DESCRIPTION;
    }
}
