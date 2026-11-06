const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const Order = require("../models/Order");
const { getMostOrderedDishes } = require("../controllers/menuController");
const menuRouter = require("../routes/menuRoutes");

describe("Menu Controller - Most Ordered Dishes (Milestone 1)", () => {
    let originalAggregate;

    beforeEach(() => {
        originalAggregate = Order.aggregate;
    });

    afterEach(() => {
        Order.aggregate = originalAggregate;
    });

    test("Executes aggregation with exact 7-day rolling window and eligibility criteria", async () => {
        let capturedPipeline = null;

        Order.aggregate = async (pipeline) => {
            capturedPipeline = pipeline;
            return [
                {
                    _id: "dish_1",
                    name: "Truffle Pizza",
                    description: "Handcrafted pizza",
                    price: 450,
                    category: { _id: "cat_1", name: "Mains" },
                    image: "/images/pizza.jpg",
                    model3D: "/models/pizza.glb",
                    isVeg: true,
                    isAvailable: true,
                    preparationTime: 20,
                    rating: 4.8,
                    totalQuantityOrdered: 15,
                    orderCount: 5
                }
            ];
        };

        let statusCode = null;
        let responseBody = null;

        const req = {};
        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => {
                        responseBody = data;
                    }
                };
            }
        };

        const beforeCall = Date.now();
        await getMostOrderedDishes(req, res);
        const afterCall = Date.now();

        assert.equal(statusCode, 200);
        assert.equal(responseBody.success, true);
        assert.equal(responseBody.count, 1);
        assert.equal(responseBody.timeWindow, "7d");
        assert.equal(responseBody.dishes.length, 1);
        assert.equal(responseBody.dishes[0].totalQuantityOrdered, 15);

        // Verify pipeline stages
        assert.ok(Array.isArray(capturedPipeline), "Pipeline should be an array");

        // 1. $match stage
        const matchStage = capturedPipeline.find((stage) => stage.$match && stage.$match.createdAt);
        assert.ok(matchStage, "Pipeline must have a match stage with createdAt filter");
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const cutoffDate = matchStage.$match.createdAt.$gte;
        assert.ok(cutoffDate instanceof Date, "Cutoff must be a Date instance");
        assert.ok(
            cutoffDate.getTime() >= beforeCall - sevenDaysMs - 1000 &&
            cutoffDate.getTime() <= afterCall - sevenDaysMs + 1000,
            "Cutoff should be within the rolling 7-day window"
        );
        assert.deepEqual(matchStage.$match.orderStatus, { $ne: "Cancelled" });
        assert.deepEqual(matchStage.$match.paymentStatus, { $in: ["Paid", "PartiallyRefunded"] });
        assert.deepEqual(matchStage.$match.reconciliationRequired, { $ne: true });

        // 2. $unwind items stage
        const unwindItemsStage = capturedPipeline.find((stage) => stage.$unwind === "$items");
        assert.ok(unwindItemsStage, "Pipeline must unwind items");

        // 3. $group stage sums quantity
        const groupStage = capturedPipeline.find((stage) => stage.$group);
        assert.ok(groupStage, "Pipeline must group items");
        assert.equal(groupStage.$group._id, "$items.menu");
        assert.deepEqual(groupStage.$group.totalQuantityOrdered, { $sum: "$items.quantity" });

        // 4. $sort stage by totalQuantityOrdered descending
        const sortStage = capturedPipeline.find((stage) => stage.$sort);
        assert.ok(sortStage, "Pipeline must sort");
        assert.equal(sortStage.$sort.totalQuantityOrdered, -1);

        // 5. Unavailable dish filter
        const availMatch = capturedPipeline.find((stage) => stage.$match && stage.$match["menu.isAvailable"] !== undefined);
        assert.ok(availMatch, "Pipeline must filter out unavailable dishes");
        assert.equal(availMatch.$match["menu.isAvailable"], true);

        // 6. $limit stage 10
        const limitStage = capturedPipeline.find((stage) => stage.$limit !== undefined);
        assert.ok(limitStage, "Pipeline must limit to top 10");
        assert.equal(limitStage.$limit, 10);
    });

    test("Returns empty dishes list with count 0 when no orders qualify", async () => {
        Order.aggregate = async () => [];

        let statusCode = null;
        let responseBody = null;

        const req = {};
        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => {
                        responseBody = data;
                    }
                };
            }
        };

        await getMostOrderedDishes(req, res);

        assert.equal(statusCode, 200);
        assert.equal(responseBody.success, true);
        assert.equal(responseBody.count, 0);
        assert.deepEqual(responseBody.dishes, []);
    });

    test("Handles aggregation errors and returns HTTP 500", async () => {
        Order.aggregate = async () => {
            throw new Error("Database connection lost");
        };

        let statusCode = null;
        let responseBody = null;

        const req = {};
        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => {
                        responseBody = data;
                    }
                };
            }
        };

        await getMostOrderedDishes(req, res);

        assert.equal(statusCode, 500);
        assert.equal(responseBody.success, false);
        assert.equal(responseBody.message, "Database connection lost");
    });

    test("Verifies /most-ordered route registration precedes /:id", () => {
        // Inspect Express router layer stack
        const getRoutes = menuRouter.stack
            .filter((layer) => layer.route && layer.route.methods && layer.route.methods.get)
            .map((layer) => layer.route.path);

        const mostOrderedIndex = getRoutes.indexOf("/most-ordered");
        const idIndex = getRoutes.indexOf("/:id");

        assert.ok(mostOrderedIndex !== -1, "/most-ordered route must be registered");
        assert.ok(idIndex !== -1, "/:id route must be registered");
        assert.ok(
            mostOrderedIndex < idIndex,
            `Expected /most-ordered (index ${mostOrderedIndex}) to be defined before /:id (index ${idIndex})`
        );
    });
});

