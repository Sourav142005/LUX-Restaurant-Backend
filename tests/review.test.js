const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Review = require("../models/Review");
const Menu = require("../models/Menu");
const Order = require("../models/Order");
const {
    recalculateMenuRating,
    getMenuReviews,
    getMyReviewForDish,
    createOrUpdateReview,
    updateReviewById,
    deleteReview
} = require("../controllers/reviewController");

describe("Review Controller - Ratings & Reviews (Milestone 2)", () => {
    let originalReviewFind;
    let originalReviewFindOne;
    let originalReviewFindById;
    let originalReviewCreate;
    let originalReviewFindByIdAndDelete;
    let originalReviewAggregate;
    let originalMenuFindById;
    let originalMenuFindByIdAndUpdate;
    let originalOrderFindById;
    let originalOrderFindOne;

    beforeEach(() => {
        originalReviewFind = Review.find;
        originalReviewFindOne = Review.findOne;
        originalReviewFindById = Review.findById;
        originalReviewCreate = Review.create;
        originalReviewFindByIdAndDelete = Review.findByIdAndDelete;
        originalReviewAggregate = Review.aggregate;
        originalMenuFindById = Menu.findById;
        originalMenuFindByIdAndUpdate = Menu.findByIdAndUpdate;
        originalOrderFindById = Order.findById;
        originalOrderFindOne = Order.findOne;
    });

    afterEach(() => {
        Review.find = originalReviewFind;
        Review.findOne = originalReviewFindOne;
        Review.findById = originalReviewFindById;
        Review.create = originalReviewCreate;
        Review.findByIdAndDelete = originalReviewFindByIdAndDelete;
        Review.aggregate = originalReviewAggregate;
        Menu.findById = originalMenuFindById;
        Menu.findByIdAndUpdate = originalMenuFindByIdAndUpdate;
        Order.findById = originalOrderFindById;
        Order.findOne = originalOrderFindOne;
    });

    const testMenuId = new mongoose.Types.ObjectId().toString();
    const testOrderId = new mongoose.Types.ObjectId().toString();
    const testUserId = new mongoose.Types.ObjectId().toString();
    const testReviewId = new mongoose.Types.ObjectId().toString();

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

    // 1. Valid review submission
    test("1. Valid review submission creates review and updates menu rating", async () => {
        const req = {
            user: { id: testUserId },
            body: {
                menuId: testMenuId,
                orderId: testOrderId,
                rating: 5,
                comment: "Superb truffle pizza!"
            }
        };
        const res = mockRes();

        Menu.findById = async () => ({ _id: testMenuId, name: "Truffle Pizza", rating: 0 });
        Order.findById = async () => ({
            _id: testOrderId,
            user: testUserId,
            orderStatus: "Delivered",
            paymentStatus: "Paid",
            items: [{ menu: testMenuId, quantity: 1 }]
        });
        Review.findOne = async () => null; // No existing review
        Review.create = async (doc) => ({
            _id: testReviewId,
            ...doc
        });
        Review.aggregate = async () => [
            { _id: new mongoose.Types.ObjectId(testMenuId), avgRating: 5, numReviews: 1 }
        ];
        let menuUpdateArgs = null;
        Menu.findByIdAndUpdate = async (id, update) => {
            menuUpdateArgs = { id, update };
        };

        await createOrUpdateReview(req, res);

        assert.equal(res.getStatusCode(), 201);
        assert.equal(res.getBody().success, true);
        assert.equal(res.getBody().review.rating, 5);
        assert.equal(res.getBody().review.comment, "Superb truffle pizza!");
        assert.equal(menuUpdateArgs.update.rating, 5);
        assert.equal(menuUpdateArgs.update.numReviews, 1);
    });

    // 2. Rejection of unauthenticated submission
    test("2. Rejection when user ID is missing (unauthenticated)", async () => {
        const req = {
            user: null,
            body: {
                menuId: testMenuId,
                orderId: testOrderId,
                rating: 5
            }
        };
        const res = mockRes();

        Menu.findById = async () => ({ _id: testMenuId });
        await createOrUpdateReview(req, res);

        assert.ok([401, 403].includes(res.getStatusCode()));
        assert.equal(res.getBody().success, false);
    });

    // 3. Rejection when user does not own the order
    test("3. Rejection when the user does not own the order with HTTP 403", async () => {
        const differentUser = new mongoose.Types.ObjectId().toString();
        const req = {
            user: { id: testUserId },
            body: {
                menuId: testMenuId,
                orderId: testOrderId,
                rating: 4
            }
        };
        const res = mockRes();

        Menu.findById = async () => ({ _id: testMenuId });
        Order.findById = async () => ({
            _id: testOrderId,
            user: differentUser, // Belongs to different user!
            orderStatus: "Delivered",
            paymentStatus: "Paid",
            items: [{ menu: testMenuId, quantity: 1 }]
        });

        await createOrUpdateReview(req, res);

        assert.equal(res.getStatusCode(), 403);
        assert.equal(res.getBody().success, false);
        assert.match(res.getBody().message, /do not own this order/i);
    });

    // 4. Rejection when order does not contain the dish
    test("4. Rejection when the order does not contain the specified dish with HTTP 400", async () => {
        const req = {
            user: { id: testUserId },
            body: {
                menuId: testMenuId,
                orderId: testOrderId,
                rating: 4
            }
        };
        const res = mockRes();

        Menu.findById = async () => ({ _id: testMenuId });
        Order.findById = async () => ({
            _id: testOrderId,
            user: testUserId,
            orderStatus: "Delivered",
            paymentStatus: "Paid",
            items: [{ menu: new mongoose.Types.ObjectId().toString(), quantity: 1 }] // Different dish!
        });

        await createOrUpdateReview(req, res);

        assert.equal(res.getStatusCode(), 400);
        assert.equal(res.getBody().success, false);
        assert.match(res.getBody().message, /contain the specified dish/i);
    });

    // 5. Rejection of non-delivered orders
    test("5. Rejection of non-delivered order with HTTP 400", async () => {
        const req = {
            user: { id: testUserId },
            body: {
                menuId: testMenuId,
                orderId: testOrderId,
                rating: 5
            }
        };
        const res = mockRes();

        Menu.findById = async () => ({ _id: testMenuId });
        Order.findById = async () => ({
            _id: testOrderId,
            user: testUserId,
            orderStatus: "Preparing", // Not delivered!
            paymentStatus: "Paid",
            items: [{ menu: testMenuId, quantity: 1 }]
        });

        await createOrUpdateReview(req, res);

        assert.equal(res.getStatusCode(), 400);
        assert.equal(res.getBody().success, false);
        assert.match(res.getBody().message, /delivered orders/i);
    });

    // 6. Rejection of ineligible payment status
    test("6. Rejection of ineligible payment status (Pending / Refunded) with HTTP 400", async () => {
        const req = {
            user: { id: testUserId },
            body: {
                menuId: testMenuId,
                orderId: testOrderId,
                rating: 5
            }
        };
        const res = mockRes();

        Menu.findById = async () => ({ _id: testMenuId });
        Order.findById = async () => ({
            _id: testOrderId,
            user: testUserId,
            orderStatus: "Delivered",
            paymentStatus: "Pending", // Unpaid!
            items: [{ menu: testMenuId, quantity: 1 }]
        });

        await createOrUpdateReview(req, res);

        assert.equal(res.getStatusCode(), 400);
        assert.equal(res.getBody().success, false);
        assert.match(res.getBody().message, /payment is not eligible/i);
    });

    // 7. Duplicate review prevention & updating existing review
    test("7. Submitting a review for a previously reviewed dish updates the existing review", async () => {
        const req = {
            user: { id: testUserId },
            body: {
                menuId: testMenuId,
                orderId: testOrderId,
                rating: 4,
                comment: "Updated: delicious crust!"
            }
        };
        const res = mockRes();

        Menu.findById = async () => ({ _id: testMenuId });
        Order.findById = async () => ({
            _id: testOrderId,
            user: testUserId,
            orderStatus: "Delivered",
            paymentStatus: "Paid",
            items: [{ menu: testMenuId, quantity: 1 }]
        });

        let saved = false;
        const existingReview = {
            _id: testReviewId,
            user: testUserId,
            menu: testMenuId,
            order: testOrderId,
            rating: 5,
            comment: "Original review",
            save: async function () {
                saved = true;
                return this;
            }
        };
        Review.findOne = async () => existingReview;
        Review.create = async () => {
            throw new Error("Review.create should not be called when review exists!");
        };
        Review.aggregate = async () => [
            { _id: new mongoose.Types.ObjectId(testMenuId), avgRating: 4, numReviews: 1 }
        ];
        Menu.findByIdAndUpdate = async () => {};

        await createOrUpdateReview(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(res.getBody().success, true);
        assert.match(res.getBody().message, /updated/i);
        assert.equal(saved, true);
        assert.equal(existingReview.rating, 4);
        assert.equal(existingReview.comment, "Updated: delicious crust!");
    });

    // 8. Average rating recalculation after create, update, and delete
    test("8. Average rating recalculates to 1 decimal place and handles zero reviews correctly", async () => {
        // Case A: 3 reviews with ratings 5, 4, 4 -> average = 4.3333... -> rounded = 4.3
        Review.aggregate = async () => [
            { _id: new mongoose.Types.ObjectId(testMenuId), avgRating: 4.3333333333, numReviews: 3 }
        ];
        let recordedUpdate = null;
        Menu.findByIdAndUpdate = async (id, update) => {
            recordedUpdate = update;
        };

        const statsA = await recalculateMenuRating(testMenuId);
        assert.equal(statsA.rating, 4.3);
        assert.equal(statsA.numReviews, 3);
        assert.equal(recordedUpdate.rating, 4.3);
        assert.equal(recordedUpdate.numReviews, 3);

        // Case B: 0 reviews (e.g. after deletion) -> rating = 0, numReviews = 0
        Review.aggregate = async () => [];
        const statsB = await recalculateMenuRating(testMenuId);
        assert.equal(statsB.rating, 0);
        assert.equal(statsB.numReviews, 0);
        assert.equal(recordedUpdate.rating, 0);
        assert.equal(recordedUpdate.numReviews, 0);
    });

    // 9. Review deletion permissions (Author vs non-author vs admin)
    test("9. Review deletion permissions: Author and Admin may delete; unauthorized user rejected with HTTP 403", async () => {
        const otherUser = new mongoose.Types.ObjectId().toString();
        const reviewDoc = {
            _id: testReviewId,
            user: testUserId,
            menu: testMenuId
        };

        Review.findById = async () => reviewDoc;
        let deletedId = null;
        Review.findByIdAndDelete = async (id) => {
            deletedId = id;
        };
        Review.aggregate = async () => [];
        Menu.findByIdAndUpdate = async () => {};

        // Non-author attempt
        const reqUnauthorized = {
            user: { id: otherUser, role: "customer" },
            params: { id: testReviewId }
        };
        const resUnauthorized = mockRes();
        await deleteReview(reqUnauthorized, resUnauthorized);
        assert.equal(resUnauthorized.getStatusCode(), 403);
        assert.equal(deletedId, null);

        // Author attempt
        const reqAuthor = {
            user: { id: testUserId, role: "customer" },
            params: { id: testReviewId }
        };
        const resAuthor = mockRes();
        await deleteReview(reqAuthor, resAuthor);
        assert.equal(resAuthor.getStatusCode(), 200);
        assert.equal(deletedId, testReviewId);

        // Admin attempt on someone else's review
        deletedId = null;
        const reqAdmin = {
            user: { id: otherUser, role: "admin" },
            params: { id: testReviewId }
        };
        const resAdmin = mockRes();
        await deleteReview(reqAdmin, resAdmin);
        assert.equal(resAdmin.getStatusCode(), 200);
        assert.equal(deletedId, testReviewId);
    });

    // 10. Validation rejection of invalid ratings and excessive comment length
    test("10. Validation rejects rating < 1, rating > 5, non-numeric rating, and comment > 500 chars with HTTP 400", async () => {
        Menu.findById = async () => ({ _id: testMenuId });

        // Rating too low (< 1)
        const reqLow = {
            user: { id: testUserId },
            body: { menuId: testMenuId, rating: 0 }
        };
        const resLow = mockRes();
        await createOrUpdateReview(reqLow, resLow);
        assert.equal(resLow.getStatusCode(), 400);

        // Rating too high (> 5)
        const reqHigh = {
            user: { id: testUserId },
            body: { menuId: testMenuId, rating: 6 }
        };
        const resHigh = mockRes();
        await createOrUpdateReview(reqHigh, resHigh);
        assert.equal(resHigh.getStatusCode(), 400);

        // Rating not a number
        const reqNaN = {
            user: { id: testUserId },
            body: { menuId: testMenuId, rating: "five stars" }
        };
        const resNaN = mockRes();
        await createOrUpdateReview(reqNaN, resNaN);
        assert.equal(resNaN.getStatusCode(), 400);

        // Comment > 500 characters
        const longComment = "a".repeat(501);
        const reqLong = {
            user: { id: testUserId },
            body: { menuId: testMenuId, rating: 5, comment: longComment }
        };
        const resLong = mockRes();
        await createOrUpdateReview(reqLong, resLong);
        assert.equal(resLong.getStatusCode(), 400);
        assert.match(resLong.getBody().message, /cannot exceed 500 characters/i);
    });

    // Bonus: Public review retrieval does not leak private user fields
    test("11. Public review retrieval populates ONLY fullName on user", async () => {
        const req = { params: { menuId: testMenuId } };
        const res = mockRes();

        Menu.findById = () => ({
            select: () => ({ name: "Truffle Pizza", rating: 4.8, numReviews: 1 })
        });

        let populatedPath = null;
        let populatedSelect = null;
        Review.find = () => ({
            populate: (path, select) => {
                populatedPath = path;
                populatedSelect = select;
                return {
                    sort: () => [
                        {
                            _id: testReviewId,
                            rating: 5,
                            comment: "Delicious",
                            user: { _id: testUserId, fullName: "Alice Smith" }
                        }
                    ]
                };
            }
        });

        await getMenuReviews(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(populatedPath, "user");
        assert.equal(populatedSelect, "fullName");
        assert.equal(res.getBody().reviews[0].user.fullName, "Alice Smith");
        assert.equal(res.getBody().reviews[0].user.email, undefined);
        assert.equal(res.getBody().reviews[0].user.phone, undefined);
    });

    // 12. A second qualifying order for the same dish updates the existing review and does not create a second review
    test("12. A second qualifying order for the same dish updates the existing review and does not duplicate", async () => {
        const secondOrderId = new mongoose.Types.ObjectId().toString();
        const req = {
            user: { id: testUserId },
            body: {
                menuId: testMenuId,
                orderId: secondOrderId, // Second order!
                rating: 5,
                comment: "Ordered again, even better this time!"
            }
        };
        const res = mockRes();

        Menu.findById = async () => ({ _id: testMenuId });
        Order.findById = async () => ({
            _id: secondOrderId,
            user: testUserId,
            orderStatus: "Delivered",
            paymentStatus: "Paid",
            items: [{ menu: testMenuId, quantity: 2 }]
        });

        let createCalled = false;
        Review.create = async () => {
            createCalled = true;
        };

        let updatedOrderRef = null;
        let updatedComment = null;
        const existingReview = {
            _id: testReviewId,
            user: testUserId,
            menu: testMenuId,
            order: testOrderId,
            rating: 4,
            comment: "First review",
            save: async function () {
                updatedOrderRef = this.order;
                updatedComment = this.comment;
                return this;
            }
        };
        Review.findOne = async () => existingReview;
        Review.aggregate = async () => [
            { _id: new mongoose.Types.ObjectId(testMenuId), avgRating: 5, numReviews: 1 }
        ];
        Menu.findByIdAndUpdate = async () => {};

        await createOrUpdateReview(req, res);

        assert.equal(res.getStatusCode(), 200);
        assert.equal(createCalled, false, "Must not create a new review document");
        assert.equal(updatedOrderRef, secondOrderId, "Should update order reference to latest qualifying order");
        assert.equal(updatedComment, "Ordered again, even better this time!");
    });

    // 13. Updating an existing review verifies that the user still has a qualifying purchase
    test("13. Updating an existing review via updateReviewById verifies that the user still has a qualifying purchase", async () => {
        const reviewDoc = {
            _id: testReviewId,
            user: testUserId,
            menu: testMenuId,
            rating: 4,
            comment: "Initial comment",
            save: async function () {
                return this;
            }
        };

        Review.findById = async () => reviewDoc;

        // Case A: User no longer has a qualifying purchase (e.g. order refunded or cancelled)
        Order.findOne = async () => null; // No qualifying purchase found!
        const reqNoPurchase = {
            user: { id: testUserId, role: "customer" },
            params: { id: testReviewId },
            body: { rating: 5, comment: "Trying to update after refund" }
        };
        const resNoPurchase = mockRes();
        await updateReviewById(reqNoPurchase, resNoPurchase);
        assert.equal(resNoPurchase.getStatusCode(), 403);
        assert.match(resNoPurchase.getBody().message, /qualifying delivered and paid order/i);

        // Case B: User has a qualifying purchase -> update succeeds
        Order.findOne = async () => ({
            _id: testOrderId,
            user: testUserId,
            orderStatus: "Delivered",
            paymentStatus: "Paid"
        });
        Review.aggregate = async () => [
            { _id: new mongoose.Types.ObjectId(testMenuId), avgRating: 5, numReviews: 1 }
        ];
        Menu.findByIdAndUpdate = async () => {};

        const reqWithPurchase = {
            user: { id: testUserId, role: "customer" },
            params: { id: testReviewId },
            body: { rating: 5, comment: "Updated successfully with verified order" }
        };
        const resWithPurchase = mockRes();
        await updateReviewById(reqWithPurchase, resWithPurchase);
        assert.equal(resWithPurchase.getStatusCode(), 200);
        assert.equal(reviewDoc.rating, 5);
        assert.equal(reviewDoc.comment, "Updated successfully with verified order");
    });
});

