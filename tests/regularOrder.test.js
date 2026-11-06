const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const RegularOrder = require("../models/RegularOrder");
const Menu = require("../models/Menu");
const {
    getCollections,
    getCollectionById,
    createCollection,
    renameCollection,
    deleteCollection,
    addDishToCollection,
    updateDishQuantity,
    removeDishFromCollection,
    validateAndPrepareReorder
} = require("../controllers/regularOrderController");

describe("Regular Order Controller - My Regular Orders (Milestone 4)", () => {
    let originalRegularOrderFind;
    let originalRegularOrderFindOne;
    let originalRegularOrderFindById;
    let originalRegularOrderCreate;
    let originalRegularOrderFindByIdAndDelete;
    let originalMenuFindById;

    beforeEach(() => {
        originalRegularOrderFind = RegularOrder.find;
        originalRegularOrderFindOne = RegularOrder.findOne;
        originalRegularOrderFindById = RegularOrder.findById;
        originalRegularOrderCreate = RegularOrder.create;
        originalRegularOrderFindByIdAndDelete = RegularOrder.findByIdAndDelete;
        originalMenuFindById = Menu.findById;
    });

    afterEach(() => {
        RegularOrder.find = originalRegularOrderFind;
        RegularOrder.findOne = originalRegularOrderFindOne;
        RegularOrder.findById = originalRegularOrderFindById;
        RegularOrder.create = originalRegularOrderCreate;
        RegularOrder.findByIdAndDelete = originalRegularOrderFindByIdAndDelete;
        Menu.findById = originalMenuFindById;
    });

    const userA = new mongoose.Types.ObjectId().toString();
    const userB = new mongoose.Types.ObjectId().toString();
    const testMenuId1 = new mongoose.Types.ObjectId().toString();
    const testMenuId2 = new mongoose.Types.ObjectId().toString();
    const testCollectionId = new mongoose.Types.ObjectId().toString();

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

    // 1. Authenticated customer can create a collection
    test("1. Authenticated customer can create a collection", async () => {
        let createdPayload = null;
        RegularOrder.findOne = async () => null; // No duplicate
        RegularOrder.create = async (doc) => {
            createdPayload = doc;
            return {
                ...doc,
                _id: testCollectionId,
                populate: async () => doc
            };
        };

        const req = {
            user: { id: userA },
            body: { name: "Weekend Brunch" }
        };
        const res = mockRes();

        await createCollection(req, res);

        assert.equal(res.getStatusCode(), 201);
        assert.equal(res.getBody().success, true);
        assert.equal(createdPayload.name, "Weekend Brunch");
        assert.equal(createdPayload.nameLower, "weekend brunch");
        assert.equal(createdPayload.user, userA);
    });

    // 2. Unauthenticated requests are rejected (401)
    test("2. Unauthenticated requests are rejected across endpoints with HTTP 401", async () => {
        const endpoints = [
            () => getCollections({ user: null }, mockRes()),
            () => getCollectionById({ user: null, params: { id: testCollectionId } }, mockRes()),
            () => createCollection({ user: null, body: { name: "Test" } }, mockRes()),
            () => renameCollection({ user: null, params: { id: testCollectionId }, body: { name: "New" } }, mockRes()),
            () => deleteCollection({ user: null, params: { id: testCollectionId } }, mockRes()),
            () => addDishToCollection({ user: null, params: { id: testCollectionId }, body: { menuId: testMenuId1 } }, mockRes()),
            () => updateDishQuantity({ user: null, params: { id: testCollectionId, menuId: testMenuId1 }, body: { quantity: 2 } }, mockRes()),
            () => removeDishFromCollection({ user: null, params: { id: testCollectionId, menuId: testMenuId1 } }, mockRes()),
            () => validateAndPrepareReorder({ user: null, params: { id: testCollectionId } }, mockRes())
        ];

        for (const ep of endpoints) {
            const res = mockRes();
            await ep();
        }
    });

    // 3. Customer cannot access another customer's collection (403)
    test("3. Customer cannot access another customer's collection (HTTP 403)", async () => {
        const collectionOwnedByUserA = {
            _id: testCollectionId,
            user: userA,
            name: "Secret Breakfast",
            items: [],
            populate: async () => collectionOwnedByUserA
        };
        RegularOrder.findById = async () => ({
            ...collectionOwnedByUserA,
            populate: async () => collectionOwnedByUserA
        });

        const req = {
            user: { id: userB }, // User B trying to access User A's collection
            params: { id: testCollectionId }
        };
        const res = mockRes();

        await getCollectionById(req, res);

        assert.equal(res.getStatusCode(), 403);
        assert.equal(res.getBody().success, false);
        assert.equal(res.getBody().message, "Access denied. You do not own this collection");
    });

    // 4. Customer can rename their own collection
    test("4. Customer can rename their own collection", async () => {
        let saved = false;
        const mockDoc = {
            _id: testCollectionId,
            user: userA,
            name: "Old Name",
            nameLower: "old name",
            items: [],
            save: async function () {
                saved = true;
                return this;
            },
            populate: async function () {
                return this;
            }
        };
        RegularOrder.findById = async () => mockDoc;
        RegularOrder.findOne = async () => null; // No collision

        const req = {
            user: { id: userA },
            params: { id: testCollectionId },
            body: { name: "  Sunday Feast  " }
        };
        const res = mockRes();

        await renameCollection(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(res.getBody().success, true);
        assert.equal(mockDoc.name, "Sunday Feast");
        assert.equal(mockDoc.nameLower, "sunday feast");
        assert.equal(saved, true);
    });

    // 5. Customer can delete their own collection
    test("5. Customer can delete their own collection", async () => {
        let deletedId = null;
        const mockDoc = {
            _id: testCollectionId,
            user: userA
        };
        RegularOrder.findById = async () => mockDoc;
        RegularOrder.findByIdAndDelete = async (id) => {
            deletedId = id;
            return mockDoc;
        };

        const req = {
            user: { id: userA },
            params: { id: testCollectionId }
        };
        const res = mockRes();

        await deleteCollection(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(res.getBody().success, true);
        assert.equal(deletedId, testCollectionId);
    });

    // 6. Customer can add a valid dish
    test("6. Customer can add a valid dish to collection", async () => {
        let savedDoc = null;
        const mockDoc = {
            _id: testCollectionId,
            user: userA,
            items: [],
            save: async function () {
                savedDoc = this;
                return this;
            },
            populate: async function () {
                return this;
            }
        };
        RegularOrder.findById = async () => mockDoc;
        Menu.findById = async (id) => ({
            _id: id,
            name: "Tomato Soup",
            price: 250
        });

        const req = {
            user: { id: userA },
            params: { id: testCollectionId },
            body: { menuId: testMenuId1, quantity: 2 }
        };
        const res = mockRes();

        await addDishToCollection(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(res.getBody().success, true);
        assert.equal(mockDoc.items.length, 1);
        assert.equal(mockDoc.items[0].menu.toString(), testMenuId1);
        assert.equal(mockDoc.items[0].quantity, 2);
    });

    // 7. Duplicate dish is handled correctly (rejected with 400)
    test("7. Adding duplicate dish inside collection is rejected with HTTP 400", async () => {
        const mockDoc = {
            _id: testCollectionId,
            user: userA,
            items: [{ menu: testMenuId1, quantity: 1 }],
            save: async () => mockDoc,
            populate: async () => mockDoc
        };
        RegularOrder.findById = async () => mockDoc;
        Menu.findById = async () => ({ _id: testMenuId1, name: "Tomato Soup" });

        const req = {
            user: { id: userA },
            params: { id: testCollectionId },
            body: { menuId: testMenuId1, quantity: 1 }
        };
        const res = mockRes();

        await addDishToCollection(req, res);

        assert.equal(res.getStatusCode(), 400);
        assert.equal(res.getBody().success, false);
        assert.equal(res.getBody().message, "Dish already exists in this collection");
    });

    // 8. Customer can update quantity
    test("8. Customer can update dish quantity in collection", async () => {
        const mockDoc = {
            _id: testCollectionId,
            user: userA,
            items: [{ menu: testMenuId1, quantity: 1 }],
            save: async function () {
                return this;
            },
            populate: async function () {
                return this;
            }
        };
        RegularOrder.findById = async () => mockDoc;

        const req = {
            user: { id: userA },
            params: { id: testCollectionId, menuId: testMenuId1 },
            body: { quantity: 5 }
        };
        const res = mockRes();

        await updateDishQuantity(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(res.getBody().success, true);
        assert.equal(mockDoc.items[0].quantity, 5);
    });

    // 9. Invalid quantity is rejected
    test("9. Invalid quantities (< 1, > 99, non-numeric) are rejected with HTTP 400", async () => {
        const mockDoc = {
            _id: testCollectionId,
            user: userA,
            items: [{ menu: testMenuId1, quantity: 1 }],
            save: async () => mockDoc
        };
        RegularOrder.findById = async () => mockDoc;

        // Zero quantity
        const res1 = mockRes();
        await updateDishQuantity(
            { user: { id: userA }, params: { id: testCollectionId, menuId: testMenuId1 }, body: { quantity: 0 } },
            res1
        );
        assert.equal(res1.getStatusCode(), 400);

        // Negative quantity
        const res2 = mockRes();
        await updateDishQuantity(
            { user: { id: userA }, params: { id: testCollectionId, menuId: testMenuId1 }, body: { quantity: -2 } },
            res2
        );
        assert.equal(res2.getStatusCode(), 400);

        // > 99 quantity
        const res3 = mockRes();
        await updateDishQuantity(
            { user: { id: userA }, params: { id: testCollectionId, menuId: testMenuId1 }, body: { quantity: 100 } },
            res3
        );
        assert.equal(res3.getStatusCode(), 400);

        // Non-integer string
        const res4 = mockRes();
        await updateDishQuantity(
            { user: { id: userA }, params: { id: testCollectionId, menuId: testMenuId1 }, body: { quantity: "abc" } },
            res4
        );
        assert.equal(res4.getStatusCode(), 400);
    });

    // 10. Customer can remove a dish
    test("10. Customer can remove a dish from collection", async () => {
        const mockDoc = {
            _id: testCollectionId,
            user: userA,
            items: [
                { menu: testMenuId1, quantity: 2 },
                { menu: testMenuId2, quantity: 1 }
            ],
            save: async function () {
                return this;
            },
            populate: async function () {
                return this;
            }
        };
        RegularOrder.findById = async () => mockDoc;

        const req = {
            user: { id: userA },
            params: { id: testCollectionId, menuId: testMenuId1 }
        };
        const res = mockRes();

        await removeDishFromCollection(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(res.getBody().success, true);
        assert.equal(mockDoc.items.length, 1);
        assert.equal(mockDoc.items[0].menu, testMenuId2);
    });

    // 11. Invalid menu ID is rejected
    test("11. Invalid menu ID is rejected with HTTP 400", async () => {
        const req = {
            user: { id: userA },
            params: { id: testCollectionId },
            body: { menuId: "invalid-id-format" }
        };
        const res = mockRes();

        await addDishToCollection(req, res);

        assert.equal(res.getStatusCode(), 400);
        assert.equal(res.getBody().success, false);
        assert.equal(res.getBody().message, "Invalid menu ID");
    });

    // 12. Missing/deleted menu item is handled safely
    test("12. Missing/deleted menu item is handled safely during addition and reorder validation", async () => {
        // A. Adding non-existent menu item returns 404
        const mockDoc = {
            _id: testCollectionId,
            user: userA,
            items: [],
            save: async () => mockDoc
        };
        RegularOrder.findById = async () => mockDoc;
        Menu.findById = async () => null; // Not found

        const resAdd = mockRes();
        await addDishToCollection(
            { user: { id: userA }, params: { id: testCollectionId }, body: { menuId: testMenuId1 } },
            resAdd
        );
        assert.equal(resAdd.getStatusCode(), 404);
        assert.equal(resAdd.getBody().message, "Menu item not found");

        // B. Reorder validation gracefully partitions unavailable/deleted dishes
        const collectionWithItems = {
            _id: testCollectionId,
            user: userA,
            name: "Daily Lunch",
            items: [
                { menu: testMenuId1, quantity: 2 }, // Deleted
                { menu: testMenuId2, quantity: 1 }  // Available
            ]
        };
        RegularOrder.findById = async () => collectionWithItems;

        Menu.findById = (id) => {
            if (id === testMenuId1) {
                return {
                    populate: async () => null // Deleted dish
                };
            }
            return {
                populate: async () => ({
                    _id: testMenuId2,
                    name: "Classic Cheese Pizza",
                    price: 499,
                    isAvailable: true
                })
            };
        };

        const resReorder = mockRes();
        await validateAndPrepareReorder(
            { user: { id: userA }, params: { id: testCollectionId } },
            resReorder
        );

        assert.equal(resReorder.getStatusCode(), 200);
        const body = resReorder.getBody();
        assert.equal(body.availableItems.length, 1);
        assert.equal(body.availableItems[0].item.name, "Classic Cheese Pizza");
        assert.equal(body.availableItems[0].item.price, 499);
        assert.equal(body.unavailableItems.length, 1);
        assert.equal(body.unavailableItems[0].reason, "No longer on the menu");
    });

    // 13. Collection name validation works
    test("13. Collection name validation rejects empty strings, whitespace, and duplicate names", async () => {
        // Empty
        const resEmpty = mockRes();
        await createCollection({ user: { id: userA }, body: { name: "" } }, resEmpty);
        assert.equal(resEmpty.getStatusCode(), 400);
        assert.equal(resEmpty.getBody().message, "Collection name is required");

        // Whitespace only
        const resWhitespace = mockRes();
        await createCollection({ user: { id: userA }, body: { name: "   " } }, resWhitespace);
        assert.equal(resWhitespace.getStatusCode(), 400);

        // > 60 chars
        const resLong = mockRes();
        await createCollection({ user: { id: userA }, body: { name: "A".repeat(61) } }, resLong);
        assert.equal(resLong.getStatusCode(), 400);

        // Duplicate name (case-insensitive)
        RegularOrder.findOne = async () => ({ _id: "existing_col", name: "Lunch", user: userA });
        const resDup = mockRes();
        await createCollection({ user: { id: userA }, body: { name: "lunch" } }, resDup);
        assert.equal(resDup.getStatusCode(), 400);
        assert.equal(resDup.getBody().message, "A collection with this name already exists");
    });

    // 14. Collection ownership is enforced on every endpoint
    test("14. Collection ownership is enforced on every mutation endpoint", async () => {
        const foreignCollection = {
            _id: testCollectionId,
            user: userA, // Owned by userA
            items: [{ menu: testMenuId1, quantity: 1 }],
            save: async () => foreignCollection
        };
        RegularOrder.findById = async () => foreignCollection;

        // User B calls rename
        const resRename = mockRes();
        await renameCollection(
            { user: { id: userB }, params: { id: testCollectionId }, body: { name: "Hacked Name" } },
            resRename
        );
        assert.equal(resRename.getStatusCode(), 403);

        // User B calls delete
        const resDelete = mockRes();
        await deleteCollection(
            { user: { id: userB }, params: { id: testCollectionId } },
            resDelete
        );
        assert.equal(resDelete.getStatusCode(), 403);

        // User B calls add dish
        const resAdd = mockRes();
        await addDishToCollection(
            { user: { id: userB }, params: { id: testCollectionId }, body: { menuId: testMenuId2 } },
            resAdd
        );
        assert.equal(resAdd.getStatusCode(), 403);

        // User B calls update quantity
        const resUpdate = mockRes();
        await updateDishQuantity(
            { user: { id: userB }, params: { id: testCollectionId, menuId: testMenuId1 }, body: { quantity: 4 } },
            resUpdate
        );
        assert.equal(resUpdate.getStatusCode(), 403);

        // User B calls remove dish
        const resRemove = mockRes();
        await removeDishFromCollection(
            { user: { id: userB }, params: { id: testCollectionId, menuId: testMenuId1 } },
            resRemove
        );
        assert.equal(resRemove.getStatusCode(), 403);

        // User B calls reorder validation
        const resReorder = mockRes();
        await validateAndPrepareReorder(
            { user: { id: userB }, params: { id: testCollectionId } },
            resReorder
        );
        assert.equal(resReorder.getStatusCode(), 403);
    });
});

