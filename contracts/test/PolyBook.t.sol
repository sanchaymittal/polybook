// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {BinaryMarket} from "../src/BinaryMarket.sol";
import {IMarketRegistry} from "../src/interfaces/IMarketRegistry.sol";
import {MockChainlinkOracle} from "../src/mocks/MockChainlinkOracle.sol";
import {MockYellowVerifier} from "../src/mocks/MockYellowVerifier.sol";

/**
 * @title MarketRegistryTest
 * @notice Tests for MarketRegistry contract.
 */
contract MarketRegistryTest is Test {
    // ============ State Variables ============

    MarketRegistry public registry;
    MockChainlinkOracle public oracle;
    MockYellowVerifier public verifier;

    // Test parameters
    uint256 constant INITIAL_BTC_PRICE = 50000 * 1e8; // $50,000 with 8 decimals
    uint256 constant START_DELAY = 1 hours;
    uint256 constant DURATION = 5 minutes;

    // ============ Setup ============

    function setUp() public {
        // Deploy mocks
        oracle = new MockChainlinkOracle(int256(INITIAL_BTC_PRICE));
        verifier = new MockYellowVerifier();

        // Deploy registry
        registry = new MarketRegistry(address(oracle), address(verifier));
    }

    // ============ Creation Tests ============

    function test_CreateMarket_Success() public {
        uint256 startTime = block.timestamp + START_DELAY;
        uint256 expiryTime = startTime + DURATION;

        uint256 marketId = registry.createMarket(
            "btc-up-down-5min",
            startTime,
            expiryTime
        );

        assertEq(marketId, 1);
        assertEq(registry.marketCount(), 1);

        address marketAddr = registry.getMarket(marketId);
        assertTrue(marketAddr != address(0));

        BinaryMarket market = BinaryMarket(marketAddr);
        assertEq(market.slug(), "btc-up-down-5min");
        assertEq(market.startTimestamp(), startTime);
        assertEq(market.expiryTimestamp(), expiryTime);
        assertFalse(market.started());
        assertFalse(market.resolved());
    }

    function test_CreateMarket_RevertIf_StartInPast() public {
        uint256 startTime = block.timestamp - 1;
        uint256 expiryTime = block.timestamp + DURATION;

        vm.expectRevert(MarketRegistry.InvalidTimestamps.selector);
        registry.createMarket("test-market", startTime, expiryTime);
    }

    function test_CreateMarket_RevertIf_ExpiryBeforeStart() public {
        uint256 startTime = block.timestamp + START_DELAY;
        uint256 expiryTime = startTime - 1;

        vm.expectRevert(MarketRegistry.InvalidTimestamps.selector);
        registry.createMarket("test-market", startTime, expiryTime);
    }

    function test_CreateMarket_RevertIf_DuplicateSlug() public {
        uint256 startTime = block.timestamp + START_DELAY;
        uint256 expiryTime = startTime + DURATION;

        registry.createMarket("unique-slug", startTime, expiryTime);

        vm.expectRevert(MarketRegistry.SlugAlreadyExists.selector);
        registry.createMarket("unique-slug", startTime + 1, expiryTime + 1);
    }

    function test_GetMarketBySlug() public {
        uint256 startTime = block.timestamp + START_DELAY;
        uint256 expiryTime = startTime + DURATION;

        uint256 marketId = registry.createMarket("slug-test", startTime, expiryTime);
        uint256 foundId = registry.getMarketBySlug("slug-test");

        assertEq(foundId, marketId);
    }

    function test_GetMarketBySlug_RevertIf_NotFound() public {
        vm.expectRevert(MarketRegistry.MarketNotFound.selector);
        registry.getMarketBySlug("nonexistent");
    }

    function test_MultipleMarkets() public {
        uint256 startTime = block.timestamp + START_DELAY;
        uint256 expiryTime = startTime + DURATION;

        uint256 id1 = registry.createMarket("market-1", startTime, expiryTime);
        uint256 id2 = registry.createMarket("market-2", startTime + 1, expiryTime + 1);
        uint256 id3 = registry.createMarket("market-3", startTime + 2, expiryTime + 2);

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
        assertEq(registry.marketCount(), 3);
    }
}

/**
 * @title BinaryMarketTest
 * @notice Tests for BinaryMarket contract lifecycle.
 */
contract BinaryMarketTest is Test {
    // ============ State Variables ============

    MarketRegistry public registry;
    MockChainlinkOracle public oracle;
    MockYellowVerifier public verifier;
    BinaryMarket public market;

    // Test parameters
    int256 constant INITIAL_BTC_PRICE = 50000 * 1e8;
    uint256 constant START_DELAY = 1 hours;
    uint256 constant DURATION = 5 minutes;

    address agent1 = makeAddr("agent1");
    address agent2 = makeAddr("agent2");

    // ============ Setup ============

    function setUp() public {
        oracle = new MockChainlinkOracle(INITIAL_BTC_PRICE);
        verifier = new MockYellowVerifier();
        registry = new MarketRegistry(address(oracle), address(verifier));

        uint256 startTime = block.timestamp + START_DELAY;
        uint256 expiryTime = startTime + DURATION;

        uint256 marketId = registry.createMarket("test-market", startTime, expiryTime);
        market = BinaryMarket(registry.getMarket(marketId));
    }

    // ============ Start Tests ============

    function test_StartMarket_Success() public {
        // Warp to start time
        vm.warp(market.startTimestamp());

        market.startMarket();

        assertTrue(market.started());
        assertEq(market.priceAtStart(), INITIAL_BTC_PRICE);
    }

    function test_StartMarket_RevertIf_TooEarly() public {
        vm.expectRevert(BinaryMarket.TooEarly.selector);
        market.startMarket();
    }

    function test_StartMarket_RevertIf_AlreadyStarted() public {
        vm.warp(market.startTimestamp());
        market.startMarket();

        vm.expectRevert(BinaryMarket.AlreadyStarted.selector);
        market.startMarket();
    }

    // ============ Resolution Tests ============

    function test_ResolveMarket_OutcomeUP() public {
        // Start the market
        vm.warp(market.startTimestamp());
        market.startMarket();

        // Price goes up
        oracle.setPrice(INITIAL_BTC_PRICE + 1000 * 1e8);

        // Warp to expiry
        vm.warp(market.expiryTimestamp());

        // Resolve
        bytes32 stateRoot = keccak256("test-state");
        bytes memory proof = "";

        market.resolveMarket(stateRoot, proof);

        assertTrue(market.resolved());
        assertEq(uint8(market.outcome()), uint8(IMarketRegistry.Outcome.UP));
    }

    function test_ResolveMarket_OutcomeDOWN() public {
        vm.warp(market.startTimestamp());
        market.startMarket();

        // Price goes down
        oracle.setPrice(INITIAL_BTC_PRICE - 1000 * 1e8);

        vm.warp(market.expiryTimestamp());

        bytes32 stateRoot = keccak256("test-state");
        bytes memory proof = "";

        market.resolveMarket(stateRoot, proof);

        assertTrue(market.resolved());
        assertEq(uint8(market.outcome()), uint8(IMarketRegistry.Outcome.DOWN));
    }

    function test_ResolveMarket_RevertIf_NotExpired() public {
        vm.warp(market.startTimestamp());
        market.startMarket();

        vm.expectRevert(BinaryMarket.NotExpired.selector);
        market.resolveMarket(bytes32(0), "");
    }

    function test_ResolveMarket_RevertIf_NotStarted() public {
        vm.warp(market.expiryTimestamp());

        vm.expectRevert(BinaryMarket.NotStarted.selector);
        market.resolveMarket(bytes32(0), "");
    }

    function test_ResolveMarket_RevertIf_InvalidProof() public {
        vm.warp(market.startTimestamp());
        market.startMarket();

        vm.warp(market.expiryTimestamp());

        // Make verifier reject proofs
        verifier.setShouldVerify(false);

        vm.expectRevert(BinaryMarket.InvalidProof.selector);
        market.resolveMarket(bytes32(0), "");
    }

    // ============ Claim Tests ============

    function test_Claim_Success() public {
        // Setup: start, set positions, resolve
        vm.warp(market.startTimestamp());
        market.startMarket();

        // Agent1 has UP position, Agent2 has DOWN position
        verifier.setAgentPosition(market.marketId(), agent1, 100, 0);
        verifier.setAgentPosition(market.marketId(), agent2, 0, 50);

        // Price goes up
        oracle.setPrice(INITIAL_BTC_PRICE + 1000 * 1e8);
        vm.warp(market.expiryTimestamp());
        market.resolveMarket(keccak256("state"), "");

        // Agent1 claims (should succeed - had UP position)
        vm.prank(agent1);
        market.claim();

        assertTrue(market.claimed(agent1));
    }

    function test_Claim_RevertIf_NoPayout() public {
        vm.warp(market.startTimestamp());
        market.startMarket();

        // Agent1 has only DOWN position
        verifier.setAgentPosition(market.marketId(), agent1, 0, 100);

        // Price goes up (UP wins)
        oracle.setPrice(INITIAL_BTC_PRICE + 1000 * 1e8);
        vm.warp(market.expiryTimestamp());
        market.resolveMarket(keccak256("state"), "");

        // Agent1 tries to claim but has no UP position
        vm.prank(agent1);
        vm.expectRevert(BinaryMarket.NoPayout.selector);
        market.claim();
    }

    function test_Claim_RevertIf_NotResolved() public {
        vm.prank(agent1);
        vm.expectRevert(BinaryMarket.NotResolved.selector);
        market.claim();
    }

    function test_Claim_RevertIf_AlreadyClaimed() public {
        vm.warp(market.startTimestamp());
        market.startMarket();

        verifier.setAgentPosition(market.marketId(), agent1, 100, 0);

        oracle.setPrice(INITIAL_BTC_PRICE + 1000 * 1e8);
        vm.warp(market.expiryTimestamp());
        market.resolveMarket(keccak256("state"), "");

        vm.startPrank(agent1);
        market.claim();

        vm.expectRevert(BinaryMarket.AlreadyClaimed.selector);
        market.claim();
        vm.stopPrank();
    }

    // ============ State Tests ============

    function test_State_Transitions() public {
        // Initial state: PENDING
        assertEq(uint8(market.state()), uint8(IMarketRegistry.MarketState.PENDING));

        // Start market: ACTIVE
        vm.warp(market.startTimestamp());
        market.startMarket();
        assertEq(uint8(market.state()), uint8(IMarketRegistry.MarketState.ACTIVE));

        // Resolve market: RESOLVED
        vm.warp(market.expiryTimestamp());
        market.resolveMarket(keccak256("state"), "");
        assertEq(uint8(market.state()), uint8(IMarketRegistry.MarketState.RESOLVED));
    }
}
