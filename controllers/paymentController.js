const Razorpay = require("razorpay");
const crypto = require("crypto");
const Order = require("../models/Order");

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ======================================================
// Helper - Get authenticated user ID
// ======================================================

const getUserId = (req) => {
    return req.user?._id || req.user?.id;
};

// ======================================================
// CREATE RAZORPAY PAYMENT ORDER
// POST /order/:id/payment
// ======================================================

const createPaymentOrder = async (req, res) => {
    try {

        const { id: orderId } = req.params;
        const userId = getUserId(req);

        console.log("=================================");
        console.log("💳 CREATE RAZORPAY PAYMENT ORDER");
        console.log("Restaurant Order ID:", orderId);
        console.log("User ID:", userId);
        console.log("=================================");

        // --------------------------------------------------
        // Validate order ID
        // --------------------------------------------------

        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: "Order ID is required"
            });
        }

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Authentication user not found"
            });
        }

        // --------------------------------------------------
        // Find restaurant order
        // --------------------------------------------------

        const order = await Order.findOne({
            _id: orderId,
            user: userId
        });

        if (!order) {

            console.error(
                "❌ Restaurant order not found"
            );

            console.error(
                "Order ID:",
                orderId
            );

            console.error(
                "User ID:",
                userId
            );

            return res.status(404).json({
                success: false,
                message: "Order not found"
            });
        }

        console.log(
            "✅ Restaurant order found:",
            order._id.toString()
        );

        console.log(
            "Order total:",
            order.totalPrice
        );

        console.log(
            "Payment status:",
            order.paymentStatus
        );

        // --------------------------------------------------
        // Already paid
        // --------------------------------------------------

        if (order.orderStatus === "Cancelled") {
            return res.status(400).json({
                success: false,
                message: "Cannot initiate payment: Order is cancelled"
            });
        }

        if (["Paid", "PartiallyRefunded", "RefundPending", "Refunded"].includes(order.paymentStatus)) {
            return res.status(400).json({
                success: false,
                message: `Cannot initiate payment: Order payment status is ${order.paymentStatus}`
            });
        }

        // --------------------------------------------------
        // Calculate amount
        // Razorpay requires paise
        // --------------------------------------------------

        const amount = Math.round(
            Number(order.totalPrice) * 100
        );

        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid order amount"
            });
        }

        console.log(
            "Razorpay amount:",
            amount
        );

        // --------------------------------------------------
        // Create Razorpay order
        // --------------------------------------------------

        const razorpayOrder =
            await razorpay.orders.create({
                amount: amount,
                currency: "INR",
                receipt:
                    `LUX_${order._id.toString()}`,
                notes: {
                    orderId:
                        order._id.toString(),
                    userId:
                        userId.toString()
                }
            });

        console.log(
            "✅ Razorpay order created:",
            razorpayOrder.id
        );

        // --------------------------------------------------
        // Save Razorpay order ID
        // --------------------------------------------------

        order.razorpayOrderId =
            razorpayOrder.id;

        await order.save();

        console.log(
            "✅ Razorpay order ID saved:",
            razorpayOrder.id
        );

        // --------------------------------------------------
        // Response
        // --------------------------------------------------

        return res.status(200).json({

            success: true,

            message:
                "Payment order created",

            key:
                process.env.RAZORPAY_KEY_ID,

            amount:
                razorpayOrder.amount,

            currency:
                razorpayOrder.currency,

            orderId:
                order._id.toString(),

            razorpayOrderId:
                razorpayOrder.id
        });

    } catch (error) {

        console.error(
            "❌ Create Payment Order Error:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                error.message ||
                "Failed to create payment order"
        });
    }
};


// ======================================================
// VERIFY RAZORPAY PAYMENT
// POST /order/:id/payment/verify
// ======================================================

const verifyPayment = async (req, res) => {

    try {

        const { id: orderId } =
            req.params;

        const {
            razorpay_payment_id,
            razorpay_order_id,
            razorpay_signature
        } = req.body;

        const userId =
            getUserId(req);

        console.log("=================================");
        console.log("🔐 VERIFY RAZORPAY PAYMENT");
        console.log("Restaurant Order ID:", orderId);
        console.log(
            "Razorpay Order ID:",
            razorpay_order_id
        );
        console.log(
            "Razorpay Payment ID:",
            razorpay_payment_id
        );
        console.log(
            "User ID:",
            userId
        );
        console.log("=================================");

        // --------------------------------------------------
        // Validate authentication
        // --------------------------------------------------

        if (!userId) {

            return res.status(401).json({
                success: false,
                message:
                    "Authentication user not found"
            });
        }

        // --------------------------------------------------
        // Validate restaurant order ID
        // --------------------------------------------------

        if (!orderId) {

            return res.status(400).json({
                success: false,
                message:
                    "Restaurant order ID is required"
            });
        }

        // --------------------------------------------------
        // Validate Razorpay response
        // --------------------------------------------------

        if (
            !razorpay_payment_id ||
            !razorpay_order_id ||
            !razorpay_signature
        ) {

            console.error(
                "❌ Missing Razorpay verification data"
            );

            return res.status(400).json({
                success: false,
                message:
                    "Payment verification data is incomplete"
            });
        }

        // --------------------------------------------------
        // Find restaurant order
        // --------------------------------------------------

        const order =
            await Order.findOne({
                _id: orderId,
                user: userId
            });

        if (!order) {

            console.error(
                "❌ Restaurant order not found"
            );

            console.error(
                "Order ID:",
                orderId
            );

            console.error(
                "User ID:",
                userId
            );

            return res.status(404).json({
                success: false,
                message:
                    "Order not found"
            });
        }

        console.log(
            "✅ Restaurant order found:",
            order._id.toString()
        );

        console.log(
            "Stored Razorpay Order ID:",
            order.razorpayOrderId
        );

        // --------------------------------------------------
        // Check Razorpay order ID
        // --------------------------------------------------

        if (
            !order.razorpayOrderId
        ) {

            console.error(
                "❌ No Razorpay order ID stored"
            );

            return res.status(400).json({
                success: false,
                message:
                    "Razorpay order was not created for this order"
            });
        }

        if (
            order.razorpayOrderId !==
            razorpay_order_id
        ) {

            console.error(
                "❌ Razorpay Order ID mismatch"
            );

            console.error(
                "Expected:",
                order.razorpayOrderId
            );

            console.error(
                "Received:",
                razorpay_order_id
            );

            return res.status(400).json({
                success: false,
                message:
                    "Razorpay order ID does not match the restaurant order"
            });
        }

        // --------------------------------------------------
        // Prevent duplicate verification
        // --------------------------------------------------

        if (
            order.paymentStatus === "Paid"
        ) {
            console.log(
                "ℹ️ Payment already verified"
            );
            return res.status(200).json({
                success: true,
                message:
                    "Payment already verified",
                order
            });
        }

        if (order.paymentStatus === "PartiallyRefunded") {
            console.log(
                "ℹ️ Payment already verified (order partially refunded)"
            );
            return res.status(200).json({
                success: true,
                message:
                    "Payment already verified (order partially refunded)",
                order
            });
        }

        if (order.paymentStatus === "RefundPending") {
            return res.status(400).json({
                success: false,
                message: "Order refund is pending"
            });
        }

        if (order.paymentStatus === "Refunded") {
            return res.status(400).json({
                success: false,
                message: "Order has already been refunded"
            });
        }

        // --------------------------------------------------
        // Generate Razorpay signature
        // --------------------------------------------------

        const generatedSignature =
            crypto
                .createHmac(
                    "sha256",
                    process.env.RAZORPAY_KEY_SECRET
                )
                .update(
                    `${razorpay_order_id}|${razorpay_payment_id}`
                )
                .digest("hex");

        console.log(
            "Generated signature:",
            generatedSignature
        );

        console.log(
            "Received signature:",
            razorpay_signature
        );

        // --------------------------------------------------
        // Safe signature comparison
        // --------------------------------------------------

        const generatedBuffer =
            Buffer.from(
                generatedSignature,
                "utf8"
            );

        const receivedBuffer =
            Buffer.from(
                razorpay_signature,
                "utf8"
            );

        if (
            generatedBuffer.length !==
            receivedBuffer.length
        ) {

            console.error(
                "❌ Signature length mismatch"
            );

            if (!["Paid", "PartiallyRefunded", "RefundPending", "Refunded"].includes(order.paymentStatus)) {
                order.paymentStatus = "Failed";
                await order.save();
            }

            return res.status(400).json({
                success: false,
                message:
                    "Payment signature verification failed"
            });
        }

        const isValid =
            crypto.timingSafeEqual(
                generatedBuffer,
                receivedBuffer
            );

        // --------------------------------------------------
        // Invalid signature
        // --------------------------------------------------

        if (!isValid) {

            console.error(
                "❌ Invalid Razorpay signature"
            );

            if (!["Paid", "PartiallyRefunded", "RefundPending", "Refunded"].includes(order.paymentStatus)) {
                order.paymentStatus = "Failed";
                await order.save();
            }

            return res.status(400).json({
                success: false,
                message:
                    "Payment signature verification failed"
            });
        }

        // --------------------------------------------------
        // PAYMENT VERIFIED
        // --------------------------------------------------

        console.log("=================================");
        console.log(
            "✅ RAZORPAY PAYMENT VERIFIED"
        );
        console.log("=================================");

        const isCancelled = order.orderStatus === "Cancelled";
        if (isCancelled) {
            order.reconciliationRequired = true;
            console.warn(
                `🚨 ALERT: Payment ${razorpay_payment_id} verified for CANCELLED order ${order._id}. Marked reconciliationRequired=true.`
            );
        }

        if (!["Paid", "PartiallyRefunded", "RefundPending", "Refunded"].includes(order.paymentStatus)) {
            order.paymentStatus = "Paid";
        }

        order.razorpayPaymentId =
            razorpay_payment_id;

        order.razorpaySignature =
            razorpay_signature;

        await order.save();

        if (isCancelled) {
            return res.status(200).json({
                success: true,
                message: "Payment verified for cancelled order; flagged for manual reconciliation",
                reconciliationRequired: true,
                order
            });
        }

        console.log(
            "✅ Order marked as Paid"
        );

        // --------------------------------------------------
        // Success response
        // --------------------------------------------------

        return res.status(200).json({

            success: true,

            message:
                "Payment verified successfully",

            order
        });

    } catch (error) {

        console.error(
            "❌ Payment Verification Error:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                error.message ||
                "Payment verification failed"
        });
    }
};


// ======================================================
// EXPORT
// ======================================================

module.exports = {
    createPaymentOrder,
    verifyPayment
};