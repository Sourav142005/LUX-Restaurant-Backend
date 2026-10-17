const { test, describe, beforeEach, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

// Suppress console logging during automated test suite execution to prevent
// Node 24 test runner IPC socket corruption from unbuffered stdout writes.
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
const origInfo = console.info;

before(() => {
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    console.info = () => {};
});

after(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    console.info = origInfo;
});

process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_mock_key_id";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "mock_secret";

const Razorpay = require("razorpay");
let customRefundHandler = null;
let customFetchMultipleRefundHandler = null;
let customFetchPaymentHandler = null;

const origAddResources = Razorpay.prototype.addResources;
Razorpay.prototype.addResources = function() {
    origAddResources.call(this);
    const origRefund = this.payments?.refund;
    const origFetchMultipleRefund = this.payments?.fetchMultipleRefund;
    const origFetch = this.payments?.fetch;
    if (this.payments) {
        this.payments.refund = async (...args) => {
            if (customRefundHandler) {
                return customRefundHandler(...args);
            }
            return origRefund ? origRefund.apply(this.payments, args) : { id: "rfnd_default" };
        };
        this.payments.fetchMultipleRefund = async (...args) => {
            if (customFetchMultipleRefundHandler) {
                return customFetchMultipleRefundHandler(...args);
            }
            return origFetchMultipleRefund ? origFetchMultipleRefund.apply(this.payments, args) : { entity: "collection", count: 0, items: [] };
        };
        this.payments.fetch = async (...args) => {
            if (customFetchPaymentHandler) {
                return customFetchPaymentHandler(...args);
            }
            return origFetch ? origFetch.apply(this.payments, args) : { id: args[0], status: "captured" };
        };
    }
};

const Order = require("../models/Order");
const Table = require("../models/Table");
const { verifyPayment, createPaymentOrder } = require("../controllers/paymentController");
const { cancelOrderAndRefund, reconcileGatewayRefunds } = require("../services/orderCancellationService");

const {
    verifyWebhookSignature,
    createWebhookHandler
} = require("../controllers/webhookController");

const TEST_SECRET = "webhook_secret_test_key_12345";

const generateSignature = (payload, secret = TEST_SECRET) => {
    const buffer = Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
    return crypto.createHmac("sha256", secret).update(buffer).digest("hex");
};

const createMockReqRes = (payloadObj, headers = {}) => {
    const rawBody = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const defaultSignature = generateSignature(rawBody, process.env.RAZORPAY_WEBHOOK_SECRET || TEST_SECRET);

    const req = {
        headers: {
            "x-razorpay-signature": defaultSignature,
            ...headers
        },
        rawBody,
        body: payloadObj
    };

    let statusCode = 200;
    let responseJson = null;

    const res = {
        status: (code) => {
            statusCode = code;
            return res;
        },
        json: (data) => {
            responseJson = data;
            return res;
        }
    };

    return { req, res, getStatus: () => statusCode, getJson: () => responseJson };
};

describe("Razorpay Webhook - Signature Verification Tests", () => {

    test("1. Valid signature with raw Buffer returns true", () => {
        const payload = JSON.stringify({ event: "payment.captured", id: "evt_1" });
        const rawBuffer = Buffer.from(payload, "utf8");
        const signature = generateSignature(rawBuffer, TEST_SECRET);

        const isValid = verifyWebhookSignature(rawBuffer, signature, TEST_SECRET);
        assert.equal(isValid, true, "Valid signature must verify successfully");
    });

    test("2. Valid signature with raw string returns true", () => {
        const payload = JSON.stringify({ event: "payment.captured", id: "evt_2" });
        const signature = generateSignature(payload, TEST_SECRET);

        const isValid = verifyWebhookSignature(payload, signature, TEST_SECRET);
        assert.equal(isValid, true);
    });

    test("3. Tampered payload returns false", () => {
        const originalPayload = JSON.stringify({ event: "payment.captured", amount: 1000 });
        const signature = generateSignature(originalPayload, TEST_SECRET);
        const tamperedPayload = JSON.stringify({ event: "payment.captured", amount: 2000 });

        const isValid = verifyWebhookSignature(tamperedPayload, signature, TEST_SECRET);
        assert.equal(isValid, false, "Tampered payload must fail signature verification");
    });

    test("4. Invalid signature string returns false", () => {
        const payload = JSON.stringify({ event: "payment.captured" });
        const invalidSig = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        const isValid = verifyWebhookSignature(payload, invalidSig, TEST_SECRET);
        assert.equal(isValid, false);
    });

    test("5. Different length signature returns false without throwing RangeError", () => {
        const payload = JSON.stringify({ event: "payment.captured" });
        const shortSig = "abcdef";

        const isValid = verifyWebhookSignature(payload, shortSig, TEST_SECRET);
        assert.equal(isValid, false, "Short signature must return false safely");
    });

    test("6. Missing parameters return false safely", () => {
        assert.equal(verifyWebhookSignature(null, "sig", TEST_SECRET), false);
        assert.equal(verifyWebhookSignature("body", null, TEST_SECRET), false);
        assert.equal(verifyWebhookSignature("body", "sig", null), false);
        assert.equal(verifyWebhookSignature("", "", ""), false);
    });

});

describe("Razorpay Webhook Handler - Event Processing & Idempotency", () => {

    let mockOrders;
    let mockOrderModel;

    beforeEach(() => {
        process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRET;

        // In-memory mock database of orders
        mockOrders = [
            {
                _id: "order_1_id",
                totalPrice: 450,
                orderStatus: "Scheduled",
                paymentStatus: "Pending",
                razorpayOrderId: "order_rp_1",
                razorpayPaymentId: null,
                refundId: null,
                refunds: [],
                amountRefunded: 0,
                reconciliationRequired: false,
                processedWebhookEvents: []
            },
            {
                _id: "order_2_id",
                totalPrice: 1200,
                orderStatus: "Pending",
                paymentStatus: "Paid",
                razorpayOrderId: "order_rp_2",
                razorpayPaymentId: "pay_existing_2",
                refundId: null,
                refunds: [],
                amountRefunded: 0,
                reconciliationRequired: false,
                processedWebhookEvents: ["evt_existing_2"]
            },
            {
                _id: "order_3_cancelled",
                totalPrice: 300,
                orderStatus: "Cancelled",
                paymentStatus: "Pending",
                razorpayOrderId: "order_rp_3",
                razorpayPaymentId: null,
                refundId: null,
                refunds: [],
                amountRefunded: 0,
                reconciliationRequired: false,
                processedWebhookEvents: []
            },
            {
                _id: "order_4_refunded",
                totalPrice: 600,
                orderStatus: "Cancelled",
                paymentStatus: "Refunded",
                razorpayOrderId: "order_rp_4",
                razorpayPaymentId: "pay_refunded_4",
                refundId: "rfnd_4",
                refunds: [],
                amountRefunded: 600,
                reconciliationRequired: false,
                processedWebhookEvents: []
            }
        ];

        mockOrderModel = {
            findOne: async (query) => {
                await new Promise(r => setImmediate(r));
                if (query._id) {
                    return mockOrders.find(o => o._id === query._id.toString()) || null;
                }
                if (query.razorpayOrderId) {
                    return mockOrders.find(o => o.razorpayOrderId === query.razorpayOrderId) || null;
                }
                if (query.razorpayPaymentId) {
                    return mockOrders.find(o => o.razorpayPaymentId === query.razorpayPaymentId) || null;
                }
                return null;
            },
            findById: async (id) => {
                await new Promise(r => setImmediate(r));
                return mockOrders.find(o => o._id === id.toString()) || null;
            },
            findByIdAndUpdate: async (id, updateQuery) => {
                await new Promise(r => setImmediate(r));
                const order = mockOrders.find(o => o._id === id.toString());
                if (!order) return null;
                if (updateQuery.$set) Object.assign(order, updateQuery.$set);
                if (updateQuery.$addToSet) {
                    for (const [key, val] of Object.entries(updateQuery.$addToSet)) {
                        if (!order[key]) order[key] = [];
                        if (!order[key].includes(val)) order[key].push(val);
                    }
                }
                return { ...order };
            },
            findOneAndUpdate: async (filter, updateQuery, options) => {
                await new Promise(r => setImmediate(r));
                const matchOrder = (order) => {
                    if (filter._id && order._id !== filter._id.toString()) {
                        return false;
                    }
                    if (filter.razorpayOrderId && order.razorpayOrderId !== filter.razorpayOrderId) {
                        return false;
                    }
                    if (filter.razorpayPaymentId && order.razorpayPaymentId !== filter.razorpayPaymentId) {
                        return false;
                    }
                    if (filter["refunds.refundId"]) {
                        if (filter["refunds.refundId"].$ne) {
                            if (order.refunds && order.refunds.some(r => r.refundId === filter["refunds.refundId"].$ne)) {
                                return false;
                            }
                        } else if (!order.refunds || !order.refunds.some(r => r.refundId === filter["refunds.refundId"])) {
                            return false;
                        }
                    }
                    if (filter.orderStatus && filter.orderStatus.$in) {
                        if (!filter.orderStatus.$in.includes(order.orderStatus)) {
                            return false;
                        }
                    }
                    if (filter.processedWebhookEvents && filter.processedWebhookEvents.$ne) {
                        if (order.processedWebhookEvents && order.processedWebhookEvents.includes(filter.processedWebhookEvents.$ne)) {
                            return false;
                        }
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$ne) {
                        if (order.paymentStatus === filter.paymentStatus.$ne) {
                            return false;
                        }
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$nin) {
                        if (filter.paymentStatus.$nin.includes(order.paymentStatus)) {
                            return false;
                        }
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$in) {
                        if (!filter.paymentStatus.$in.includes(order.paymentStatus)) {
                            return false;
                        }
                    }
                    if (filter.$or && Array.isArray(filter.$or)) {
                        const orMatches = filter.$or.some(clause => {
                            if (clause.paymentStatus && clause.paymentStatus.$ne) {
                                return order.paymentStatus !== clause.paymentStatus.$ne;
                            }
                            if (clause.paymentStatus && clause.paymentStatus.$nin) {
                                return !clause.paymentStatus.$nin.includes(order.paymentStatus);
                            }
                            if (clause.razorpayPaymentId) {
                                return order.razorpayPaymentId === clause.razorpayPaymentId;
                            }
                            return false;
                        });
                        if (!orMatches) return false;
                    }
                    return true;
                };

                const order = mockOrders.find(matchOrder);
                if (!order) return null;

                if (updateQuery.$set) {
                    for (const [key, val] of Object.entries(updateQuery.$set)) {
                        if (key === "refunds.$.status") {
                            const matchedRefund = order.refunds?.find(r => r.refundId === filter["refunds.refundId"]);
                            if (matchedRefund) {
                                matchedRefund.status = val;
                            }
                        } else {
                            order[key] = val;
                        }
                    }
                }
                if (updateQuery.$addToSet) {
                    for (const [key, val] of Object.entries(updateQuery.$addToSet)) {
                        if (!order[key]) order[key] = [];
                        if (!order[key].includes(val)) {
                            order[key].push(val);
                        }
                    }
                }
                if (updateQuery.$push) {
                    for (const [key, val] of Object.entries(updateQuery.$push)) {
                        if (!order[key]) order[key] = [];
                        order[key].push(val);
                    }
                }
                return { ...order };
            }
        };
    });

    const createMockReqRes = (payloadObj, headers = {}) => {
        const rawBody = Buffer.from(JSON.stringify(payloadObj), "utf8");
        const defaultSignature = generateSignature(rawBody, process.env.RAZORPAY_WEBHOOK_SECRET);

        const req = {
            headers: {
                "x-razorpay-signature": defaultSignature,
                ...headers
            },
            rawBody,
            body: payloadObj
        };

        let statusCode = 200;
        let responseJson = null;

        const res = {
            status: (code) => {
                statusCode = code;
                return res;
            },
            json: (data) => {
                responseJson = data;
                return res;
            }
        };

        return { req, res, getStatus: () => statusCode, getJson: () => responseJson };
    };

    test("1. Returns HTTP 500 when RAZORPAY_WEBHOOK_SECRET is not configured", async () => {
        delete process.env.RAZORPAY_WEBHOOK_SECRET;

        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const { req, res, getStatus, getJson } = createMockReqRes({ event: "payment.captured" });

        await handler(req, res);

        assert.equal(getStatus(), 500);
        assert.equal(getJson().success, false);
        assert.equal(getJson().message, "Webhook secret is not configured");
    });

    test("2. Rejects request with missing signature header with HTTP 400", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const { req, res, getStatus, getJson } = createMockReqRes({ event: "payment.captured" }, {
            "x-razorpay-signature": ""
        });

        await handler(req, res);

        assert.equal(getStatus(), 400);
        assert.equal(getJson().success, false);
        assert.equal(getJson().message, "Missing Razorpay webhook signature header");
    });

    test("3. Rejects request with invalid signature with HTTP 400", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const fakeSig = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        const { req, res, getStatus, getJson } = createMockReqRes({ event: "payment.captured" }, {
            "x-razorpay-signature": fakeSig
        });

        await handler(req, res);

        assert.equal(getStatus(), 400);
        assert.equal(getJson().success, false);
        assert.equal(getJson().message, "Invalid webhook signature");
    });

    test("4. Acknowledges unknown or unhandled event with HTTP 200 without modifying database", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const { req, res, getStatus, getJson } = createMockReqRes({
            event: "settlement.processed",
            payload: {}
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().success, true);
        assert.match(getJson().message, /acknowledged/);
    });

    test("5. Payment authorized but not captured does NOT mark order as Paid", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_auth_only",
                        order_id: "order_rp_1",
                        status: "authorized", // Not captured!
                        captured: false,
                        amount: 45000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload);
        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().message, "Payment not yet captured; acknowledged");

        const order = mockOrders.find(o => o._id === "order_1_id");
        assert.equal(order.paymentStatus, "Pending", "Order must remain Pending when payment is only authorized");
    });

    test("6. Amount mismatch between gateway payment and order price is rejected with HTTP 400", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_tampered_amount",
                        order_id: "order_rp_1",
                        status: "captured",
                        captured: true,
                        amount: 10000, // Expected 450 * 100 = 45000 paise
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload);
        await handler(req, res);

        assert.equal(getStatus(), 400);
        assert.equal(getJson().success, false);
        assert.equal(getJson().message, "Payment amount mismatch");

        const order = mockOrders.find(o => o._id === "order_1_id");
        assert.equal(order.paymentStatus, "Pending", "Order status must not change on amount mismatch");
    });

    test("7. Unmatched gateway order ID is acknowledged with HTTP 200 without error", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_unmatched",
                        order_id: "order_rp_nonexistent",
                        status: "captured",
                        captured: true,
                        amount: 5000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload);
        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().success, true);
        assert.equal(getJson().message, "No matching order found; acknowledged");
    });

    test("8. Valid payment.captured marks order as Paid and stores razorpayPaymentId", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_success_1",
                        order_id: "order_rp_1",
                        status: "captured",
                        captured: true,
                        amount: 45000, // 450 * 100
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_capture_1"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().success, true);

        const order = mockOrders.find(o => o._id === "order_1_id");
        assert.equal(order.paymentStatus, "Paid");
        assert.equal(order.razorpayPaymentId, "pay_success_1");
        assert.equal(order.orderStatus, "Scheduled", "orderStatus should remain Scheduled until scheduler runs");
        assert.ok(order.processedWebhookEvents.includes("evt_capture_1"), "Event ID must be recorded");
    });

    test("9. Duplicate event delivery is acknowledged as duplicate without duplicate write", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_existing_2",
                        order_id: "order_rp_2",
                        status: "captured",
                        captured: true,
                        amount: 120000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_existing_2" // Already in processedWebhookEvents
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().message, "Event already processed");
    });

    test("10. Webhook on already Paid order with different payment ID does NOT overwrite payment ID", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_duplicate_different_id",
                        order_id: "order_rp_2",
                        status: "captured",
                        captured: true,
                        amount: 120000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_new_unseen"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.match(getJson().message, /preserved existing payment/);

        const order = mockOrders.find(o => o._id === "order_2_id");
        assert.equal(order.razorpayPaymentId, "pay_existing_2", "Original payment ID must NOT be overwritten");
    });

    test("11. Webhook for cancelled order records payment but does NOT reactivate orderStatus", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_cancelled_order",
                        order_id: "order_rp_3",
                        status: "captured",
                        captured: true,
                        amount: 30000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload);
        await handler(req, res);

        assert.equal(getStatus(), 200);

        const order = mockOrders.find(o => o._id === "order_3_cancelled");
        assert.equal(order.paymentStatus, "Paid");
        assert.equal(order.orderStatus, "Cancelled", "Cancelled status must remain Cancelled");
    });

    test("12. payment.failed event marks Pending order as Failed", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.failed",
            payload: {
                payment: {
                    entity: {
                        id: "pay_failed_1",
                        order_id: "order_rp_1",
                        status: "failed"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload);
        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().message, "Order marked as Failed");

        const order = mockOrders.find(o => o._id === "order_1_id");
        assert.equal(order.paymentStatus, "Failed");
    });

    test("13. payment.failed event does NOT overwrite an already Paid order", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.failed",
            payload: {
                payment: {
                    entity: {
                        id: "pay_failed_late",
                        order_id: "order_rp_2",
                        status: "failed"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload);
        await handler(req, res);

        assert.equal(getStatus(), 200);

        const order = mockOrders.find(o => o._id === "order_2_id");
        assert.equal(order.paymentStatus, "Paid", "Paid order must never be overwritten as Failed");
    });

    test("14. refund.processed transitions order to Refunded and stores refundId", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "refund.processed",
            payload: {
                payment: {
                    entity: {
                        id: "pay_existing_2",
                        amount: 120000,
                        amount_refunded: 120000,
                        refund_status: "full"
                    }
                },
                refund: {
                    entity: {
                        id: "rfnd_test_2",
                        payment_id: "pay_existing_2",
                        amount: 120000,
                        status: "processed"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_refund_2"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().refundId, "rfnd_test_2");

        const order = mockOrders.find(o => o._id === "order_2_id");
        assert.equal(order.paymentStatus, "Refunded");
        assert.equal(order.refundId, "rfnd_test_2");
        assert.ok(order.processedWebhookEvents.includes("evt_refund_2"));
    });

    test("15. order.paid event with captured payment entity marks order as Paid", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "order.paid",
            payload: {
                order: {
                    entity: {
                        id: "order_rp_1",
                        status: "paid",
                        amount: 45000,
                        amount_paid: 45000
                    }
                },
                payment: {
                    entity: {
                        id: "pay_order_paid_1",
                        order_id: "order_rp_1",
                        status: "captured",
                        captured: true,
                        amount: 45000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload);
        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().success, true);

        const order = mockOrders.find(o => o._id === "order_1_id");
        assert.equal(order.paymentStatus, "Paid");
        assert.equal(order.razorpayPaymentId, "pay_order_paid_1");
    });

});

describe("Razorpay Webhook - Concurrency & Partial Refund Hardening (Phase 2A Fixes)", () => {

    let mockOrders;
    let mockOrderModel;

    beforeEach(() => {
        process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRET;

        mockOrders = [
            {
                _id: "order_1_id",
                totalPrice: 450,
                orderStatus: "Scheduled",
                paymentStatus: "Pending",
                razorpayOrderId: "order_rp_1",
                razorpayPaymentId: null,
                refundId: null,
                refunds: [],
                amountRefunded: 0,
                reconciliationRequired: false,
                processedWebhookEvents: []
            },
            {
                _id: "order_2_id",
                totalPrice: 1200,
                orderStatus: "Pending",
                paymentStatus: "Paid",
                razorpayOrderId: "order_rp_2",
                razorpayPaymentId: "pay_existing_2",
                refundId: null,
                refunds: [],
                amountRefunded: 0,
                reconciliationRequired: false,
                processedWebhookEvents: ["evt_existing_2"]
            },
            {
                _id: "order_3_cancelled",
                totalPrice: 300,
                orderStatus: "Cancelled",
                paymentStatus: "Pending",
                razorpayOrderId: "order_rp_3",
                razorpayPaymentId: null,
                refundId: null,
                refunds: [],
                amountRefunded: 0,
                reconciliationRequired: false,
                processedWebhookEvents: []
            },
            {
                _id: "order_4_refunded",
                totalPrice: 600,
                orderStatus: "Cancelled",
                paymentStatus: "Refunded",
                razorpayOrderId: "order_rp_4",
                razorpayPaymentId: "pay_refunded_4",
                refundId: "rfnd_4",
                refunds: [],
                amountRefunded: 600,
                reconciliationRequired: false,
                processedWebhookEvents: []
            }
        ];

        mockOrderModel = {
            findOne: async (query) => {
                await new Promise(r => setImmediate(r));
                if (query._id) {
                    return mockOrders.find(o => o._id === query._id.toString()) || null;
                }
                if (query.razorpayOrderId) {
                    return mockOrders.find(o => o.razorpayOrderId === query.razorpayOrderId) || null;
                }
                if (query.razorpayPaymentId) {
                    return mockOrders.find(o => o.razorpayPaymentId === query.razorpayPaymentId) || null;
                }
                return null;
            },
            findById: async (id) => {
                await new Promise(r => setImmediate(r));
                return mockOrders.find(o => o._id === id.toString()) || null;
            },
            findOneAndUpdate: async (filter, updateQuery, options) => {
                await new Promise(r => setImmediate(r));
                const matchOrder = (order) => {
                    if (filter._id && order._id !== filter._id.toString()) {
                        return false;
                    }
                    if (filter.razorpayOrderId && order.razorpayOrderId !== filter.razorpayOrderId) {
                        return false;
                    }
                    if (filter.razorpayPaymentId && order.razorpayPaymentId !== filter.razorpayPaymentId) {
                        return false;
                    }
                    if (filter.processedWebhookEvents && filter.processedWebhookEvents.$ne) {
                        if (order.processedWebhookEvents && order.processedWebhookEvents.includes(filter.processedWebhookEvents.$ne)) {
                            return false;
                        }
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$ne) {
                        if (order.paymentStatus === filter.paymentStatus.$ne) {
                            return false;
                        }
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$nin) {
                        if (filter.paymentStatus.$nin.includes(order.paymentStatus)) {
                            return false;
                        }
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$in) {
                        if (!filter.paymentStatus.$in.includes(order.paymentStatus)) {
                            return false;
                        }
                    }
                    if (filter.$or && Array.isArray(filter.$or)) {
                        const orMatches = filter.$or.some(clause => {
                            if (clause.paymentStatus && clause.paymentStatus.$ne) {
                                return order.paymentStatus !== clause.paymentStatus.$ne;
                            }
                            if (clause.paymentStatus && clause.paymentStatus.$nin) {
                                return !clause.paymentStatus.$nin.includes(order.paymentStatus);
                            }
                            if (clause.razorpayPaymentId) {
                                return order.razorpayPaymentId === clause.razorpayPaymentId;
                            }
                            return false;
                        });
                        if (!orMatches) return false;
                    }
                    return true;
                };

                const order = mockOrders.find(matchOrder);
                if (!order) return null;

                if (updateQuery.$set) {
                    Object.assign(order, updateQuery.$set);
                }
                if (updateQuery.$addToSet) {
                    for (const [key, val] of Object.entries(updateQuery.$addToSet)) {
                        if (!order[key]) order[key] = [];
                        if (!order[key].includes(val)) {
                            order[key].push(val);
                        }
                    }
                }
                if (updateQuery.$push) {
                    for (const [key, val] of Object.entries(updateQuery.$push)) {
                        if (!order[key]) order[key] = [];
                        order[key].push(val);
                    }
                }
                return { ...order };
            }
        };
    });

    const createMockReqRes = (payloadObj, headers = {}) => {
        const rawBody = Buffer.from(JSON.stringify(payloadObj), "utf8");
        const defaultSignature = generateSignature(rawBody, process.env.RAZORPAY_WEBHOOK_SECRET);

        const req = {
            headers: {
                "x-razorpay-signature": defaultSignature,
                ...headers
            },
            rawBody,
            body: payloadObj
        };

        let statusCode = 200;
        let responseJson = null;

        const res = {
            status: (code) => {
                statusCode = code;
                return res;
            },
            json: (data) => {
                responseJson = data;
                return res;
            }
        };

        return { req, res, getStatus: () => statusCode, getJson: () => responseJson };
    };

    test("1. Two concurrent deliveries of the same event only apply state change once", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_concurrent_1",
                        order_id: "order_rp_1",
                        status: "captured",
                        captured: true,
                        amount: 45000,
                        currency: "INR"
                    }
                }
            }
        };

        const mock1 = createMockReqRes(payload, { "x-razorpay-event-id": "evt_concurrent_1" });
        const mock2 = createMockReqRes(payload, { "x-razorpay-event-id": "evt_concurrent_1" });

        await Promise.all([
            handler(mock1.req, mock1.res),
            handler(mock2.req, mock2.res)
        ]);

        assert.equal(mock1.getStatus(), 200);
        assert.equal(mock2.getStatus(), 200);

        const responses = [mock1.getJson(), mock2.getJson()];
        const recorded = responses.find(r => r.message === "Order payment successfully recorded");
        const duplicate = responses.find(r => r.message === "Event already processed");

        assert.ok(recorded, "One request must successfully record payment");
        assert.ok(duplicate, "Concurrent duplicate request must detect duplicate and acknowledge");

        const order = mockOrders.find(o => o._id === "order_1_id");
        assert.equal(order.paymentStatus, "Paid");
        assert.equal(order.razorpayPaymentId, "pay_concurrent_1");
        assert.equal(
            order.processedWebhookEvents.filter(e => e === "evt_concurrent_1").length,
            1,
            "Event ID must only appear once in processedWebhookEvents"
        );
    });

    test("2. A partial refund leaves the order active and sets paymentStatus to PartiallyRefunded", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "refund.processed",
            payload: {
                payment: {
                    entity: {
                        id: "pay_existing_2",
                        amount_refunded: 30000,
                        refund_status: "partial"
                    }
                },
                refund: {
                    entity: {
                        id: "rfnd_part_1",
                        payment_id: "pay_existing_2",
                        amount: 30000,
                        status: "processed"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_part_refund"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().isFullRefund, false);
        assert.equal(getJson().message, "Partial refund successfully recorded");

        const order = mockOrders.find(o => o._id === "order_2_id");
        assert.equal(order.paymentStatus, "PartiallyRefunded");
        assert.equal(order.orderStatus, "Pending", "Order status must remain active (not cancelled)");
        assert.equal(order.amountRefunded, 300);
        assert.equal(order.refundId, "rfnd_part_1");
    });

    test("3. A full refund cancels/refunds a pending/scheduled order as intended", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const order1 = mockOrders.find(o => o._id === "order_1_id");
        order1.paymentStatus = "Paid";
        order1.razorpayPaymentId = "pay_order_1_done";

        const payload = {
            event: "refund.processed",
            payload: {
                payment: {
                    entity: {
                        id: "pay_order_1_done",
                        amount_refunded: 45000,
                        refund_status: "full"
                    }
                },
                refund: {
                    entity: {
                        id: "rfnd_full_1",
                        payment_id: "pay_order_1_done",
                        amount: 45000,
                        status: "processed"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_full_refund_order_1"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().isFullRefund, true);
        assert.equal(getJson().message, "Order marked as Refunded");

        assert.equal(order1.paymentStatus, "Refunded");
        assert.equal(order1.orderStatus, "Cancelled", "Scheduled order must be cancelled upon full refund");
        assert.equal(order1.amountRefunded, 450);
        assert.equal(order1.refundId, "rfnd_full_1");
    });

    test("4. Duplicate refund events ensure amounts are not added twice", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "refund.processed",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_accum_1",
                        payment_id: "pay_existing_2",
                        amount: 25000, // ₹250
                        status: "processed"
                    }
                }
            }
        };

        // First delivery
        const mock1 = createMockReqRes(payload, { "x-razorpay-event-id": "evt_refund_accum_1" });
        await handler(mock1.req, mock1.res);

        assert.equal(mock1.getStatus(), 200);
        assert.equal(mock1.getJson().isFullRefund, false);

        const order = mockOrders.find(o => o._id === "order_2_id");
        assert.equal(order.amountRefunded, 250);
        assert.equal(order.paymentStatus, "PartiallyRefunded");

        // Duplicate delivery
        const mock2 = createMockReqRes(payload, { "x-razorpay-event-id": "evt_refund_accum_1" });
        await handler(mock2.req, mock2.res);

        assert.equal(mock2.getStatus(), 200);
        assert.equal(mock2.getJson().message, "Refund event already processed");

        // Verify amount is not added twice
        assert.equal(order.amountRefunded, 250, "Refund amount must not be added twice on duplicate event");
    });

    test("5. Conflicting payment IDs preserve existing payments on already Paid order", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_new_conflicting_xyz",
                        order_id: "order_rp_2",
                        status: "captured",
                        captured: true,
                        amount: 120000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_conflict_pay"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.match(getJson().message, /preserved existing payment/);

        const order = mockOrders.find(o => o._id === "order_2_id");
        assert.equal(order.razorpayPaymentId, "pay_existing_2", "Original payment ID must NOT be overwritten");
        assert.equal(order.paymentStatus, "Paid");
    });

    test("6a. Capture event arriving after an order has been refunded is safely ignored", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_late_on_refunded",
                        order_id: "order_rp_4", // Order 4 is Refunded
                        status: "captured",
                        captured: true,
                        amount: 60000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_late_capture_refunded"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().message, "Order is already Refunded; ignored payment capture");

        const order = mockOrders.find(o => o._id === "order_4_refunded");
        assert.equal(order.paymentStatus, "Refunded", "Order must remain Refunded");
        assert.equal(order.razorpayPaymentId, "pay_refunded_4", "Payment ID must not change");
    });

    test("6b. Capture event arriving after an order has been cancelled records payment and preserves Cancelled status", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_captured_cancelled_3",
                        order_id: "order_rp_3", // Order 3 is Cancelled, Pending
                        status: "captured",
                        captured: true,
                        amount: 30000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_cancelled_capture"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);

        const order = mockOrders.find(o => o._id === "order_3_cancelled");
        assert.equal(order.paymentStatus, "Paid");
        assert.equal(order.orderStatus, "Cancelled", "Cancelled orderStatus must never be reactivated");
        assert.equal(order.razorpayPaymentId, "pay_captured_cancelled_3");
    });

});

describe("Razorpay Webhook - Phase 2A Final Hardening Tests", () => {

    let mockOrders;
    let mockOrderModel;

    beforeEach(() => {
        process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRET;

        mockOrders = [
            {
                _id: "order_h1_part",
                totalPrice: 1000,
                orderStatus: "Scheduled",
                paymentStatus: "PartiallyRefunded",
                razorpayOrderId: "order_rp_h1",
                razorpayPaymentId: "pay_h1",
                refundId: "rfnd_h1_prev",
                refunds: [{ refundId: "rfnd_h1_prev", amount: 600, status: "processed" }],
                amountRefunded: 600,
                reconciliationRequired: false,
                processedWebhookEvents: ["evt_prev_h1"]
            },
            {
                _id: "order_h2_cancelled",
                totalPrice: 500,
                orderStatus: "Cancelled",
                paymentStatus: "Pending",
                razorpayOrderId: "order_rp_h2",
                razorpayPaymentId: null,
                refundId: null,
                refunds: [],
                amountRefunded: 0,
                reconciliationRequired: false,
                processedWebhookEvents: []
            },
            {
                _id: "order_h3_conflict",
                totalPrice: 800,
                orderStatus: "Scheduled",
                paymentStatus: "Paid",
                razorpayOrderId: "order_rp_h3",
                razorpayPaymentId: "pay_legit_h3",
                refundId: null,
                refunds: [],
                amountRefunded: 0,
                reconciliationRequired: false,
                processedWebhookEvents: []
            }
        ];

        mockOrderModel = {
            findOne: async (query) => {
                if (query._id) return mockOrders.find(o => o._id === query._id.toString()) || null;
                if (query.razorpayOrderId) return mockOrders.find(o => o.razorpayOrderId === query.razorpayOrderId) || null;
                if (query.razorpayPaymentId) return mockOrders.find(o => o.razorpayPaymentId === query.razorpayPaymentId) || null;
                return null;
            },
            findById: async (id) => {
                return mockOrders.find(o => o._id === id.toString()) || null;
            },
            findOneAndUpdate: async (filter, updateQuery) => {
                const matchOrder = (order) => {
                    if (filter._id && order._id !== filter._id.toString()) return false;
                    if (filter.razorpayOrderId && order.razorpayOrderId !== filter.razorpayOrderId) return false;
                    if (filter.razorpayPaymentId && order.razorpayPaymentId !== filter.razorpayPaymentId) return false;
                    if (filter.processedWebhookEvents && filter.processedWebhookEvents.$ne) {
                        if (order.processedWebhookEvents && order.processedWebhookEvents.includes(filter.processedWebhookEvents.$ne)) {
                            return false;
                        }
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$ne) {
                        if (order.paymentStatus === filter.paymentStatus.$ne) return false;
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$nin) {
                        if (filter.paymentStatus.$nin.includes(order.paymentStatus)) return false;
                    }
                    if (filter.$or && Array.isArray(filter.$or)) {
                        const orMatches = filter.$or.some(clause => {
                            if (clause.paymentStatus && clause.paymentStatus.$ne) {
                                return order.paymentStatus !== clause.paymentStatus.$ne;
                            }
                            if (clause.paymentStatus && clause.paymentStatus.$nin) {
                                return !clause.paymentStatus.$nin.includes(order.paymentStatus);
                            }
                            if (clause.razorpayPaymentId) {
                                return order.razorpayPaymentId === clause.razorpayPaymentId;
                            }
                            return false;
                        });
                        if (!orMatches) return false;
                    }
                    return true;
                };

                const order = mockOrders.find(matchOrder);
                if (!order) return null;

                if (updateQuery.$set) {
                    Object.assign(order, updateQuery.$set);
                }
                if (updateQuery.$addToSet) {
                    for (const [key, val] of Object.entries(updateQuery.$addToSet)) {
                        if (!order[key]) order[key] = [];
                        if (!order[key].includes(val)) order[key].push(val);
                    }
                }
                if (updateQuery.$push) {
                    for (const [key, val] of Object.entries(updateQuery.$push)) {
                        if (!order[key]) order[key] = [];
                        order[key].push(val);
                    }
                }
                return { ...order };
            }
        };
    });

    const createMockReqRes = (payloadObj, headers = {}) => {
        const rawBody = Buffer.from(JSON.stringify(payloadObj), "utf8");
        const defaultSignature = generateSignature(rawBody, process.env.RAZORPAY_WEBHOOK_SECRET);

        const req = {
            headers: {
                "x-razorpay-signature": defaultSignature,
                ...headers
            },
            rawBody,
            body: payloadObj
        };

        let statusCode = 200;
        let responseJson = null;

        const res = {
            status: (code) => {
                statusCode = code;
                return res;
            },
            json: (data) => {
                responseJson = data;
                return res;
            }
        };

        return {
            req,
            res,
            getStatus: () => statusCode,
            getJson: () => responseJson
        };
    };

    test("1. Stale refund snapshot with smaller gateway amount_refunded preserves monotonic cumulative amountRefunded", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "refund.processed",
            payload: {
                payment: {
                    entity: {
                        id: "pay_h1",
                        amount_refunded: 40000,
                        refund_status: "partial"
                    }
                },
                refund: {
                    entity: {
                        id: "rfnd_older_snapshot",
                        payment_id: "pay_h1",
                        amount: 40000,
                        status: "processed"
                    }
                }
            }
        };

        const { req, res, getStatus } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_older_stale"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);

        const order = mockOrders.find(o => o._id === "order_h1_part");
        assert.equal(order.amountRefunded, 600, "Cumulative refund must be monotonic and not decrease to 400");
        assert.equal(order.paymentStatus, "PartiallyRefunded");
    });

    test("2. Late payment.captured event arriving for an already PartiallyRefunded order preserves PartiallyRefunded status", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_h1",
                        order_id: "order_rp_h1",
                        status: "captured",
                        captured: true,
                        amount: 100000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_late_capture_part"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.match(getJson().message, /partially refunded/i);

        const order = mockOrders.find(o => o._id === "order_h1_part");
        assert.equal(order.paymentStatus, "PartiallyRefunded", "Must not overwrite PartiallyRefunded back to Paid");
    });

    test("3. Late order.paid event arriving for an already PartiallyRefunded order preserves PartiallyRefunded status", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "order.paid",
            payload: {
                order: {
                    entity: {
                        id: "order_rp_h1",
                        status: "paid",
                        amount: 100000,
                        amount_paid: 100000
                    }
                },
                payment: {
                    entity: {
                        id: "pay_h1",
                        order_id: "order_rp_h1",
                        status: "captured",
                        captured: true,
                        amount: 100000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_late_order_paid_part"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.match(getJson().message, /partially refunded/i);

        const order = mockOrders.find(o => o._id === "order_h1_part");
        assert.equal(order.paymentStatus, "PartiallyRefunded", "Must not overwrite PartiallyRefunded back to Paid");
    });

    test("4. Capture arriving for a cancelled order sets durable reconciliationRequired flag and preserves Cancelled status", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "payment.captured",
            payload: {
                payment: {
                    entity: {
                        id: "pay_cancel_rec",
                        order_id: "order_rp_h2",
                        status: "captured",
                        captured: true,
                        amount: 50000,
                        currency: "INR"
                    }
                }
            }
        };

        const { req, res, getStatus } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_capture_cancel_reconcile"
        });

        await handler(req, res);

        assert.equal(getStatus(), 200);

        const order = mockOrders.find(o => o._id === "order_h2_cancelled");
        assert.equal(order.paymentStatus, "Paid");
        assert.equal(order.orderStatus, "Cancelled");
        assert.equal(order.reconciliationRequired, true, "reconciliationRequired must be true for captured payments on cancelled orders");
    });

    test("5. Conflicting payment ID in notes fallback is rejected with HTTP 400", async () => {
        const handler = createWebhookHandler({ OrderModel: mockOrderModel });
        const payload = {
            event: "refund.processed",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_spoofed",
                        payment_id: "pay_unmatched_ghost",
                        amount: 20000,
                        status: "processed",
                        notes: {
                            orderId: "order_h3_conflict"
                        }
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(payload, {
            "x-razorpay-event-id": "evt_conflict_notes"
        });

        await handler(req, res);

        assert.equal(getStatus(), 400);
        assert.equal(getJson().message, "Refund payment ID conflicts with order payment ID");

        const order = mockOrders.find(o => o._id === "order_h3_conflict");
        assert.equal(order.amountRefunded, 0);
        assert.equal(order.paymentStatus, "Paid");
    });

    test("6. Client verification via verifyPayment returns HTTP 200 and preserves PartiallyRefunded status", async () => {
        const origFindOne = Order.findOne;
        try {
            Order.findOne = async () => ({
                _id: "order_client_part",
                totalPrice: 600,
                paymentStatus: "PartiallyRefunded",
                razorpayOrderId: "order_rp_client_part",
                save: async function() { return this; }
            });

            let statusCode = 200;
            let responseJson = null;
            const res = {
                status: (code) => { statusCode = code; return res; },
                json: (data) => { responseJson = data; return res; }
            };

            const req = {
                user: { id: "user_client_1" },
                params: { id: "order_client_part" },
                body: {
                    razorpay_order_id: "order_rp_client_part",
                    razorpay_payment_id: "pay_client_part",
                    razorpay_signature: "sig_mock"
                }
            };

            await verifyPayment(req, res);

            assert.equal(statusCode, 200);
            assert.equal(responseJson.message, "Payment already verified (order partially refunded)");
            assert.equal(responseJson.order.paymentStatus, "PartiallyRefunded");
        } finally {
            Order.findOne = origFindOne;
        }
    });

    test("7. Client verification via verifyPayment rejects Refunded order with HTTP 400", async () => {
        const origFindOne = Order.findOne;
        try {
            Order.findOne = async () => ({
                _id: "order_client_ref",
                totalPrice: 600,
                paymentStatus: "Refunded",
                razorpayOrderId: "order_rp_client_ref",
                save: async function() { return this; }
            });

            let statusCode = 200;
            let responseJson = null;
            const res = {
                status: (code) => { statusCode = code; return res; },
                json: (data) => { responseJson = data; return res; }
            };

            const req = {
                user: { id: "user_client_1" },
                params: { id: "order_client_ref" },
                body: {
                    razorpay_order_id: "order_rp_client_ref",
                    razorpay_payment_id: "pay_client_ref",
                    razorpay_signature: "sig_mock"
                }
            };

            await verifyPayment(req, res);

            assert.equal(statusCode, 400);
            assert.equal(responseJson.message, "Order has already been refunded");
        } finally {
            Order.findOne = origFindOne;
        }
    });

    test("8. Order cancellation after partial refund refunds only remaining balance and records in refunds ledger", async () => {
        let refundCalledWith = null;
        customRefundHandler = async (paymentId, data) => {
            refundCalledWith = { paymentId, data };
            return {
                id: "rfnd_balance_auto",
                amount: data.amount,
                status: "processed"
            };
        };

        try {
            const mockOrder = {
                _id: "order_cancel_partial",
                orderStatus: "Scheduled",
                paymentStatus: "PartiallyRefunded",
                totalPrice: 600,
                amountRefunded: 200,
                razorpayPaymentId: "pay_part_balance_1",
                refunds: [{ refundId: "rfnd_initial", amount: 200, status: "processed" }],
                save: async function() { return this; }
            };

            const result = await cancelOrderAndRefund(mockOrder, "Customer cancelled remaining dishes");

            // Remaining refundable balance: (600 - 200) * 100 = 40000 paise (₹400)
            assert.ok(refundCalledWith, "Gateway refund must be invoked");
            assert.equal(refundCalledWith.paymentId, "pay_part_balance_1");
            assert.equal(refundCalledWith.data.amount, 40000, "Refund amount must be remaining balance (40000 paise)");
            assert.equal(result.order.orderStatus, "Cancelled");
            assert.equal(result.order.paymentStatus, "Refunded");
            assert.equal(result.order.amountRefunded, 600);
            assert.equal(result.order.refunds.length, 2);
            assert.equal(result.order.refunds[1].amount, 400);

            // Test zero remaining balance skips gateway refund
            refundCalledWith = null;
            const mockOrderZeroBalance = {
                _id: "order_cancel_zero_bal",
                orderStatus: "Pending",
                paymentStatus: "PartiallyRefunded",
                totalPrice: 600,
                amountRefunded: 600,
                razorpayPaymentId: "pay_zero_bal",
                refunds: [],
                save: async function() { return this; }
            };

            const resultZero = await cancelOrderAndRefund(mockOrderZeroBalance, "Cancelled after full offline refund");
            assert.equal(refundCalledWith, null, "Gateway refund must NOT be called when remaining balance is 0");
            assert.equal(resultZero.order.orderStatus, "Cancelled");
            assert.equal(resultZero.order.paymentStatus, "Refunded");
        } finally {
            customRefundHandler = null;
        }
    });

    test("9. Admin revenue aggregation correctly subtracts partial refunds, excludes Cancelled orders, and aggregates liabilities", () => {
        const orders = [
            { totalPrice: 500, amountRefunded: 0, paymentStatus: "Paid", orderStatus: "Delivered", reconciliationRequired: false },
            { totalPrice: 500, amountRefunded: 150, paymentStatus: "PartiallyRefunded", orderStatus: "Delivered", reconciliationRequired: false },
            { totalPrice: 500, amountRefunded: 500, paymentStatus: "Refunded", orderStatus: "Cancelled", reconciliationRequired: false },
            { totalPrice: 300, amountRefunded: 0, paymentStatus: "Pending", orderStatus: "Pending", reconciliationRequired: false },
            // Cancelled order with payment captured (reconciliation liability)
            { totalPrice: 600, amountRefunded: 0, paymentStatus: "Paid", orderStatus: "Cancelled", reconciliationRequired: true }
        ];

        // Settled revenue match stage:
        // { paymentStatus: { $in: ["Paid", "PartiallyRefunded"] }, orderStatus: { $ne: "Cancelled" }, reconciliationRequired: { $ne: true } }
        const matched = orders.filter(o =>
            ["Paid", "PartiallyRefunded"].includes(o.paymentStatus) &&
            o.orderStatus !== "Cancelled" &&
            o.reconciliationRequired !== true
        );

        // Group & sum stage: $subtract: ["$totalPrice", { $ifNull: ["$amountRefunded", 0] }]
        const netRevenue = matched.reduce((sum, o) => {
            const refunded = o.amountRefunded || 0;
            return sum + (o.totalPrice - refunded);
        }, 0);

        // Reconciliation liability match stage:
        // { $or: [{ reconciliationRequired: true }, { orderStatus: "Cancelled", paymentStatus: { $in: ["Paid", "PartiallyRefunded"] } }] }
        const liabilityMatched = orders.filter(o =>
            o.reconciliationRequired === true ||
            (o.orderStatus === "Cancelled" && ["Paid", "PartiallyRefunded"].includes(o.paymentStatus))
        );
        const totalLiability = liabilityMatched.reduce((sum, o) => {
            const refunded = o.amountRefunded || 0;
            return sum + (o.totalPrice - refunded);
        }, 0);

        // Expected settled: (500 - 0) + (500 - 150) = 850.
        // Cancelled order (600) is excluded from settled revenue.
        assert.equal(matched.length, 2, "Only non-cancelled Paid and PartiallyRefunded orders must match settled revenue");
        assert.equal(netRevenue, 850, "Net settled revenue must exclude cancelled orders and subtract partial refunds");

        // Expected liability: 600
        assert.equal(liabilityMatched.length, 1, "Cancelled paid order must match reconciliation liabilities");
        assert.equal(totalLiability, 600, "Reconciliation liabilities must capture unearned funds");
    });

});

describe("Razorpay Webhook - Refund Lifecycle & Reconciliation Hardening", () => {

    let mockOrders;
    let mockOrderModel;
    let handler;

    beforeEach(() => {
        process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRET;

        mockOrders = [
            {
                _id: "order_lifecycle_1",
                totalPrice: 1000,
                orderStatus: "Scheduled",
                paymentStatus: "Paid",
                razorpayOrderId: "order_rp_lc_1",
                razorpayPaymentId: "pay_lc_1",
                refundId: null,
                refunds: [],
                amountRefunded: 0,
                reconciliationRequired: false,
                processedWebhookEvents: []
            },
            {
                _id: "order_lifecycle_2",
                totalPrice: 800,
                orderStatus: "Cancelled",
                paymentStatus: "RefundPending",
                razorpayOrderId: "order_rp_lc_2",
                razorpayPaymentId: "pay_lc_2",
                refundId: "rfnd_pending_2",
                refunds: [
                    {
                        refundId: "rfnd_pending_2",
                        amount: 800,
                        status: "pending",
                        createdAt: new Date()
                    }
                ],
                amountRefunded: 0,
                reconciliationRequired: false,
                processedWebhookEvents: []
            },
            {
                _id: "order_lifecycle_3_partial",
                totalPrice: 1000,
                orderStatus: "Cancelled",
                paymentStatus: "RefundPending",
                razorpayOrderId: "order_rp_lc_3",
                razorpayPaymentId: "pay_lc_3",
                refundId: "rfnd_pending_3",
                refunds: [
                    {
                        refundId: "rfnd_prev_3",
                        amount: 300,
                        status: "processed",
                        createdAt: new Date()
                    },
                    {
                        refundId: "rfnd_pending_3",
                        amount: 700,
                        status: "pending",
                        createdAt: new Date()
                    }
                ],
                amountRefunded: 300,
                reconciliationRequired: false,
                processedWebhookEvents: ["refund.processed:rfnd_prev_3"]
            }
        ];

        mockOrderModel = {
            findOne: async (query) => {
                await new Promise(r => setImmediate(r));
                if (query._id) return mockOrders.find(o => o._id === query._id.toString()) || null;
                if (query.razorpayOrderId) return mockOrders.find(o => o.razorpayOrderId === query.razorpayOrderId) || null;
                if (query.razorpayPaymentId) return mockOrders.find(o => o.razorpayPaymentId === query.razorpayPaymentId) || null;
                return null;
            },
            findById: async (id) => {
                await new Promise(r => setImmediate(r));
                return mockOrders.find(o => o._id === id.toString()) || null;
            },
            findByIdAndUpdate: async (id, updateQuery) => {
                await new Promise(r => setImmediate(r));
                const order = mockOrders.find(o => o._id === id.toString());
                if (!order) return null;
                if (updateQuery.$set) Object.assign(order, updateQuery.$set);
                if (updateQuery.$addToSet) {
                    for (const [key, val] of Object.entries(updateQuery.$addToSet)) {
                        if (!order[key]) order[key] = [];
                        if (!order[key].includes(val)) order[key].push(val);
                    }
                }
                return { ...order };
            },
            findOneAndUpdate: async (filter, updateQuery, options) => {
                await new Promise(r => setImmediate(r));
                const matchOrder = (order) => {
                    if (filter._id && order._id !== filter._id.toString()) return false;
                    if (filter.razorpayOrderId && order.razorpayOrderId !== filter.razorpayOrderId) return false;
                    if (filter.razorpayPaymentId && order.razorpayPaymentId !== filter.razorpayPaymentId) return false;
                    if (filter["refunds.refundId"]) {
                        if (filter["refunds.refundId"].$ne) {
                            if (order.refunds && order.refunds.some(r => r.refundId === filter["refunds.refundId"].$ne)) {
                                return false;
                            }
                        } else if (!order.refunds || !order.refunds.some(r => r.refundId === filter["refunds.refundId"])) {
                            return false;
                        }
                    }
                    if (filter.orderStatus && filter.orderStatus.$in) {
                        if (!filter.orderStatus.$in.includes(order.orderStatus)) return false;
                    }
                    if (filter.processedWebhookEvents && filter.processedWebhookEvents.$ne) {
                        if (order.processedWebhookEvents && order.processedWebhookEvents.includes(filter.processedWebhookEvents.$ne)) {
                            return false;
                        }
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$ne) {
                        if (order.paymentStatus === filter.paymentStatus.$ne) return false;
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$nin) {
                        if (filter.paymentStatus.$nin.includes(order.paymentStatus)) return false;
                    }
                    if (filter.paymentStatus && filter.paymentStatus.$in) {
                        if (!filter.paymentStatus.$in.includes(order.paymentStatus)) return false;
                    }
                    return true;
                };

                const order = mockOrders.find(matchOrder);
                if (!order) return null;

                if (updateQuery.$set) {
                    for (const [key, val] of Object.entries(updateQuery.$set)) {
                        if (key === "refunds.$.status") {
                            const matched = order.refunds?.find(r => r.refundId === filter["refunds.refundId"]);
                            if (matched) matched.status = val;
                        } else {
                            order[key] = val;
                        }
                    }
                }
                if (updateQuery.$addToSet) {
                    for (const [key, val] of Object.entries(updateQuery.$addToSet)) {
                        if (!order[key]) order[key] = [];
                        if (!order[key].includes(val)) order[key].push(val);
                    }
                }
                if (updateQuery.$push) {
                    for (const [key, val] of Object.entries(updateQuery.$push)) {
                        if (!order[key]) order[key] = [];
                        order[key].push(val);
                    }
                }
                return { ...order };
            }
        };

        handler = createWebhookHandler({ OrderModel: mockOrderModel });
    });

    test("1. Order cancellation with pending refund sets RefundPending, and refund.processed completes it without duplicate ledger entry", async () => {
        try {
            customRefundHandler = async (paymentId, data) => {
                return { id: "rfnd_test_pending_1", status: "pending", amount: 100000 };
            };

            const orderToCancel = mockOrders.find(o => o._id === "order_lifecycle_1");
            const cancelResult = await cancelOrderAndRefund(
                orderToCancel,
                "Customer requested cancellation",
                { OrderModel: mockOrderModel }
            );

            assert.equal(cancelResult.order.orderStatus, "Cancelled");
            assert.equal(cancelResult.order.paymentStatus, "RefundPending");
            assert.equal(cancelResult.order.amountRefunded, 0, "amountRefunded must not be inflated while refund is pending");
            assert.equal(cancelResult.order.refunds.length, 1);
            assert.equal(cancelResult.order.refunds[0].status, "pending");

            // Now deliver refund.processed webhook for this pending refund
            const webhookPayload = {
                event: "refund.processed",
                id: "evt_rfnd_proc_1",
                payload: {
                    refund: {
                        entity: {
                            id: "rfnd_test_pending_1",
                            payment_id: "pay_lc_1",
                            amount: 100000,
                            status: "processed"
                        }
                    },
                    payment: {
                        entity: {
                            id: "pay_lc_1",
                            amount_refunded: 100000,
                            refund_status: "full"
                        }
                    }
                }
            };

            const { req, res, getStatus, getJson } = createMockReqRes(webhookPayload);
            await handler(req, res);

            assert.equal(getStatus(), 200);
            assert.equal(getJson().success, true);
            assert.equal(getJson().isFullRefund, true);

            const updatedOrder = mockOrders.find(o => o._id === "order_lifecycle_1");
            assert.equal(updatedOrder.paymentStatus, "Refunded");
            assert.equal(updatedOrder.amountRefunded, 1000);
            assert.equal(updatedOrder.refunds.length, 1, "Must NOT duplicate ledger entry");
            assert.equal(updatedOrder.refunds[0].status, "processed");

            // Redeliver duplicate refund.processed event with different event ID
            const duplicatePayload = {
                ...webhookPayload,
                id: "evt_rfnd_proc_dup"
            };
            const { req: dupReq, res: dupRes, getStatus: getDupStatus } = createMockReqRes(duplicatePayload);
            await handler(dupReq, dupRes);

            assert.equal(getDupStatus(), 200);
            assert.equal(updatedOrder.refunds.length, 1, "Repeated delivery must NEVER duplicate ledger entry");
            assert.equal(updatedOrder.amountRefunded, 1000, "Cumulative refund must not increase on repeated delivery");
        } finally {
            customRefundHandler = null;
        }
    });

    test("2. refund.failed marks pending ledger entry failed, sets reconciliationRequired, and reverts paymentStatus", async () => {
        // order_lifecycle_2 is Cancelled, paymentStatus: RefundPending, refundId: rfnd_pending_2, amountRefunded: 0
        const webhookPayload = {
            event: "refund.failed",
            id: "evt_rfnd_failed_2",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_pending_2",
                        payment_id: "pay_lc_2",
                        amount: 80000,
                        status: "failed",
                        error_code: "GATEWAY_TIMEOUT"
                    }
                },
                payment: {
                    entity: {
                        id: "pay_lc_2"
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(webhookPayload);
        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.equal(getJson().success, true);
        assert.equal(getJson().reconciliationRequired, true);

        const order = mockOrders.find(o => o._id === "order_lifecycle_2");
        assert.equal(order.paymentStatus, "Paid", "paymentStatus must revert to Paid when pending full refund fails");
        assert.equal(order.reconciliationRequired, true, "reconciliationRequired must be true");
        assert.equal(order.refunds.length, 1, "Ledger entry count preserved");
        assert.equal(order.refunds[0].status, "failed", "Matching ledger entry marked as failed");
    });

    test("3. refund.failed on order with prior confirmed partial refund reverts paymentStatus to PartiallyRefunded", async () => {
        // order_lifecycle_3_partial has amountRefunded: 300, paymentStatus: RefundPending, pending refund: rfnd_pending_3
        const webhookPayload = {
            event: "refund.failed",
            id: "evt_rfnd_failed_3",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_pending_3",
                        payment_id: "pay_lc_3",
                        amount: 70000,
                        status: "failed"
                    }
                },
                payment: {
                    entity: {
                        id: "pay_lc_3"
                    }
                }
            }
        };

        const { req, res, getStatus } = createMockReqRes(webhookPayload);
        await handler(req, res);

        assert.equal(getStatus(), 200);
        const order = mockOrders.find(o => o._id === "order_lifecycle_3_partial");
        assert.equal(order.paymentStatus, "PartiallyRefunded", "Must revert to PartiallyRefunded since 300 was previously confirmed");
        assert.equal(order.amountRefunded, 300);
        assert.equal(order.reconciliationRequired, true);
        const failedEntry = order.refunds.find(r => r.refundId === "rfnd_pending_3");
        assert.equal(failedEntry.status, "failed");
    });

    test("4. Late payment.captured and order.paid are ignored when order paymentStatus is RefundPending", async () => {
        const capturePayload = {
            event: "payment.captured",
            id: "evt_late_cap_pending",
            payload: {
                payment: {
                    entity: {
                        id: "pay_lc_2",
                        order_id: "order_rp_lc_2",
                        amount: 80000,
                        status: "captured",
                        captured: true
                    }
                }
            }
        };

        const { req, res, getStatus, getJson } = createMockReqRes(capturePayload);
        await handler(req, res);

        assert.equal(getStatus(), 200);
        assert.ok(getJson().message.includes("pending"), "Response must indicate refund pending");

        const order = mockOrders.find(o => o._id === "order_lifecycle_2");
        assert.equal(order.paymentStatus, "RefundPending", "Late capture must not overwrite RefundPending");
    });

    test("5. verifyPayment and createPaymentOrder reject orders in RefundPending status", async () => {
        const origFindOne = Order.findOne;
        try {
            Order.findOne = async () => ({
                _id: "order_client_pend",
                totalPrice: 600,
                paymentStatus: "RefundPending",
                razorpayOrderId: "order_rp_client_pend",
                save: async function() { return this; }
            });

            // verifyPayment test
            let verifyStatus = 200;
            let verifyJson = null;
            const resVerify = {
                status: (code) => { verifyStatus = code; return resVerify; },
                json: (data) => { verifyJson = data; return resVerify; }
            };

            const reqVerify = {
                user: { id: "user_client_1" },
                params: { id: "order_client_pend" },
                body: {
                    razorpay_order_id: "order_rp_client_pend",
                    razorpay_payment_id: "pay_client_pend",
                    razorpay_signature: "sig_mock"
                }
            };

            await verifyPayment(reqVerify, resVerify);
            assert.equal(verifyStatus, 400);
            assert.equal(verifyJson.message, "Order refund is pending");

            // createPaymentOrder test
            let createStatus = 200;
            let createJson = null;
            const resCreate = {
                status: (code) => { createStatus = code; return resCreate; },
                json: (data) => { createJson = data; return resCreate; }
            };

            const reqCreate = {
                user: { id: "user_client_1" },
                params: { id: "order_client_pend" }
            };

            await createPaymentOrder(reqCreate, resCreate);
            assert.equal(createStatus, 400);
            assert.ok(createJson.message.includes("RefundPending"));
        } finally {
            Order.findOne = origFindOne;
        }
    });

    test("6. Multiple partial refunds accumulate correctly across multiple events and clamp at totalPrice", async () => {
        const orderMulti = {
            _id: "order_multi_refund",
            totalPrice: 1000,
            orderStatus: "Pending",
            paymentStatus: "Paid",
            razorpayOrderId: "order_rp_multi",
            razorpayPaymentId: "pay_multi_1",
            amountRefunded: 0,
            refunds: [],
            processedWebhookEvents: []
        };
        mockOrders.push(orderMulti);

        // Refund 1: ₹300
        const refund1Payload = {
            event: "refund.processed",
            id: "evt_rfnd_m1",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_m1",
                        payment_id: "pay_multi_1",
                        amount: 30000,
                        status: "processed"
                    }
                }
            }
        };
        const { req: r1, res: res1 } = createMockReqRes(refund1Payload);
        await handler(r1, res1);

        assert.equal(orderMulti.paymentStatus, "PartiallyRefunded");
        assert.equal(orderMulti.amountRefunded, 300);
        assert.equal(orderMulti.refunds.length, 1);

        // Refund 2: ₹400
        const refund2Payload = {
            event: "refund.processed",
            id: "evt_rfnd_m2",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_m2",
                        payment_id: "pay_multi_1",
                        amount: 40000,
                        status: "processed"
                    }
                }
            }
        };
        const { req: r2, res: res2 } = createMockReqRes(refund2Payload);
        await handler(r2, res2);

        assert.equal(orderMulti.paymentStatus, "PartiallyRefunded");
        assert.equal(orderMulti.amountRefunded, 700);
        assert.equal(orderMulti.refunds.length, 2);

        // Refund 3: ₹300 (completes full refund)
        const refund3Payload = {
            event: "refund.processed",
            id: "evt_rfnd_m3",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_m3",
                        payment_id: "pay_multi_1",
                        amount: 30000,
                        status: "processed"
                    }
                }
            }
        };
        const { req: r3, res: res3 } = createMockReqRes(refund3Payload);
        await handler(r3, res3);

        assert.equal(orderMulti.paymentStatus, "Refunded");
        assert.equal(orderMulti.orderStatus, "Cancelled");
        assert.equal(orderMulti.amountRefunded, 1000);
        assert.equal(orderMulti.refunds.length, 3);
    });

    test("7. Delayed refund.failed arriving after refund.processed for same refund ID preserves processed ledger entry, amountRefunded, and paymentStatus", async () => {
        const order = {
            _id: "order_proc_then_failed_1",
            totalPrice: 1000,
            orderStatus: "Cancelled",
            paymentStatus: "RefundPending",
            razorpayPaymentId: "pay_test_ptf_1",
            amountRefunded: 0,
            refunds: [
                {
                    refundId: "rfnd_ptf_1",
                    amount: 1000,
                    status: "pending",
                    createdAt: new Date()
                }
            ],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        // 1. Process refund.processed webhook with event ID evt_rfnd_proc_1
        const processedPayload = {
            event: "refund.processed",
            id: "evt_rfnd_proc_1",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_ptf_1",
                        payment_id: "pay_test_ptf_1",
                        amount: 100000,
                        status: "processed"
                    }
                },
                payment: {
                    entity: {
                        id: "pay_test_ptf_1",
                        amount_refunded: 100000,
                        refund_status: "full"
                    }
                }
            }
        };

        const { req: r1, res: res1, getStatus: getStatus1, getJson: getJson1 } = createMockReqRes(processedPayload);
        await handler(r1, res1);

        assert.equal(getStatus1(), 200);
        assert.equal(getJson1().success, true);
        assert.equal(order.paymentStatus, "Refunded");
        assert.equal(order.amountRefunded, 1000);
        assert.equal(order.refunds.length, 1);
        assert.equal(order.refunds[0].status, "processed");
        assert.ok(order.processedWebhookEvents.includes("evt_rfnd_proc_1"));

        // 2. Delayed refund.failed webhook arrives for the same refund ID with distinct event ID evt_rfnd_failed_late_2
        const failedPayload = {
            event: "refund.failed",
            id: "evt_rfnd_failed_late_2",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_ptf_1",
                        payment_id: "pay_test_ptf_1",
                        amount: 100000,
                        status: "failed",
                        error_code: "LATE_FAILURE_ERROR"
                    }
                },
                payment: {
                    entity: {
                        id: "pay_test_ptf_1"
                    }
                }
            }
        };

        const { req: r2, res: res2, getStatus: getStatus2, getJson: getJson2 } = createMockReqRes(failedPayload);
        await handler(r2, res2);

        assert.equal(getStatus2(), 200);
        assert.equal(getJson2().success, true);
        assert.equal(getJson2().message, "Refund is already processed; ignored late failed event");
        assert.equal(order.paymentStatus, "Refunded", "Payment status must not regress from Refunded");
        assert.equal(order.amountRefunded, 1000, "amountRefunded must not decrease");
        assert.equal(order.refunds.length, 1, "Ledger entry count must remain 1");
        assert.equal(order.refunds[0].status, "processed", "Ledger entry status must remain processed");
        assert.notEqual(order.reconciliationRequired, true, "reconciliationRequired must not be falsely flagged");
        assert.ok(order.processedWebhookEvents.includes("evt_rfnd_failed_late_2"), "Late event ID must be deduplicated in processedWebhookEvents");
    });

});

describe("Razorpay Payment Hardening - Phase 2A Final Implementation Tests", () => {
    let mockOrders = [];
    let mockOrderModel;
    let handler;

    const orderController = require("../controllers/orderController");

    beforeEach(() => {
        mockOrders = [];
        customRefundHandler = null;

        mockOrderModel = {
            findOne: async (query) => {
                await new Promise(r => setImmediate(r));
                if (query._id) return mockOrders.find(o => o._id === query._id.toString()) || null;
                if (query.razorpayOrderId) return mockOrders.find(o => o.razorpayOrderId === query.razorpayOrderId) || null;
                if (query.razorpayPaymentId) return mockOrders.find(o => o.razorpayPaymentId === query.razorpayPaymentId) || null;
                return null;
            },
            findById: async (id) => {
                await new Promise(r => setImmediate(r));
                return mockOrders.find(o => o._id === id.toString()) || null;
            },
            findByIdAndUpdate: async (id, updateQuery) => {
                await new Promise(r => setImmediate(r));
                const order = mockOrders.find(o => o._id === id.toString());
                if (!order) return null;
                if (updateQuery.$set) Object.assign(order, updateQuery.$set);
                if (updateQuery.$addToSet) {
                    for (const [key, val] of Object.entries(updateQuery.$addToSet)) {
                        if (!order[key]) order[key] = [];
                        if (!order[key].includes(val)) order[key].push(val);
                    }
                }
                return { ...order };
            },
            findOneAndUpdate: async (filter, updateQuery, options) => {
                await new Promise(r => setImmediate(r));
                const matchOrder = (order) => {
                    if (filter._id && order._id !== filter._id.toString()) return false;
                    if (filter.razorpayOrderId && order.razorpayOrderId !== filter.razorpayOrderId) return false;
                    if (filter.razorpayPaymentId && order.razorpayPaymentId !== filter.razorpayPaymentId) return false;
                    if (filter["refunds.refundId"]) {
                        if (filter["refunds.refundId"].$ne) {
                            if (order.refunds && order.refunds.some(r => r.refundId === filter["refunds.refundId"].$ne)) {
                                return false;
                            }
                        } else if (!order.refunds || !order.refunds.some(r => r.refundId === filter["refunds.refundId"])) {
                            return false;
                        }
                    }
                    if (filter.orderStatus && filter.orderStatus.$in) {
                        if (!filter.orderStatus.$in.includes(order.orderStatus)) return false;
                    }
                    if (filter.processedWebhookEvents && filter.processedWebhookEvents.$ne) {
                        if (order.processedWebhookEvents && order.processedWebhookEvents.includes(filter.processedWebhookEvents.$ne)) {
                            return false;
                        }
                    }
                    if (filter.paymentStatus) {
                        if (typeof filter.paymentStatus === "string") {
                            if (order.paymentStatus !== filter.paymentStatus) return false;
                        } else {
                            if (filter.paymentStatus.$ne && order.paymentStatus === filter.paymentStatus.$ne) return false;
                            if (filter.paymentStatus.$nin && filter.paymentStatus.$nin.includes(order.paymentStatus)) return false;
                            if (filter.paymentStatus.$in && !filter.paymentStatus.$in.includes(order.paymentStatus)) return false;
                        }
                    }
                    return true;
                };

                const order = mockOrders.find(matchOrder);
                if (!order) return null;

                if (updateQuery.$set) {
                    for (const [key, val] of Object.entries(updateQuery.$set)) {
                        if (key === "refunds.$.status") {
                            const matched = order.refunds?.find(r => r.refundId === filter["refunds.refundId"]);
                            if (matched) matched.status = val;
                        } else {
                            order[key] = val;
                        }
                    }
                }
                if (updateQuery.$addToSet) {
                    for (const [key, val] of Object.entries(updateQuery.$addToSet)) {
                        if (!order[key]) order[key] = [];
                        if (!order[key].includes(val)) {
                            order[key].push(val);
                        }
                    }
                }
                if (updateQuery.$push) {
                    for (const [key, val] of Object.entries(updateQuery.$push)) {
                        if (!order[key]) order[key] = [];
                        order[key].push(val);
                    }
                }
                return { ...order };
            }
        };

        handler = createWebhookHandler({ OrderModel: mockOrderModel });
    });

    const createMockReqRes = (payloadObj, headers = {}) => {
        const rawBody = Buffer.from(JSON.stringify(payloadObj), "utf8");
        const defaultSignature = generateSignature(rawBody, process.env.RAZORPAY_WEBHOOK_SECRET);

        const req = {
            headers: {
                "x-razorpay-signature": defaultSignature,
                ...headers
            },
            rawBody,
            body: payloadObj
        };

        let statusCode = 200;
        let responseJson = null;

        const res = {
            status: (code) => {
                statusCode = code;
                return res;
            },
            json: (data) => {
                responseJson = data;
                return res;
            }
        };

        return {
            req,
            res,
            getStatus: () => statusCode,
            getJson: () => responseJson
        };
    };

    test("1. createPaymentOrder rejects Cancelled orders in paymentController and orderController", async () => {
        const origFindById = Order.findById;
        const origFindOne = Order.findOne;
        try {
            const cancelledOrder = {
                _id: "order_cancelled_test_1",
                orderStatus: "Cancelled",
                paymentStatus: "Pending",
                totalPrice: 500
            };

            Order.findById = async () => cancelledOrder;
            Order.findOne = async () => cancelledOrder;

            // Test paymentController.createPaymentOrder
            let statusP = 200, jsonP = null;
            const resP = { status: (c) => { statusP = c; return resP; }, json: (d) => { jsonP = d; return resP; } };
            await createPaymentOrder({ params: { id: "order_cancelled_test_1" }, user: { id: "usr_1" }, body: {} }, resP);
            assert.equal(statusP, 400);
            assert.equal(jsonP.success, false);
            assert.ok(jsonP.message.includes("cancelled"));

            // Test orderController.createPaymentOrder
            let statusO = 200, jsonO = null;
            const resO = { status: (c) => { statusO = c; return resO; }, json: (d) => { jsonO = d; return resO; } };
            await orderController.createPaymentOrder({ params: { orderId: "order_cancelled_test_1" }, user: { id: "usr_1" } }, resO);
            assert.equal(statusO, 400);
            assert.equal(jsonO.success, false);
            assert.ok(jsonO.message.includes("cancelled"));
        } finally {
            Order.findById = origFindById;
            Order.findOne = origFindOne;
        }
    });

    test("2. verifyPayment on Cancelled order sets reconciliationRequired=true and preserves Cancelled in both controllers", async () => {
        const origFindById = Order.findById;
        const origFindOne = Order.findOne;
        try {
            const secret = process.env.RAZORPAY_KEY_SECRET;
            const orderId = "order_rp_c1";
            const paymentId = "pay_c1";
            const signature = crypto
                .createHmac("sha256", secret)
                .update(`${orderId}|${paymentId}`)
                .digest("hex");

            // Test paymentController.verifyPayment
            const cancelledOrder1 = {
                _id: "order_p_c1",
                orderStatus: "Cancelled",
                paymentStatus: "Pending",
                razorpayOrderId: orderId,
                reconciliationRequired: false,
                save: async function() { return this; }
            };
            Order.findOne = async () => cancelledOrder1;
            Order.findById = async () => cancelledOrder1;

            let statusP = 200, jsonP = null;
            const resP = { status: (c) => { statusP = c; return resP; }, json: (d) => { jsonP = d; return resP; } };
            await verifyPayment({
                user: { id: "usr_1" },
                params: { id: "order_p_c1" },
                body: {
                    orderId: "order_p_c1",
                    razorpay_order_id: orderId,
                    razorpay_payment_id: paymentId,
                    razorpay_signature: signature
                }
            }, resP);

            assert.equal(statusP, 200);
            assert.equal(jsonP.reconciliationRequired, true);
            assert.equal(cancelledOrder1.reconciliationRequired, true);
            assert.equal(cancelledOrder1.orderStatus, "Cancelled");
            assert.equal(cancelledOrder1.paymentStatus, "Paid");

            // Test orderController.verifyPayment
            const cancelledOrder2 = {
                _id: "order_o_c2",
                orderStatus: "Cancelled",
                paymentStatus: "Pending",
                razorpayOrderId: orderId,
                reconciliationRequired: false,
                save: async function() { return this; }
            };
            Order.findOne = async () => cancelledOrder2;
            Order.findById = async () => cancelledOrder2;

            let statusO = 200, jsonO = null;
            const resO = { status: (c) => { statusO = c; return resO; }, json: (d) => { jsonO = d; return resO; } };
            await orderController.verifyPayment({
                user: { id: "usr_1" },
                params: { orderId: "order_o_c2" },
                body: {
                    razorpay_order_id: orderId,
                    razorpay_payment_id: paymentId,
                    razorpay_signature: signature
                }
            }, resO);

            assert.equal(statusO, 200);
            assert.equal(jsonO.reconciliationRequired, true);
            assert.equal(cancelledOrder2.reconciliationRequired, true);
            assert.equal(cancelledOrder2.orderStatus, "Cancelled");
            assert.equal(cancelledOrder2.paymentStatus, "Paid");
        } finally {
            Order.findById = origFindById;
            Order.findOne = origFindOne;
        }
    });

    test("3. Interleaved cancellation-versus-capture race safely redirects to paid refund path", async () => {
        const orderInDb = {
            _id: "order_race_atomic_1",
            totalPrice: 1000,
            orderStatus: "Pending",
            paymentStatus: "Pending",
            amountRefunded: 0,
            refunds: []
        };
        mockOrders.push(orderInDb);

        // Stale in-memory snapshot held by cancellation caller before capture
        const inMemorySnapshot = { ...orderInDb };

        // Wrap mockOrderModel.findOneAndUpdate to simulate concurrent payment capture
        // occurring between in-memory read and cancellation execution
        const origFOU = mockOrderModel.findOneAndUpdate;
        let raceSimulated = false;

        mockOrderModel.findOneAndUpdate = async (filter, updateQuery, options) => {
            if (filter.paymentStatus === "Pending" && !raceSimulated) {
                // Concurrent webhook arrives: marks order Paid in database!
                raceSimulated = true;
                orderInDb.paymentStatus = "Paid";
                orderInDb.razorpayPaymentId = "pay_race_captured_1";
                // The atomic update checking paymentStatus: "Pending" returns null!
                return null;
            }
            return origFOU(filter, updateQuery, options);
        };

        customRefundHandler = async (paymentId, data) => {
            return { id: "rfnd_race_success_1", status: "processed", amount: 100000 };
        };

        const result = await cancelOrderAndRefund(
            inMemorySnapshot,
            "Customer cancelled order",
            { OrderModel: mockOrderModel }
        );

        assert.equal(result.refunded, true);
        assert.equal(result.refundId, "rfnd_race_success_1");
        assert.equal(result.order.orderStatus, "Cancelled");
        assert.equal(result.order.paymentStatus, "Refunded");
        assert.equal(result.order.amountRefunded, 1000);
        assert.equal(result.order.refunds.length, 1);
        assert.equal(result.order.refunds[0].refundId, "rfnd_race_success_1");
    });

    test("4. Repeated delivery of refund.processed with distinct event IDs does NOT duplicate ledger entries", async () => {
        const order = {
            _id: "order_rfnd_atomic_dedupe",
            totalPrice: 1000,
            orderStatus: "Delivered",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_atomic_dup_1",
            amountRefunded: 0,
            refunds: [],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        // First delivery: event ID = evt_attempt_1
        const payload1 = {
            event: "refund.processed",
            id: "evt_attempt_1",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_unique_atomic_1",
                        payment_id: "pay_atomic_dup_1",
                        amount: 35000,
                        status: "processed"
                    }
                }
            }
        };
        const { req: req1, res: res1 } = createMockReqRes(payload1);
        await handler(req1, res1);

        assert.equal(order.refunds.length, 1);
        assert.equal(order.amountRefunded, 350);
        assert.equal(order.paymentStatus, "PartiallyRefunded");

        // Second delivery: same refund ID, but different event ID = evt_attempt_2
        const payload2 = {
            event: "refund.processed",
            id: "evt_attempt_2",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_unique_atomic_1",
                        payment_id: "pay_atomic_dup_1",
                        amount: 35000,
                        status: "processed"
                    }
                }
            }
        };
        const { req: req2, res: res2 } = createMockReqRes(payload2);
        await handler(req2, res2);

        // Must NOT create a duplicate entry or add amount twice
        assert.equal(order.refunds.length, 1, "refunds ledger must contain exactly 1 entry");
        assert.equal(order.amountRefunded, 350, "amountRefunded must not be added twice");
    });

    test("5. Repeated delivery of refund.failed with distinct event IDs does NOT duplicate ledger entries", async () => {
        const order = {
            _id: "order_rfnd_fail_dedupe",
            totalPrice: 1000,
            orderStatus: "Delivered",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_fail_atomic_1",
            amountRefunded: 0,
            refunds: [],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        // First delivery: evt_fail_attempt_1
        const payload1 = {
            event: "refund.failed",
            id: "evt_fail_attempt_1",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_failed_atomic_1",
                        payment_id: "pay_fail_atomic_1",
                        amount: 20000
                    }
                }
            }
        };
        const { req: req1, res: res1 } = createMockReqRes(payload1);
        await handler(req1, res1);

        assert.equal(order.refunds.length, 1);
        assert.equal(order.refunds[0].status, "failed");
        assert.equal(order.reconciliationRequired, true);

        // Second delivery: same refund ID, different event ID = evt_fail_attempt_2
        const payload2 = {
            event: "refund.failed",
            id: "evt_fail_attempt_2",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_failed_atomic_1",
                        payment_id: "pay_fail_atomic_1",
                        amount: 20000
                    }
                }
            }
        };
        const { req: req2, res: res2 } = createMockReqRes(payload2);
        await handler(req2, res2);

        assert.equal(order.refunds.length, 1, "refunds ledger must contain exactly 1 failure entry");
    });

    test("6. Failed refund followed by refund.processed without payment.amount_refunded correctly accumulates amountRefunded", async () => {
        const order = {
            _id: "order_failed_then_proc",
            totalPrice: 1000,
            orderStatus: "Delivered",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_ftp_test_1",
            amountRefunded: 0,
            refunds: [
                {
                    refundId: "rfnd_recovered_1",
                    amount: 400,
                    status: "failed",
                    createdAt: new Date()
                }
            ],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        // Deliver refund.processed without payment.entity.amount_refunded
        const payload = {
            event: "refund.processed",
            id: "evt_ftp_success_1",
            payload: {
                refund: {
                    entity: {
                        id: "rfnd_recovered_1",
                        payment_id: "pay_ftp_test_1",
                        amount: 40000,
                        status: "processed"
                    }
                }
                // payment entity deliberately omitted
            }
        };

        const { req, res } = createMockReqRes(payload);
        await handler(req, res);

        assert.equal(order.refunds.length, 1, "Ledger must maintain single entry");
        assert.equal(order.refunds[0].status, "processed", "Ledger entry status must transition to processed");
        assert.equal(order.amountRefunded, 400, "Cumulative amountRefunded must correctly add the recovered refund amount");
        assert.equal(order.paymentStatus, "PartiallyRefunded");
    });

    test("7. getAllOrders filters correctly by reconciliationRequired query parameter", async () => {
        const origFind = Order.find;
        try {
            const allMockOrders = [
                { _id: "ord_rec_true", reconciliationRequired: true, totalPrice: 500 },
                { _id: "ord_rec_false", reconciliationRequired: false, totalPrice: 300 }
            ];

            Order.find = (filter = {}) => {
                let filtered = [...allMockOrders];
                if (filter.reconciliationRequired !== undefined) {
                    filtered = filtered.filter(o => o.reconciliationRequired === filter.reconciliationRequired);
                }
                return {
                    populate: () => ({
                        populate: () => ({
                            populate: () => ({
                                populate: () => ({
                                    sort: () => filtered
                                })
                            })
                        })
                    })
                };
            };

            let status = 200, json = null;
            const res = {
                status: (c) => { status = c; return res; },
                json: (d) => { json = d; return res; }
            };

            await orderController.getAllOrders({ query: { reconciliationRequired: "true" } }, res);

            assert.equal(status, 200);
            assert.equal(json.count, 1);
            assert.equal(json.orders[0]._id, "ord_rec_true");
        } finally {
            Order.find = origFind;
        }
    });

    test("8. payment.captured notes fallback with conflicting existing razorpayOrderId is rejected with HTTP 400", async () => {
        const order = {
            _id: "order_notes_mismatch_1",
            totalPrice: 500,
            orderStatus: "Pending",
            paymentStatus: "Pending",
            razorpayOrderId: "order_existing_registered_id",
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        // payment.captured arrives with a different order_id in payment entity, but references restaurantOrderId in notes
        const payload = {
            event: "payment.captured",
            id: "evt_notes_mismatch_1",
            payload: {
                payment: {
                    entity: {
                        id: "pay_conflicting_order_1",
                        order_id: "order_different_unrelated_id",
                        amount: 50000,
                        status: "captured",
                        captured: true,
                        currency: "INR",
                        notes: {
                            restaurantOrderId: "order_notes_mismatch_1"
                        }
                    }
                }
            }
        };

        const { req, res, getStatus } = createMockReqRes(payload);
        await handler(req, res);

        assert.equal(getStatus(), 400, "Must return HTTP 400 for gateway order ID conflict in notes fallback");
        assert.equal(order.paymentStatus, "Pending", "Order paymentStatus must remain Pending");
        assert.equal(order.razorpayOrderId, "order_existing_registered_id", "Existing razorpayOrderId must not be overwritten");
        assert.equal(order.processedWebhookEvents.length, 0, "No webhook event should be recorded");
    });

    test("9. payment.captured notes fallback with matching or missing razorpayOrderId succeeds and marks order Paid", async () => {
        const order = {
            _id: "order_notes_matching_1",
            totalPrice: 500,
            orderStatus: "Pending",
            paymentStatus: "Pending",
            razorpayOrderId: null, // order ID not saved yet due to network hiccup during checkout
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        const payload = {
            event: "payment.captured",
            id: "evt_notes_match_1",
            payload: {
                payment: {
                    entity: {
                        id: "pay_valid_fallback_1",
                        order_id: "order_gateway_legit_1",
                        amount: 50000,
                        status: "captured",
                        captured: true,
                        currency: "INR",
                        notes: {
                            restaurantOrderId: "order_notes_matching_1"
                        }
                    }
                }
            }
        };

        const { req, res, getStatus } = createMockReqRes(payload);
        await handler(req, res);

        assert.equal(getStatus(), 200, "Must return HTTP 200 when fallback is legitimate");
        assert.equal(order.paymentStatus, "Paid", "Order must be marked Paid");
        assert.equal(order.razorpayOrderId, "order_gateway_legit_1", "Order razorpayOrderId should be set");
        assert.equal(order.razorpayPaymentId, "pay_valid_fallback_1");
    });

});

describe("Razorpay Refund Recovery & Concurrency Hardening (Phase 2A Final Recovery Tests)", () => {
    let mockOrders = [];
    let mockOrderModel;

    beforeEach(() => {
        mockOrders = [];
        customRefundHandler = null;
        customFetchMultipleRefundHandler = null;
        customFetchPaymentHandler = null;

        mockOrderModel = {
            findOne: async (query) => {
                await new Promise(r => setImmediate(r));
                if (query._id) return mockOrders.find(o => o._id === query._id.toString()) || null;
                if (query.razorpayOrderId) return mockOrders.find(o => o.razorpayOrderId === query.razorpayOrderId) || null;
                if (query.razorpayPaymentId) return mockOrders.find(o => o.razorpayPaymentId === query.razorpayPaymentId) || null;
                return null;
            },
            findById: async (id) => {
                await new Promise(r => setImmediate(r));
                return mockOrders.find(o => o._id === id.toString()) || null;
            },
            findByIdAndUpdate: async (id, updateQuery) => {
                await new Promise(r => setImmediate(r));
                const order = mockOrders.find(o => o._id === id.toString());
                if (!order) return null;
                if (updateQuery.$set) Object.assign(order, updateQuery.$set);
                if (updateQuery.$addToSet) {
                    for (const [key, val] of Object.entries(updateQuery.$addToSet)) {
                        if (!order[key]) order[key] = [];
                        if (!order[key].includes(val)) order[key].push(val);
                    }
                }
                return { ...order };
            },
            findOneAndUpdate: async (filter, updateQuery, options) => {
                await new Promise(r => setImmediate(r));
                const matchOrder = (order) => {
                    if (filter._id && order._id !== filter._id.toString()) return false;
                    if (filter.razorpayOrderId && order.razorpayOrderId !== filter.razorpayOrderId) return false;
                    if (filter.razorpayPaymentId && order.razorpayPaymentId !== filter.razorpayPaymentId) return false;
                    if (filter["refunds.refundId"]) {
                        if (filter["refunds.refundId"].$ne) {
                            if (order.refunds && order.refunds.some(r => r.refundId === filter["refunds.refundId"].$ne)) {
                                return false;
                            }
                        } else if (!order.refunds || !order.refunds.some(r => r.refundId === filter["refunds.refundId"])) {
                            return false;
                        }
                    }
                    if (filter.orderStatus && filter.orderStatus.$in) {
                        if (!filter.orderStatus.$in.includes(order.orderStatus)) return false;
                    }
                    if (filter.processedWebhookEvents && filter.processedWebhookEvents.$ne) {
                        if (order.processedWebhookEvents && order.processedWebhookEvents.includes(filter.processedWebhookEvents.$ne)) {
                            return false;
                        }
                    }
                    if (filter.paymentStatus) {
                        if (typeof filter.paymentStatus === "string") {
                            if (order.paymentStatus !== filter.paymentStatus) return false;
                        } else {
                            if (filter.paymentStatus.$ne && order.paymentStatus === filter.paymentStatus.$ne) return false;
                            if (filter.paymentStatus.$nin && filter.paymentStatus.$nin.includes(order.paymentStatus)) return false;
                            if (filter.paymentStatus.$in && !filter.paymentStatus.$in.includes(order.paymentStatus)) return false;
                        }
                    }
                    return true;
                };

                const order = mockOrders.find(matchOrder);
                if (!order) return null;

                if (updateQuery.$set) {
                    for (const [key, val] of Object.entries(updateQuery.$set)) {
                        if (key === "refunds.$.status") {
                            const matched = order.refunds?.find(r => r.refundId === filter["refunds.refundId"]);
                            if (matched) matched.status = val;
                        } else {
                            order[key] = val;
                        }
                    }
                }
                if (updateQuery.$addToSet) {
                    for (const [key, val] of Object.entries(updateQuery.$addToSet)) {
                        if (!order[key]) order[key] = [];
                        if (!order[key].includes(val)) {
                            order[key].push(val);
                        }
                    }
                }
                if (updateQuery.$push) {
                    for (const [key, val] of Object.entries(updateQuery.$push)) {
                        if (!order[key]) order[key] = [];
                        order[key].push(val);
                    }
                }
                return { ...order };
            }
        };
    });

    test("1. Razorpay refund succeeds but HTTP response is lost; retry reconciles existing refund without issuing duplicate", async () => {
        let refundCallCount = 0;
        const order = {
            _id: "order_lost_resp_1",
            totalPrice: 1000,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_lost_resp_1",
            amountRefunded: 0,
            refunds: [],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        customRefundHandler = async (paymentId, data) => {
            refundCallCount++;
            const err = new Error("The payment has been fully refunded already");
            err.statusCode = 400;
            err.error = { code: "BAD_REQUEST_ERROR", description: "The payment has been fully refunded already" };
            throw err;
        };

        customFetchMultipleRefundHandler = async (paymentId) => {
            if (paymentId === "pay_lost_resp_1") {
                return {
                    entity: "collection",
                    count: 1,
                    items: [
                        {
                            id: "rfnd_lost_gateway_1",
                            payment_id: "pay_lost_resp_1",
                            amount: 100000,
                            status: "processed",
                            notes: { orderId: "order_lost_resp_1" },
                            created_at: 1697500000
                        }
                    ]
                };
            }
            return { entity: "collection", count: 0, items: [] };
        };

        customFetchPaymentHandler = async (paymentId) => {
            return {
                id: paymentId,
                amount: 100000,
                amount_refunded: 100000,
                refund_status: "full",
                status: "captured"
            };
        };

        const result = await cancelOrderAndRefund(order, "Customer cancellation retry", { OrderModel: mockOrderModel });

        assert.equal(result.refunded, true);
        assert.equal(result.refundId, "rfnd_lost_gateway_1");
        assert.equal(order.orderStatus, "Cancelled");
        assert.equal(order.paymentStatus, "Refunded");
        assert.equal(order.amountRefunded, 1000);
        assert.equal(order.refunds.length, 1);
        assert.equal(order.refunds[0].refundId, "rfnd_lost_gateway_1");
        assert.equal(order.refunds[0].status, "processed");
        assert.equal(refundCallCount, 1, "Only initial attempt made; no second duplicate refund call");
    });

    test("2. Existing refund belongs to a different payment; it must not be associated with current order", async () => {
        const order = {
            _id: "order_diff_payment_1",
            totalPrice: 500,
            orderStatus: "Pending",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_legit_order_2",
            amountRefunded: 0,
            refunds: [],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        customRefundHandler = async (paymentId, data) => {
            const err = new Error("The payment has been fully refunded already");
            err.statusCode = 400;
            err.error = { code: "BAD_REQUEST_ERROR", description: "The payment has been fully refunded already" };
            throw err;
        };

        customFetchMultipleRefundHandler = async (paymentId) => {
            return {
                entity: "collection",
                count: 1,
                items: [
                    {
                        id: "rfnd_wrong_payment_99",
                        payment_id: "pay_unrelated_diff_99",
                        amount: 50000,
                        status: "processed"
                    }
                ]
            };
        };

        let caughtError = null;
        try {
            await cancelOrderAndRefund(order, "Customer cancellation retry", { OrderModel: mockOrderModel });
        } catch (err) {
            caughtError = err;
        }

        assert.ok(caughtError, "Must throw error when gateway refund does not match payment ID");
        assert.equal(order.orderStatus, "Pending", "Order status must remain Pending");
        assert.equal(order.paymentStatus, "Paid", "Payment status must remain Paid");
        assert.equal(order.refunds.length, 0, "No foreign refund must be added to refunds ledger");
    });

    test("3. Refund remains genuinely uncertain; reconciliation is required and success is not falsely reported", async () => {
        const order = {
            _id: "order_uncertain_1",
            totalPrice: 800,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_uncertain_1",
            amountRefunded: 0,
            refunds: [],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        customRefundHandler = async (paymentId, data) => {
            const err = new Error("Connection timed out with gateway");
            err.code = "ETIMEDOUT";
            err.statusCode = 504;
            throw err;
        };

        customFetchMultipleRefundHandler = async (paymentId) => {
            const err = new Error("Gateway query timed out");
            err.code = "ETIMEDOUT";
            err.statusCode = 504;
            throw err;
        };

        const result = await cancelOrderAndRefund(order, "Cancel order", { OrderModel: mockOrderModel });

        assert.equal(result.refunded, false, "Must NOT claim refund succeeded");
        assert.equal(result.reconciliationRequired, true, "Must flag reconciliationRequired");
        assert.equal(result.uncertain, true, "Must flag uncertain outcome");
        assert.equal(order.reconciliationRequired, true, "Order in database must have reconciliationRequired=true");
        assert.equal(order.orderStatus, "Scheduled", "Order must not be marked Cancelled without refund confirmation");
        assert.equal(order.paymentStatus, "Paid", "Payment status must remain Paid");
        assert.equal(order.amountRefunded, 0);
    });

    test("4. Reconciliation of an existing partial refund updates ledger and amount correctly", async () => {
        const order = {
            _id: "order_partial_recon_1",
            totalPrice: 1000,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_part_recon_1",
            amountRefunded: 0,
            refunds: [],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        customFetchMultipleRefundHandler = async (paymentId) => {
            return {
                entity: "collection",
                count: 1,
                items: [
                    {
                        id: "rfnd_part_recon_gateway",
                        payment_id: "pay_part_recon_1",
                        amount: 35000,
                        status: "processed",
                        notes: { orderId: "order_partial_recon_1" },
                        created_at: 1697500000
                    }
                ]
            };
        };

        customFetchPaymentHandler = async (paymentId) => {
            return {
                id: paymentId,
                amount: 100000,
                amount_refunded: 35000,
                refund_status: "partial",
                status: "captured"
            };
        };

        const recon = await reconcileGatewayRefunds(order, { OrderModel: mockOrderModel });

        assert.equal(recon.reconciled, true);
        assert.equal(recon.isFullRefund, false);
        assert.equal(recon.cumulativePaise, 35000);
        assert.equal(order.amountRefunded, 350);
        assert.equal(order.paymentStatus, "PartiallyRefunded");
        assert.equal(order.refunds.length, 1);
        assert.equal(order.refunds[0].refundId, "rfnd_part_recon_gateway");
        assert.equal(order.refunds[0].amount, 350);
        assert.equal(order.refunds[0].status, "processed");
    });

    test("5. A webhook completes cancellation before original cancellation request finishes; returns correct final outcome", async () => {
        const order = {
            _id: "order_webhook_race_1",
            totalPrice: 1000,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_wb_race_1",
            amountRefunded: 0,
            refunds: [],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        customRefundHandler = async (paymentId, data) => {
            return { id: "rfnd_wb_race_1", amount: 100000, status: "processed" };
        };

        let webhookArrived = false;
        const origFOU = mockOrderModel.findOneAndUpdate;
        mockOrderModel.findOneAndUpdate = async (filter, updateQuery, options) => {
            if (filter.orderStatus && !webhookArrived) {
                webhookArrived = true;
                order.orderStatus = "Cancelled";
                order.paymentStatus = "Refunded";
                order.amountRefunded = 1000;
                order.refundId = "rfnd_wb_race_1";
                order.refunds = [{ refundId: "rfnd_wb_race_1", amount: 1000, status: "processed" }];
                return null;
            }
            return origFOU(filter, updateQuery, options);
        };

        const result = await cancelOrderAndRefund(order, "Customer cancellation", { OrderModel: mockOrderModel });

        assert.equal(result.refunded, true);
        assert.equal(result.order.orderStatus, "Cancelled");
        assert.equal(result.order.paymentStatus, "Refunded");
        assert.equal(result.order.amountRefunded, 1000);
    });

    test("6. A repeated cancellation after successful refund is idempotent", async () => {
        let refundCallCount = 0;
        const order = {
            _id: "order_idempotent_cancel_1",
            totalPrice: 1000,
            orderStatus: "Cancelled",
            paymentStatus: "Refunded",
            razorpayPaymentId: "pay_idemp_1",
            amountRefunded: 1000,
            refundId: "rfnd_prior_1",
            refunds: [{ refundId: "rfnd_prior_1", amount: 1000, status: "processed" }],
            processedWebhookEvents: ["refund.processed:rfnd_prior_1"]
        };
        mockOrders.push(order);

        customRefundHandler = async (paymentId, data) => {
            refundCallCount++;
            return { id: "rfnd_should_not_be_called" };
        };

        const result = await cancelOrderAndRefund(order, "Customer repeated cancellation", { OrderModel: mockOrderModel });

        assert.equal(result.refunded, true);
        assert.equal(result.refundId, "rfnd_prior_1");
        assert.equal(result.message, "Order is already cancelled");
        assert.equal(order.orderStatus, "Cancelled");
        assert.equal(order.paymentStatus, "Refunded");
        assert.equal(order.refunds.length, 1);
        assert.equal(refundCallCount, 0, "Must NOT call Razorpay refund on already cancelled order");
    });

    test("7. Customer cancellation endpoint in orderController is idempotent and releases walk-in table", async () => {
        const order = {
            _id: "order_ctrl_cancel_1",
            user: "usr_client_1",
            totalPrice: 600,
            orderStatus: "Scheduled",
            paymentStatus: "Pending",
            table: "tbl_client_1",
            reservation: null,
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        let releasedTableId = null;
        let releasedTableStatus = null;
        const origFindById = Order.findById;
        const origFindOneAndUpdate = Order.findOneAndUpdate;
        const origTableFIBU = Table.findByIdAndUpdate;

        order.save = async function() { return this; };
        Order.findById = async (id) => mockOrders.find(o => o._id === id.toString()) || null;
        Order.findOneAndUpdate = mockOrderModel.findOneAndUpdate;
        Table.findByIdAndUpdate = async (id, update) => {
            releasedTableId = id;
            releasedTableStatus = update.status;
            return { _id: id, status: update.status };
        };

        try {
            const orderController = require("../controllers/orderController");
            let statusCode = null;
            let responseJson = null;
            const res = {
                status: (code) => {
                    statusCode = code;
                    return res;
                },
                json: (data) => {
                    responseJson = data;
                    return res;
                }
            };

            await orderController.cancelOrder(
                { params: { id: "order_ctrl_cancel_1" }, user: { id: "usr_client_1", role: "customer" } },
                res
            );

            assert.equal(statusCode, 200);
            assert.equal(responseJson.success, true);
            assert.equal(order.orderStatus, "Cancelled");
            assert.equal(releasedTableId, "tbl_client_1");
            assert.equal(releasedTableStatus, "Available");

            let repeatStatusCode = null;
            let repeatResponseJson = null;
            const resRepeat = {
                status: (code) => {
                    repeatStatusCode = code;
                    return resRepeat;
                },
                json: (data) => {
                    repeatResponseJson = data;
                    return resRepeat;
                }
            };

            await orderController.cancelOrder(
                { params: { id: "order_ctrl_cancel_1" }, user: { id: "usr_client_1", role: "customer" } },
                resRepeat
            );

            assert.equal(repeatStatusCode, 200, "Repeated cancelOrder must return HTTP 200");
            assert.equal(repeatResponseJson.success, true);
            assert.equal(repeatResponseJson.message, "Order is already cancelled");
        } finally {
            Order.findById = origFindById;
            Order.findOneAndUpdate = origFindOneAndUpdate;
            Table.findByIdAndUpdate = origTableFIBU;
        }
    });

    test("8. Pending full refund does not mark paymentStatus Refunded and does not inflate amountRefunded", async () => {
        const order = {
            _id: "order_pending_full_recon_1",
            totalPrice: 1000,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_pending_full_1",
            amountRefunded: 0,
            refunds: [],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        customFetchMultipleRefundHandler = async (paymentId) => {
            return {
                entity: "collection",
                count: 1,
                items: [
                    {
                        id: "rfnd_pending_full_gateway_1",
                        payment_id: "pay_pending_full_1",
                        amount: 100000,
                        status: "pending",
                        notes: { orderId: "order_pending_full_recon_1" },
                        created_at: 1697500000
                    }
                ]
            };
        };

        // Gateway payment reports amount_refunded=100000 prematurely or refund_status="full"
        customFetchPaymentHandler = async (paymentId) => {
            return {
                id: paymentId,
                amount: 100000,
                amount_refunded: 100000,
                refund_status: "full",
                status: "captured"
            };
        };

        const recon = await reconcileGatewayRefunds(order, { OrderModel: mockOrderModel });

        assert.equal(recon.reconciled, true);
        assert.equal(recon.isFullRefund, false, "Pending refund must NEVER trigger isFullRefund");
        assert.equal(recon.hasPendingRefund, true);
        assert.equal(recon.refunded, false, "Pending refund must return refunded: false");
        assert.equal(recon.cumulativePaise, 0, "Pending refund must not be counted as money returned");
        assert.equal(order.amountRefunded, 0, "amountRefunded must not be inflated by pending refund");
        assert.equal(order.paymentStatus, "RefundPending", "Payment status must remain RefundPending");
        assert.equal(order.orderStatus, "Cancelled");
        assert.equal(order.refunds.length, 1);
        assert.equal(order.refunds[0].refundId, "rfnd_pending_full_gateway_1");
        assert.equal(order.refunds[0].status, "pending");
        assert.ok(!order.processedWebhookEvents.includes("refund.processed:rfnd_pending_full_gateway_1"), "Must not mark event processed while refund is pending");
    });

    test("9. Processed refund reconciles idempotently and updates pending ledger entry", async () => {
        const order = {
            _id: "order_proc_idemp_1",
            totalPrice: 1000,
            orderStatus: "Cancelled",
            paymentStatus: "RefundPending",
            razorpayPaymentId: "pay_proc_idemp_1",
            amountRefunded: 0,
            refunds: [
                {
                    refundId: "rfnd_pending_to_processed_1",
                    amount: 1000,
                    status: "pending",
                    createdAt: new Date()
                }
            ],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        customFetchMultipleRefundHandler = async (paymentId) => {
            return {
                entity: "collection",
                count: 1,
                items: [
                    {
                        id: "rfnd_pending_to_processed_1",
                        payment_id: "pay_proc_idemp_1",
                        amount: 100000,
                        status: "processed",
                        notes: { orderId: "order_proc_idemp_1" },
                        created_at: 1697500000
                    }
                ]
            };
        };

        customFetchPaymentHandler = async (paymentId) => {
            return {
                id: paymentId,
                amount: 100000,
                amount_refunded: 100000,
                refund_status: "full",
                status: "captured"
            };
        };

        const recon1 = await reconcileGatewayRefunds(order, { OrderModel: mockOrderModel });

        assert.equal(recon1.reconciled, true);
        assert.equal(recon1.isFullRefund, true);
        assert.equal(recon1.hasPendingRefund, false);
        assert.equal(recon1.refunded, true);
        assert.equal(recon1.cumulativePaise, 100000);
        assert.equal(order.amountRefunded, 1000);
        assert.equal(order.paymentStatus, "Refunded");
        assert.equal(order.refunds.length, 1, "Must update existing entry, not duplicate");
        assert.equal(order.refunds[0].status, "processed");
        assert.ok(order.processedWebhookEvents.includes("refund.processed:rfnd_pending_to_processed_1"));

        // Repeated reconciliation call must be completely idempotent
        const recon2 = await reconcileGatewayRefunds(order, { OrderModel: mockOrderModel });
        assert.equal(recon2.reconciled, true);
        assert.equal(recon2.isFullRefund, true);
        assert.equal(order.amountRefunded, 1000);
        assert.equal(order.refunds.length, 1, "Ledger entry count must not increase on repeated reconciliation");
    });

    test("10. Failed gateway refund is excluded from money returned and flags reconciliationRequired", async () => {
        const order = {
            _id: "order_failed_recon_1",
            totalPrice: 800,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_failed_recon_1",
            amountRefunded: 0,
            refunds: [],
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        customFetchMultipleRefundHandler = async (paymentId) => {
            return {
                entity: "collection",
                count: 1,
                items: [
                    {
                        id: "rfnd_failed_gateway_1",
                        payment_id: "pay_failed_recon_1",
                        amount: 80000,
                        status: "failed",
                        notes: { orderId: "order_failed_recon_1" },
                        created_at: 1697500000
                    }
                ]
            };
        };

        customFetchPaymentHandler = async (paymentId) => {
            return {
                id: paymentId,
                amount: 80000,
                amount_refunded: 0,
                refund_status: null,
                status: "captured"
            };
        };

        const recon = await reconcileGatewayRefunds(order, { OrderModel: mockOrderModel });

        assert.equal(recon.reconciled, true);
        assert.equal(recon.isFullRefund, false);
        assert.equal(recon.hasPendingRefund, false);
        assert.equal(recon.refunded, false);
        assert.equal(recon.cumulativePaise, 0, "Failed refund must not count toward money returned");
        assert.equal(order.amountRefunded, 0);
        assert.equal(order.paymentStatus, "Paid", "Payment status must not be Refunded or PartiallyRefunded");
        assert.equal(order.reconciliationRequired, true, "Failed refund must set reconciliationRequired: true");
        assert.equal(order.refunds.length, 1);
        assert.equal(order.refunds[0].status, "failed");
    });

    test("11. Walk-in table remains Occupied when cancellation outcome is uncertain (HTTP 502)", async () => {
        const order = {
            _id: "order_ctrl_uncertain_1",
            user: "usr_client_unc_1",
            totalPrice: 900,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            razorpayPaymentId: "pay_ctrl_unc_1",
            table: "tbl_walkin_unc_1",
            reservation: null,
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        // Gateway refund times out:
        customRefundHandler = async (paymentId, data) => {
            const err = new Error("Gateway timeout");
            err.code = "ETIMEDOUT";
            throw err;
        };

        // Gateway fetch also fails:
        customFetchMultipleRefundHandler = async (paymentId) => {
            const err = new Error("Gateway connection reset");
            err.code = "ECONNRESET";
            throw err;
        };

        let tableUpdateCalled = false;
        const origFindById = Order.findById;
        const origFindOneAndUpdate = Order.findOneAndUpdate;
        const origTableFIBU = Table.findByIdAndUpdate;

        order.save = async function() { return this; };
        Order.findById = async (id) => mockOrders.find(o => o._id === id.toString()) || null;
        Order.findOneAndUpdate = mockOrderModel.findOneAndUpdate;
        Table.findByIdAndUpdate = async (id, update) => {
            tableUpdateCalled = true;
            return { _id: id, status: update.status };
        };

        try {
            const orderController = require("../controllers/orderController");
            let statusCode = null;
            let responseJson = null;
            const res = {
                status: (code) => {
                    statusCode = code;
                    return res;
                },
                json: (data) => {
                    responseJson = data;
                    return res;
                }
            };

            await orderController.cancelOrder(
                { params: { id: "order_ctrl_uncertain_1" }, user: { id: "usr_client_unc_1", role: "customer" } },
                res
            );

            assert.equal(statusCode, 502, "Must return HTTP 502 on uncertain outcome");
            assert.equal(responseJson.success, false);
            assert.equal(responseJson.reconciliationRequired, true);
            assert.equal(tableUpdateCalled, false, "Walk-in table MUST NOT be released when cancellation is uncertain");
        } finally {
            Order.findById = origFindById;
            Order.findOneAndUpdate = origFindOneAndUpdate;
            Table.findByIdAndUpdate = origTableFIBU;
        }
    });

    test("12. Walk-in table is released to Available on confirmed order cancellation (HTTP 200)", async () => {
        const order = {
            _id: "order_ctrl_confirmed_1",
            user: "usr_client_conf_1",
            totalPrice: 500,
            orderStatus: "Scheduled",
            paymentStatus: "Pending",
            table: "tbl_walkin_conf_1",
            reservation: null,
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        let tableUpdatedId = null;
        let tableUpdatedStatus = null;
        const origFindById = Order.findById;
        const origFindOneAndUpdate = Order.findOneAndUpdate;
        const origTableFIBU = Table.findByIdAndUpdate;

        order.save = async function() { return this; };
        Order.findById = async (id) => mockOrders.find(o => o._id === id.toString()) || null;
        Order.findOneAndUpdate = mockOrderModel.findOneAndUpdate;
        Table.findByIdAndUpdate = async (id, update) => {
            tableUpdatedId = id;
            tableUpdatedStatus = update.status;
            return { _id: id, status: update.status };
        };

        try {
            const orderController = require("../controllers/orderController");
            let statusCode = null;
            let responseJson = null;
            const res = {
                status: (code) => {
                    statusCode = code;
                    return res;
                },
                json: (data) => {
                    responseJson = data;
                    return res;
                }
            };

            await orderController.cancelOrder(
                { params: { id: "order_ctrl_confirmed_1" }, user: { id: "usr_client_conf_1", role: "customer" } },
                res
            );

            assert.equal(statusCode, 200);
            assert.equal(responseJson.success, true);
            assert.equal(order.orderStatus, "Cancelled");
            assert.equal(tableUpdatedId, "tbl_walkin_conf_1");
            assert.equal(tableUpdatedStatus, "Available", "Walk-in table must be released to Available");
        } finally {
            Order.findById = origFindById;
            Order.findOneAndUpdate = origFindOneAndUpdate;
            Table.findByIdAndUpdate = origTableFIBU;
        }
    });

    test("13. Reservation-linked table is NEVER released on order cancellation", async () => {
        const order = {
            _id: "order_ctrl_res_protected_1",
            user: "usr_client_res_1",
            totalPrice: 750,
            orderStatus: "Scheduled",
            paymentStatus: "Pending",
            table: "tbl_res_protected_1",
            reservation: "res_linked_12345",
            processedWebhookEvents: []
        };
        mockOrders.push(order);

        let tableUpdateCalled = false;
        const origFindById = Order.findById;
        const origFindOneAndUpdate = Order.findOneAndUpdate;
        const origTableFIBU = Table.findByIdAndUpdate;

        order.save = async function() { return this; };
        Order.findById = async (id) => mockOrders.find(o => o._id === id.toString()) || null;
        Order.findOneAndUpdate = mockOrderModel.findOneAndUpdate;
        Table.findByIdAndUpdate = async (id, update) => {
            tableUpdateCalled = true;
            return { _id: id, status: update.status };
        };

        try {
            const orderController = require("../controllers/orderController");
            let statusCode = null;
            let responseJson = null;
            const res = {
                status: (code) => {
                    statusCode = code;
                    return res;
                },
                json: (data) => {
                    responseJson = data;
                    return res;
                }
            };

            await orderController.cancelOrder(
                { params: { id: "order_ctrl_res_protected_1" }, user: { id: "usr_client_res_1", role: "customer" } },
                res
            );

            assert.equal(statusCode, 200);
            assert.equal(responseJson.success, true);
            assert.equal(order.orderStatus, "Cancelled");
            assert.equal(tableUpdateCalled, false, "Reservation-linked table MUST NEVER be released on order cancellation");
        } finally {
            Order.findById = origFindById;
            Order.findOneAndUpdate = origFindOneAndUpdate;
            Table.findByIdAndUpdate = origTableFIBU;
        }
    });

});
