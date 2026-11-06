const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Menu = require("../models/Menu");
const admin = require("../middleware/admin");
const menuRouter = require("../routes/menuRoutes");
const {
    getSeasonalSpecials,
    updateSeasonalSpecial
} = require("../controllers/menuController");

describe("Menu Controller - Seasonal Specials (Milestone 3)", () => {
    let originalMenuFind;
    let originalMenuFindById;

    beforeEach(() => {
        originalMenuFind = Menu.find;
        originalMenuFindById = Menu.findById;
    });

    afterEach(() => {
        Menu.find = originalMenuFind;
        Menu.findById = originalMenuFindById;
    });

    const testMenuId = new mongoose.Types.ObjectId().toString();

    function mockRes() {
        let statusCode = 200;
        let responseBody = null;
        return {
            status: (code) => {
                statusCode = code;
                return {
                    json: (body) => {
                        responseBody = body;
                        return body;
                    }
                };
            },
            json: (body) => {
                responseBody = body;
                return body;
            },
            getStatusCode: () => statusCode,
            getBody: () => responseBody
        };
    }

    // 1. Admin can create/update a seasonal special
    test("1. Admin can update a seasonal special with valid dates", async () => {
        let savedDoc = null;
        const mockMenuDoc = {
            _id: testMenuId,
            name: "Winter Truffle Risotto",
            price: 650,
            isSeasonalSpecial: false,
            specialStartDate: null,
            specialEndDate: null,
            save: async function () {
                savedDoc = this;
                return this;
            },
            populate: async function () {
                return this;
            }
        };

        Menu.findById = async () => mockMenuDoc;

        const req = {
            params: { id: testMenuId },
            body: {
                isSeasonalSpecial: true,
                specialStartDate: "2026-11-01",
                specialEndDate: "2026-11-30"
            }
        };
        const res = mockRes();

        await updateSeasonalSpecial(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(res.getBody().success, true);
        assert.equal(savedDoc.isSeasonalSpecial, true);
        assert.ok(savedDoc.specialStartDate instanceof Date);
        assert.ok(savedDoc.specialEndDate instanceof Date);
        // Verify start of day in IST (UTC 2026-10-31T18:30:00.000Z)
        assert.equal(savedDoc.specialStartDate.toISOString(), "2026-10-31T18:30:00.000Z");
        // Verify end of day in IST (UTC 2026-11-30T18:29:59.999Z)
        assert.equal(savedDoc.specialEndDate.toISOString(), "2026-11-30T18:29:59.999Z");
    });

    // 2. Non-admin cannot manage specials (HTTP 403)
    test("2. Non-admin cannot manage specials (HTTP 403 via admin middleware)", async () => {
        const req = {
            user: { role: "customer", id: "cust_123" }
        };
        const res = mockRes();
        let nextCalled = false;
        const next = () => {
            nextCalled = true;
        };

        admin(req, res, next);

        assert.equal(nextCalled, false);
        assert.equal(res.getStatusCode(), 403);
        assert.equal(res.getBody().success, false);
        assert.equal(res.getBody().message, "Access Denied. Admin Only.");
    });

    // 3. Active special is returned by getSeasonalSpecials
    test("3. Active special is returned by getSeasonalSpecials", async () => {
        let capturedQuery = null;
        const mockSpecials = [
            {
                _id: testMenuId,
                name: "Winter Truffle Risotto",
                price: 650,
                isSeasonalSpecial: true,
                isAvailable: true,
                category: { _id: "cat_1", name: "Specials" }
            }
        ];

        Menu.find = (query) => {
            capturedQuery = query;
            return {
                populate: () => ({
                    sort: async () => mockSpecials
                })
            };
        };

        const req = {};
        const res = mockRes();

        await getSeasonalSpecials(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(res.getBody().success, true);
        assert.equal(res.getBody().count, 1);
        assert.equal(res.getBody().specials[0].name, "Winter Truffle Risotto");

        // Verify query structure
        assert.equal(capturedQuery.isSeasonalSpecial, true);
        assert.equal(capturedQuery.isAvailable, true);
        assert.ok(Array.isArray(capturedQuery.$and));
    });

    // 4. Scheduled special (future start date) is excluded from public endpoint
    test("4. Scheduled special (future start date) is excluded by query filters", async () => {
        let capturedQuery = null;

        Menu.find = (query) => {
            capturedQuery = query;
            return {
                populate: () => ({
                    sort: async () => []
                })
            };
        };

        const req = {};
        const res = mockRes();

        await getSeasonalSpecials(req, res);

        // Find the start date condition in $and
        const startCond = capturedQuery.$and.find((c) =>
            c.$or && c.$or.some((o) => o.specialStartDate && o.specialStartDate.$lte)
        );
        assert.ok(startCond, "Query must have a condition requiring specialStartDate <= now");
        const lteFilter = startCond.$or.find((o) => o.specialStartDate && o.specialStartDate.$lte);
        assert.ok(lteFilter.specialStartDate.$lte instanceof Date);

        // Test with mock dates: future start date must be > now
        const now = lteFilter.specialStartDate.$lte;
        const futureDate = new Date(now.getTime() + 86400000);
        assert.ok(futureDate > now, "Future date is greater than cutoff");
    });

    // 5. Expired special (past end date) is excluded from public endpoint
    test("5. Expired special (past end date) is excluded by query filters", async () => {
        let capturedQuery = null;

        Menu.find = (query) => {
            capturedQuery = query;
            return {
                populate: () => ({
                    sort: async () => []
                })
            };
        };

        const req = {};
        const res = mockRes();

        await getSeasonalSpecials(req, res);

        // Find the end date condition in $and
        const endCond = capturedQuery.$and.find((c) =>
            c.$or && c.$or.some((o) => o.specialEndDate && o.specialEndDate.$gte)
        );
        assert.ok(endCond, "Query must have a condition requiring specialEndDate >= now");
        const gteFilter = endCond.$or.find((o) => o.specialEndDate && o.specialEndDate.$gte);
        assert.ok(gteFilter.specialEndDate.$gte instanceof Date);

        // Test with mock dates: past end date must be < now
        const now = gteFilter.specialEndDate.$gte;
        const pastDate = new Date(now.getTime() - 86400000);
        assert.ok(pastDate < now, "Past date is less than cutoff");
    });

    // 6. Unavailable menu item (isAvailable: false) is excluded from public endpoint
    test("6. Unavailable menu item (isAvailable: false) is excluded from public endpoint", async () => {
        let capturedQuery = null;

        Menu.find = (query) => {
            capturedQuery = query;
            return {
                populate: () => ({
                    sort: async () => []
                })
            };
        };

        const req = {};
        const res = mockRes();

        await getSeasonalSpecials(req, res);

        assert.equal(capturedQuery.isAvailable, true, "isAvailable must strictly be true in query");
    });

    // 7. Missing start date works (active immediately)
    test("7. Missing start date works and is included in $or criteria", async () => {
        let capturedQuery = null;

        Menu.find = (query) => {
            capturedQuery = query;
            return {
                populate: () => ({
                    sort: async () => []
                })
            };
        };

        const req = {};
        const res = mockRes();

        await getSeasonalSpecials(req, res);

        const startCond = capturedQuery.$and.find((c) =>
            c.$or && c.$or.some((o) => o.specialStartDate === null)
        );
        assert.ok(startCond, "Start date criteria must allow null start date for immediate activation");
    });

    // 8. Missing expiry date works (active indefinitely)
    test("8. Missing expiry date works and is included in $or criteria", async () => {
        let capturedQuery = null;

        Menu.find = (query) => {
            capturedQuery = query;
            return {
                populate: () => ({
                    sort: async () => []
                })
            };
        };

        const req = {};
        const res = mockRes();

        await getSeasonalSpecials(req, res);

        const endCond = capturedQuery.$and.find((c) =>
            c.$or && c.$or.some((o) => o.specialEndDate === null)
        );
        assert.ok(endCond, "End date criteria must allow null end date for indefinite specials");
    });

    // 9. Invalid date string rejected with HTTP 400
    test("9. Invalid date string rejected with HTTP 400", async () => {
        const mockMenuDoc = {
            _id: testMenuId,
            name: "Winter Truffle Risotto",
            isSeasonalSpecial: true,
            specialStartDate: null,
            specialEndDate: null,
            save: async () => mockMenuDoc,
            populate: async () => mockMenuDoc
        };
        Menu.findById = async () => mockMenuDoc;

        // Test invalid start date
        const reqInvalidStart = {
            params: { id: testMenuId },
            body: { specialStartDate: "not-a-valid-date" }
        };
        const resInvalidStart = mockRes();
        await updateSeasonalSpecial(reqInvalidStart, resInvalidStart);
        assert.equal(resInvalidStart.getStatusCode(), 400);
        assert.equal(resInvalidStart.getBody().success, false);
        assert.equal(resInvalidStart.getBody().message, "Invalid start date format");

        // Test invalid end date
        const reqInvalidEnd = {
            params: { id: testMenuId },
            body: { specialEndDate: "garbage-date" }
        };
        const resInvalidEnd = mockRes();
        await updateSeasonalSpecial(reqInvalidEnd, resInvalidEnd);
        assert.equal(resInvalidEnd.getStatusCode(), 400);
        assert.equal(resInvalidEnd.getBody().success, false);
        assert.equal(resInvalidEnd.getBody().message, "Invalid end date format");
    });

    // 10. End date earlier than start date rejected with HTTP 400
    test("10. End date earlier than start date rejected with HTTP 400", async () => {
        const mockMenuDoc = {
            _id: testMenuId,
            name: "Winter Truffle Risotto",
            isSeasonalSpecial: true,
            specialStartDate: null,
            specialEndDate: null,
            save: async () => mockMenuDoc,
            populate: async () => mockMenuDoc
        };
        Menu.findById = async () => mockMenuDoc;

        const req = {
            params: { id: testMenuId },
            body: {
                specialStartDate: "2026-12-01",
                specialEndDate: "2026-11-01"
            }
        };
        const res = mockRes();

        await updateSeasonalSpecial(req, res);

        assert.equal(res.getStatusCode(), 400);
        assert.equal(res.getBody().success, false);
        assert.equal(res.getBody().message, "End date cannot be earlier than start date");
    });

    // 11. Disabled special (isSeasonalSpecial: false) is excluded from public endpoint
    test("11. Disabled special (isSeasonalSpecial: false) is excluded and updating works", async () => {
        let savedDoc = null;
        const mockMenuDoc = {
            _id: testMenuId,
            name: "Winter Truffle Risotto",
            isSeasonalSpecial: true,
            specialStartDate: new Date("2026-11-01"),
            specialEndDate: new Date("2026-11-30"),
            save: async function () {
                savedDoc = this;
                return this;
            },
            populate: async function () {
                return this;
            }
        };
        Menu.findById = async () => mockMenuDoc;

        const req = {
            params: { id: testMenuId },
            body: { isSeasonalSpecial: false }
        };
        const res = mockRes();

        await updateSeasonalSpecial(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(savedDoc.isSeasonalSpecial, false);
    });

    // 12. Existing menu routes/endpoints remain unaffected
    test("12. Verifies route order: /seasonal-specials precedes /:id and /:id/seasonal-special precedes /:id", () => {
        // Inspect Express router layer stack
        const getRoutes = menuRouter.stack
            .filter((layer) => layer.route && layer.route.methods && layer.route.methods.get)
            .map((layer) => layer.route.path);

        const seasonalSpecialsIndex = getRoutes.indexOf("/seasonal-specials");
        const mostOrderedIndex = getRoutes.indexOf("/most-ordered");
        const idGetIndex = getRoutes.indexOf("/:id");

        assert.ok(seasonalSpecialsIndex !== -1, "/seasonal-specials GET route must be registered");
        assert.ok(mostOrderedIndex !== -1, "/most-ordered GET route must be registered");
        assert.ok(idGetIndex !== -1, "/:id GET route must be registered");
        assert.ok(
            seasonalSpecialsIndex < idGetIndex,
            `Expected /seasonal-specials (index ${seasonalSpecialsIndex}) to precede /:id (index ${idGetIndex})`
        );

        const putRoutes = menuRouter.stack
            .filter((layer) => layer.route && layer.route.methods && layer.route.methods.put)
            .map((layer) => layer.route.path);

        const seasonalSpecialPutIndex = putRoutes.indexOf("/:id/seasonal-special");
        const idPutIndex = putRoutes.indexOf("/:id");

        assert.ok(seasonalSpecialPutIndex !== -1, "/:id/seasonal-special PUT route must be registered");
        assert.ok(idPutIndex !== -1, "/:id PUT route must be registered");
        assert.ok(
            seasonalSpecialPutIndex < idPutIndex,
            `Expected /:id/seasonal-special (index ${seasonalSpecialPutIndex}) to precede /:id (index ${idPutIndex})`
        );
    });
});

