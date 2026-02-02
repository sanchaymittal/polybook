// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {BinaryMarket} from "../src/BinaryMarket.sol";
import {ChainlinkAdapter} from "../src/oracles/ChainlinkAdapter.sol";
import {MockConditionalTokens} from "../src/mocks/MockConditionalTokens.sol";
import {MockChainlinkOracle} from "../src/mocks/MockChainlinkOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockCollateral
 * @notice Simple ERC20 mock for collateral token (ytest.usd).
 */
contract MockCollateral is ERC20 {
    constructor() ERC20("Test USD", "ytest.usd") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title MarketRegistryTest
 * @notice Tests for MarketRegistry contract with CTF integration.
 */
contract MarketRegistryTest is Test {
    // ============ State Variables ============

    MarketRegistry public registry;
    MockConditionalTokens public ctf;
    ChainlinkAdapter public oracleAdapter;
    MockChainlinkOracle public priceFeed;
    MockCollateral public collateral;

    // Test parameters
    int256 constant INITIAL_BTC_PRICE = 50000 * 1e8; // $50,000 with 8 decimals
    uint256 constant START_DELAY = 1 hours;
    uint256 constant DURATION = 5 minutes;

    // ============ Setup ============

    function setUp() public {
        // Deploy mocks
        ctf = new MockConditionalTokens();
        priceFeed = new MockChainlinkOracle(INITIAL_BTC_PRICE);
        collateral = new MockCollateral();

        // Deploy oracle adapter
        oracleAdapter = new ChainlinkAdapter(address(ctf), address(priceFeed));

        // Deploy registry
        registry = new MarketRegistry(
            address(ctf),
            address(oracleAdapter),
            address(collateral)
        );
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
 * @notice Tests for BinaryMarket contract with CTF integration.
 */
contract BinaryMarketTest is Test {
    // ============ State Variables ============

    MarketRegistry public registry;
    MockConditionalTokens public ctf;
    ChainlinkAdapter public oracleAdapter;
    MockChainlinkOracle public priceFeed;
    MockCollateral public collateral;
    BinaryMarket public market;

    // Test parameters
    int256 constant INITIAL_BTC_PRICE = 50000 * 1e8;
    uint256 constant START_DELAY = 1 hours;
    uint256 constant DURATION = 5 minutes;
    uint256 constant MINT_AMOUNT = 1000 * 1e6; // 1000 USD (6 decimals)

    address user1 = makeAddr("user1");
    address user2 = makeAddr("user2");

    // ============ Setup ============

    function setUp() public {
        // Deploy mocks
        ctf = new MockConditionalTokens();
        priceFeed = new MockChainlinkOracle(INITIAL_BTC_PRICE);
        collateral = new MockCollateral();

        // Deploy oracle adapter
        oracleAdapter = new ChainlinkAdapter(address(ctf), address(priceFeed));

        // Deploy registry
        registry = new MarketRegistry(
            address(ctf),
            address(oracleAdapter),
            address(collateral)
        );

        // Create market
        uint256 startTime = block.timestamp + START_DELAY;
        uint256 expiryTime = startTime + DURATION;
        uint256 marketId = registry.createMarket("test-market", startTime, expiryTime);
        market = BinaryMarket(registry.getMarket(marketId));

        // Fund users
        collateral.mint(user1, MINT_AMOUNT * 10);
        collateral.mint(user2, MINT_AMOUNT * 10);
    }

    // ============ Initialization Tests ============

    function test_Initialize_Success() public {
        market.initialize();

        assertTrue(market.initialized());
        assertTrue(market.conditionId() != bytes32(0));
        assertTrue(market.questionId() != bytes32(0));
    }

    function test_Initialize_RevertIf_AlreadyInitialized() public {
        market.initialize();

        vm.expectRevert(BinaryMarket.AlreadyInitialized.selector);
        market.initialize();
    }

    // ============ Minting Tests ============

    function test_Mint_Success() public {
        // Initialize market
        market.initialize();

        // Approve and mint
        vm.startPrank(user1);
        collateral.approve(address(market), MINT_AMOUNT);
        market.mint(MINT_AMOUNT);
        vm.stopPrank();

        // Check user1 has UP and DOWN positions
        uint256 upId = market.upPositionId();
        uint256 downId = market.downPositionId();

        assertEq(ctf.balanceOf(user1, upId), MINT_AMOUNT);
        assertEq(ctf.balanceOf(user1, downId), MINT_AMOUNT);
    }

    function test_Mint_RevertIf_NotInitialized() public {
        vm.startPrank(user1);
        collateral.approve(address(market), MINT_AMOUNT);

        vm.expectRevert(BinaryMarket.NotInitialized.selector);
        market.mint(MINT_AMOUNT);
        vm.stopPrank();
    }

    // ============ Start Tests ============

    function test_Start_Success() public {
        market.initialize();

        // Warp to start time
        vm.warp(market.startTimestamp());
        market.start();

        assertTrue(market.started());
        assertEq(market.priceAtStart(), INITIAL_BTC_PRICE);
    }

    function test_Start_RevertIf_TooEarly() public {
        market.initialize();

        vm.expectRevert(BinaryMarket.TooEarly.selector);
        market.start();
    }

    function test_Start_RevertIf_NotInitialized() public {
        vm.warp(market.startTimestamp());

        vm.expectRevert(BinaryMarket.NotInitialized.selector);
        market.start();
    }

    function test_Start_RevertIf_AlreadyStarted() public {
        market.initialize();
        vm.warp(market.startTimestamp());
        market.start();

        vm.expectRevert(BinaryMarket.AlreadyStarted.selector);
        market.start();
    }

    // ============ Resolution Tests ============

    function test_Resolve_OutcomeUP() public {
        // Setup
        market.initialize();
        vm.warp(market.startTimestamp());
        market.start();

        // Price goes up
        priceFeed.setPrice(INITIAL_BTC_PRICE + 1000 * 1e8);

        // Warp to expiry and resolve
        vm.warp(market.expiryTimestamp());
        market.resolve();

        assertTrue(market.resolved());

        // Check CTF payouts - UP wins: [1, 0]
        uint256[] memory payouts = ctf.payoutNumerators(market.conditionId());
        assertEq(payouts[0], 1); // UP
        assertEq(payouts[1], 0); // DOWN
    }

    function test_Resolve_OutcomeDOWN() public {
        market.initialize();
        vm.warp(market.startTimestamp());
        market.start();

        // Price goes down
        priceFeed.setPrice(INITIAL_BTC_PRICE - 1000 * 1e8);

        vm.warp(market.expiryTimestamp());
        market.resolve();

        assertTrue(market.resolved());

        // Check CTF payouts - DOWN wins: [0, 1]
        uint256[] memory payouts = ctf.payoutNumerators(market.conditionId());
        assertEq(payouts[0], 0); // UP
        assertEq(payouts[1], 1); // DOWN
    }

    function test_Resolve_RevertIf_NotExpired() public {
        market.initialize();
        vm.warp(market.startTimestamp());
        market.start();

        vm.expectRevert(BinaryMarket.NotExpired.selector);
        market.resolve();
    }

    function test_Resolve_RevertIf_NotStarted() public {
        market.initialize();
        vm.warp(market.expiryTimestamp());

        vm.expectRevert(BinaryMarket.NotStarted.selector);
        market.resolve();
    }

    // ============ State Tests ============

    function test_State_Transitions() public {
        // UNINITIALIZED
        assertEq(uint8(market.state()), uint8(BinaryMarket.MarketState.UNINITIALIZED));

        // PENDING after initialize
        market.initialize();
        assertEq(uint8(market.state()), uint8(BinaryMarket.MarketState.PENDING));

        // ACTIVE after start
        vm.warp(market.startTimestamp());
        market.start();
        assertEq(uint8(market.state()), uint8(BinaryMarket.MarketState.ACTIVE));

        // RESOLVED after resolve
        vm.warp(market.expiryTimestamp());
        market.resolve();
        assertEq(uint8(market.state()), uint8(BinaryMarket.MarketState.RESOLVED));
    }
}

/**
 * @title ChainlinkAdapterTest
 * @notice Tests for ChainlinkAdapter oracle.
 */
contract ChainlinkAdapterTest is Test {
    MockConditionalTokens public ctf;
    ChainlinkAdapter public adapter;
    MockChainlinkOracle public priceFeed;

    int256 constant INITIAL_PRICE = 50000 * 1e8;

    function setUp() public {
        ctf = new MockConditionalTokens();
        priceFeed = new MockChainlinkOracle(INITIAL_PRICE);
        adapter = new ChainlinkAdapter(address(ctf), address(priceFeed));
    }

    function test_Oracle_ReturnsAdapterAddress() public view {
        assertEq(adapter.oracle(), address(adapter));
    }

    function test_GetPrice_Success() public view {
        assertEq(adapter.getPrice(), INITIAL_PRICE);
    }

    function test_Resolve_UP() public {
        // Prepare condition first
        bytes32 questionId = keccak256("test-question");
        ctf.prepareCondition(address(adapter), questionId, 2);

        // Change price up
        priceFeed.setPrice(INITIAL_PRICE + 1000 * 1e8);

        // Resolve
        adapter.resolve(questionId, INITIAL_PRICE);

        // Check payouts
        bytes32 conditionId = ctf.getConditionId(address(adapter), questionId, 2);
        uint256[] memory payouts = ctf.payoutNumerators(conditionId);
        assertEq(payouts[0], 1); // UP wins
        assertEq(payouts[1], 0);
    }

    function test_Resolve_DOWN() public {
        bytes32 questionId = keccak256("test-question-down");
        ctf.prepareCondition(address(adapter), questionId, 2);

        // Change price down
        priceFeed.setPrice(INITIAL_PRICE - 1000 * 1e8);

        adapter.resolve(questionId, INITIAL_PRICE);

        bytes32 conditionId = ctf.getConditionId(address(adapter), questionId, 2);
        uint256[] memory payouts = ctf.payoutNumerators(conditionId);
        assertEq(payouts[0], 0);
        assertEq(payouts[1], 1); // DOWN wins
    }
}
