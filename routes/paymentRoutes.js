const express = require("express");

const router = express.Router();

const {
    createPaymentOrder,
    verifyPayment
} = require("../controllers/paymentController");

const auth = require("../middleware/auth");

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