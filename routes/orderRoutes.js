const express = require("express");
const router = express.Router();

const {
    createOrder,
    getMyOrders,
    getOrderById,
    updateOrderStatus,
    processScheduledOrders,
    deleteOrder,
    cancelOrder,
    getAllOrders,
    closeTable,

    // Payment
    createPaymentOrder,
    verifyPayment
} = require("../controllers/orderController");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");


// ======================================================
// CUSTOMER ROUTES
// ======================================================


// ------------------------------------------------------
// Create Restaurant Order
// POST /order
// ------------------------------------------------------

router.post(
    "/",
    auth,
    createOrder
);


// ------------------------------------------------------
// Get Logged-in User Orders
// GET /order/my
// ------------------------------------------------------

router.get(
    "/my",
    auth,
    getMyOrders
);


// ------------------------------------------------------
// Get Single Order
// GET /order/:id
// ------------------------------------------------------

router.get(
    "/:id",
    auth,
    getOrderById
);


// ------------------------------------------------------
// Cancel Order
// PATCH /order/:id/cancel
// ------------------------------------------------------

router.patch(
    "/:id/cancel",
    auth,
    cancelOrder
);


// ======================================================
// RAZORPAY PAYMENT ROUTES
// ======================================================


// ------------------------------------------------------
// Create Razorpay Payment Order
//
// POST
// /order/:orderId/payment
//
// Example:
// /order/68a123456789/payment
// ------------------------------------------------------

router.post(
    "/:orderId/payment",
    auth,
    createPaymentOrder
);


// ------------------------------------------------------
// Verify Razorpay Payment
//
// POST
// /order/:orderId/payment/verify
//
// Example:
// /order/68a123456789/payment/verify
// ------------------------------------------------------

router.post(
    "/:orderId/payment/verify",
    auth,
    verifyPayment
);


// ======================================================
// SCHEDULED ORDER ROUTES
// ======================================================


// ------------------------------------------------------
// Process Scheduled Orders
// POST /order/process-scheduled
// ------------------------------------------------------

router.post(
    "/process-scheduled",
    auth,
    admin,
    processScheduledOrders
);


// ======================================================
// ADMIN ROUTES
// ======================================================


// ------------------------------------------------------
// Get All Orders
// GET /order
// ------------------------------------------------------

router.get(
    "/",
    auth,
    admin,
    getAllOrders
);


// ------------------------------------------------------
// Update Order Status
// PUT /order/:id
// ------------------------------------------------------

router.put(
    "/:id",
    auth,
    admin,
    updateOrderStatus
);


// ------------------------------------------------------
// Delete Order
// DELETE /order/:id
// ------------------------------------------------------

router.delete(
    "/:id",
    auth,
    admin,
    deleteOrder
);

router.post(
    "/:id/close-table",
    auth,
    closeTable
);

// ======================================================
// EXPORT
// ======================================================

module.exports = router;