const express = require("express");

const router = express.Router();

const {
    createPaymentOrder,
    verifyPayment
} = require("../controllers/paymentController");

const {
    handleRazorpayWebhook
} = require("../controllers/webhookController");

const auth = require("../middleware/auth");

// ======================================================
// Razorpay Webhook
// POST /api/payment/webhook
// (Verified via HMAC-SHA256 signature; no user JWT required)
// ======================================================

router.post(
    "/webhook",
    handleRazorpayWebhook
);

// ======================================================
// Create Razorpay Order
// ======================================================

router.post(
    "/create",
    auth,
    createPaymentOrder
);

// ======================================================
// Verify Payment
// ======================================================

router.post(
    "/verify",
    auth,
    verifyPayment
);

module.exports = router;