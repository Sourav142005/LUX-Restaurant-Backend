const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");

// Provide mock environment variables for Razorpay initialization in test environment
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_mock_key_id";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "mock_secret";

const Menu = require("../models/Menu");
const { createOrder } = require("../controllers/orderController");

describe("Order Controller - Payment Policy Validation Tests", () => {

    before(() => {
        // Mock Menu.findById so tests run completely offline without MongoDB
        Menu.findById = async (id) => ({
            _id: id,
            name: "Test Dish",
            price: 250,
            isAvailable: true
        });
    });

    test("Rejects invalid paymentPolicy values with HTTP 400", async () => {
        const req = {
            user: { id: "user_1" },
            body: {
                items: [{ menu: "menu_1", quantity: 2 }],
                orderType: "Dine-In",
                paymentPolicy: "InvalidPolicy"
            }
        };

        let statusCode = null;
        let jsonResponse = null;

        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => {
                        jsonResponse = data;
                    }
                };
            }
        };

        await createOrder(req, res);

        assert.equal(statusCode, 400);
        assert.equal(jsonResponse.success, false);
        assert.equal(jsonResponse.message, "Invalid payment policy");
    });

    test("Rejects PayAfterDining policy for Takeaway orders with HTTP 400", async () => {
        const req = {
            user: { id: "user_1" },
            body: {
                items: [{ menu: "menu_1", quantity: 2 }],
                orderType: "Takeaway",
                paymentPolicy: "PayAfterDining"
            }
        };

        let statusCode = null;
        let jsonResponse = null;

        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => {
                        jsonResponse = data;
                    }
                };
            }
        };

        await createOrder(req, res);

        assert.equal(statusCode, 400);
        assert.equal(jsonResponse.success, false);
        assert.equal(jsonResponse.message, "PayAfterDining is only allowed for Dine-In orders");
    });

    test("Rejects PayAfterDining policy for Delivery orders with HTTP 400", async () => {
        const req = {
            user: { id: "user_1" },
            body: {
                items: [{ menu: "menu_1", quantity: 2 }],
                orderType: "Delivery",
                paymentPolicy: "PayAfterDining"
            }
        };

        let statusCode = null;
        let jsonResponse = null;

        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => {
                        jsonResponse = data;
                    }
                };
            }
        };

        await createOrder(req, res);

        assert.equal(statusCode, 400);
        assert.equal(jsonResponse.success, false);
        assert.equal(jsonResponse.message, "PayAfterDining is only allowed for Dine-In orders");
    });
});
