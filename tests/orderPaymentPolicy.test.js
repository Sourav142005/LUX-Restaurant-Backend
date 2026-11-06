const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");

// Provide mock environment variables for Razorpay initialization in test environment
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_mock_key_id";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "mock_secret";

const Menu = require("../models/Menu");
const Order = require("../models/Order");
const { createOrder, updateOrderStatus, cancelOrder } = require("../controllers/orderController");

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

describe("Order Controller - Cancellation Safeguard & Reason Handling Tests", () => {

    test("updateOrderStatus rejects orderStatus 'Cancelled' with HTTP 400 and directs caller to cancellation endpoint", async () => {
        const req = {
            params: { id: "order_mock_123" },
            body: {
                orderStatus: "Cancelled"
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

        await updateOrderStatus(req, res);

        assert.equal(statusCode, 400);
        assert.equal(jsonResponse.success, false);
        assert.match(jsonResponse.message, /PATCH \/api\/order\/:id\/cancel/);
    });

    test("cancelOrder allows admin caller and preserves custom reason in cancellation response", async () => {
        const origFindById = Order.findById;
        try {
            const mockOrder = {
                _id: "order_admin_cancel_test",
                user: { toString: () => "customer_user_id" },
                orderStatus: "Pending",
                paymentStatus: "Pending",
                save: async () => {}
            };

            Order.findById = async () => mockOrder;

            const req = {
                params: { id: "order_admin_cancel_test" },
                user: { id: "admin_user_id", role: "admin" },
                body: {
                    reason: "Kitchen ingredient shortage"
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

            await cancelOrder(req, res);

            assert.equal(statusCode, 200);
            assert.equal(jsonResponse.success, true);
            assert.equal(jsonResponse.order.orderStatus, "Cancelled");
        } finally {
            Order.findById = origFindById;
        }
    });

    test("cancelOrder rejects non-admin user cancelling another user's order with HTTP 403", async () => {
        const origFindById = Order.findById;
        try {
            const mockOrder = {
                _id: "order_owner_check_test",
                user: { toString: () => "owner_user_id" },
                orderStatus: "Pending",
                paymentStatus: "Pending"
            };

            Order.findById = async () => mockOrder;

            const req = {
                params: { id: "order_owner_check_test" },
                user: { id: "stranger_user_id", role: "customer" },
                body: {
                    reason: "Malicious cancellation attempt"
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

            await cancelOrder(req, res);

            assert.equal(statusCode, 403);
            assert.equal(jsonResponse.success, false);
            assert.equal(jsonResponse.message, "Access denied");
        } finally {
            Order.findById = origFindById;
        }
    });
});

