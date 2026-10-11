const Razorpay = require("razorpay");
const Order = require("../models/Order");

// ======================================================
// Razorpay Configuration
// ======================================================

if (
    !process.env.RAZORPAY_KEY_ID ||
    !process.env.RAZORPAY_KEY_SECRET
) {
    console.error(
        "❌ Razorpay keys are missing from .env"
    );
}

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ======================================================
// Cancel Order + Refund If Required
// ======================================================
//
// Reusable order-cancellation business logic.
//
// Allowed:
// Scheduled → Cancelled
// Pending   → Cancelled
//
// Paid:
// Razorpay refund → Cancelled + Refunded
//
// Unpaid/Failed:
// Cancelled
//
// This service does NOT modify table status.
// Reservation controls the table lifecycle.
//
// ======================================================

const cancelOrderAndRefund = async (
    order,
    reason = "Order cancelled"
) => {

    if (!order) {

        const error =
            new Error("Order not found");

        error.statusCode = 404;

        throw error;
    }


    // ==================================================
    // Only Scheduled / Pending orders can be cancelled
    // ==================================================

    if (
        ![
            "Scheduled",
            "Pending"
        ].includes(order.orderStatus)
    ) {

        const error =
            new Error(
                `Only scheduled or pending orders can be cancelled. Current status: ${order.orderStatus}`
            );

        error.statusCode = 400;

        throw error;
    }


    // ==================================================
    // PAID ORDER
    // ==================================================

    if (
        order.paymentStatus ===
        "Paid"
    ) {

        if (!order.razorpayPaymentId) {

            const error =
                new Error(
                    "Payment was successful, but the Razorpay payment ID is missing. Refund cannot be processed automatically."
                );

            error.statusCode = 400;

            throw error;
        }


        console.log(
            "================================="
        );

        console.log(
            "💰 REFUND REQUEST"
        );

        console.log(
            "Order:",
            order._id.toString()
        );

        console.log(
            "Payment:",
            order.razorpayPaymentId
        );

        console.log(
            "Amount:",
            order.totalPrice
        );


        try {

            const refund =
                await razorpay.payments.refund(
                    order.razorpayPaymentId,
                    {
                        amount:
                            Math.round(
                                Number(
                                    order.totalPrice
                                ) * 100
                            ),

                        notes: {

                            orderId:
                                order._id.toString(),

                            reason

                        }

                    }
                );


            console.log(
                "✅ Refund created:",
                refund.id
            );


            order.orderStatus =
                "Cancelled";

            order.paymentStatus =
                "Refunded";


            await order.save();


            return {

                order,

                refunded: true,

                refundId:
                    refund.id,

                message:
                    "Order cancelled successfully and refund initiated"

            };


        } catch (refundError) {

            console.error(
                "❌ Razorpay Refund Error:",
                refundError
            );


            const error =
                new Error(
                    refundError.error?.description ||
                    refundError.message ||
                    "Order cancellation failed because the refund could not be processed"
                );

            error.statusCode = 500;

            error.originalError =
                refundError;

            throw error;
        }

    }


    // ==================================================
    // UNPAID ORDER
    // ==================================================

    if (
        order.paymentStatus ===
        "Pending"
    ) {

        order.orderStatus =
            "Cancelled";


        await order.save();


        return {

            order,

            refunded: false,

            refundId: null,

            message:
                "Order cancelled successfully"

        };
    }


    // ==================================================
    // FAILED PAYMENT
    // ==================================================

    if (
        order.paymentStatus ===
        "Failed"
    ) {

        order.orderStatus =
            "Cancelled";


        await order.save();


        return {

            order,

            refunded: false,

            refundId: null,

            message:
                "Order cancelled successfully"

        };
    }


    // ==================================================
    // UNKNOWN PAYMENT STATUS
    // ==================================================

    const error =
        new Error(
            `Order cannot be cancelled with payment status: ${order.paymentStatus}`
        );

    error.statusCode = 400;

    throw error;
};


// ======================================================
// Cancel All Cancellable Orders For A Reservation
// ======================================================
//
// Scheduled / Pending orders:
// → Cancel
// → Refund if Paid
//
// Preparing / Ready / Delivered:
// → Block reservation cancellation
//
// ======================================================

const cancelReservationOrders = async (
    reservationId,
    reason = "Reservation cancelled"
) => {

    const orders =
        await Order.find({

            reservation:
                reservationId,

            orderStatus: {

                $in: [

                    "Scheduled",

                    "Pending",

                    "Preparing",

                    "Ready",

                    "Delivered"

                ]

            }

        });


    // ==================================================
    // Check For Orders Already Being Processed
    // ==================================================

    const activeFoodOrders =
        orders.filter(

            order =>

                [

                    "Preparing",

                    "Ready",

                    "Delivered"

                ].includes(
                    order.orderStatus
                )

        );


    if (
        activeFoodOrders.length > 0
    ) {

        const error =
            new Error(
                "Reservation cannot be cancelled because an associated food order is already being prepared, ready, or delivered"
            );

        error.statusCode = 400;

        throw error;
    }


    // ==================================================
    // Cancel Scheduled / Pending Orders
    // ==================================================

    const results = [];


    for (
        const order of orders
    ) {

        const result =
            await cancelOrderAndRefund(
                order,
                reason
            );


        results.push(
            result
        );

    }


    return results;
};


// ======================================================
// Export
// ======================================================

module.exports = {

    cancelOrderAndRefund,

    cancelReservationOrders

};