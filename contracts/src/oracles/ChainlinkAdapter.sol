// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracleAdapter} from "../interfaces/IOracleAdapter.sol";
import {IConditionalTokens} from "../interfaces/IConditionalTokens.sol";

/**
 * @title ChainlinkAdapter
 * @notice Oracle adapter using Chainlink price feeds for CTF resolution.
 * @dev Resolves BTC UP/DOWN markets by comparing start and end prices.
 */
contract ChainlinkAdapter is IOracleAdapter {
    // ============ Constants ============

    /// @notice Number of outcomes for binary markets
    uint256 private constant OUTCOME_COUNT = 2;

    /// @notice Index for UP outcome
    uint256 private constant UP_INDEX = 0;

    /// @notice Index for DOWN outcome
    uint256 private constant DOWN_INDEX = 1;

    // ============ Immutable State ============

    /// @notice Gnosis Conditional Tokens contract
    IConditionalTokens public immutable ctf;

    /// @notice Chainlink price feed address
    address public immutable priceFeed;

    // ============ Errors ============

    error PriceFeedFailed();

    // ============ Constructor ============

    /**
     * @notice Creates a new ChainlinkAdapter.
     * @param _ctf Gnosis Conditional Tokens contract address
     * @param _priceFeed Chainlink BTC/USD price feed address
     */
    constructor(address _ctf, address _priceFeed) {
        ctf = IConditionalTokens(_ctf);
        priceFeed = _priceFeed;
    }

    // ============ IOracleAdapter Implementation ============

    /**
     * @notice Returns this contract as the oracle for CTF conditions.
     * @dev The adapter itself calls reportPayouts, so it must be the oracle.
     */
    function oracle() external view override returns (address) {
        return address(this);
    }

    /**
     * @notice Gets the current BTC/USD price from Chainlink.
     * @return The current price (8 decimals)
     */
    function getPrice() public view override returns (int256) {
        (, int256 price, , , ) = IChainlinkFeed(priceFeed).latestRoundData();
        if (price <= 0) revert PriceFeedFailed();
        return price;
    }

    /**
     * @notice Resolves a market by reporting payouts to CTF.
     * @dev Compares current price to start price and reports [1,0] or [0,1].
     * @param questionId The condition's question ID
     * @param priceAtStart The price recorded at market start
     */
    function resolve(bytes32 questionId, int256 priceAtStart) external override {
        int256 priceAtEnd = getPrice();

        // Determine outcome: UP if price increased, DOWN otherwise
        bool isUp = priceAtEnd > priceAtStart;

        // Build payout vector
        uint256[] memory payouts = new uint256[](OUTCOME_COUNT);
        if (isUp) {
            payouts[UP_INDEX] = 1;
            payouts[DOWN_INDEX] = 0;
        } else {
            payouts[UP_INDEX] = 0;
            payouts[DOWN_INDEX] = 1;
        }

        // Report payouts to CTF
        ctf.reportPayouts(questionId, payouts);

        emit MarketResolved(questionId, priceAtStart, priceAtEnd, isUp);
    }
}

/**
 * @dev Minimal Chainlink interface.
 */
interface IChainlinkFeed {
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
