const mongoose = require("mongoose");

// ======================================================
// Order Schema
// ======================================================

const orderSchema = new mongoose.Schema(
    {
        // ==================================================
        // User
        // ==================================================

        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },

        // ==================================================
        // Order Items
        // ==================================================

        items: [
            {
                menu: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "Menu",
                    required: true
                },

                quantity: {
                    type: Number,
                    required: true,
                    min: 1
                },

                // Price at the time the order was created
                price: {
                    type: Number,
                    required: true,
                    min: 0
                }
            }
        ],

        // ==================================================
        // Total Price
        // ==================================================

        totalPrice: {
            type: Number,
            required: true,
            min: 0
        },

        // ==================================================
        // Order Status
        // ==================================================

        orderStatus: {
            type: String,

            enum: [
                "Scheduled",
                "Pending",
                "Preparing",
                "Ready",
                "Delivered",
                "Cancelled"
            ],

            default: "Pending",

            index: true
        },

        // ==================================================
        // Payment Status
        // ==================================================

        paymentStatus: {
            type: String,

            enum: [
                "Pending",
                "Paid",
                "PartiallyRefunded",
                "RefundPending",
                "Failed",
                "Refunded"
            ],

            default: "Pending",

            index: true
        },

        // ==================================================
        // Payment Policy
        // ==================================================

        paymentPolicy: {
            type: String,

            enum: [
                "PayNow",
                "PayAfterDining"
            ],

            default: "PayNow",

            index: true
        },

        // ==================================================
        // Razorpay Payment Information
        // ==================================================

        razorpayOrderId: {
            type: String,
            default: null,
            trim: true,
            index: true
        },

        razorpayPaymentId: {
            type: String,
            default: null,
            trim: true,
            index: true
        },

        razorpaySignature: {
            type: String,
            default: null,
            trim: true
        },

        // ==================================================
        // Razorpay Refund ID (Latest)
        // ==================================================

        refundId: {
            type: String,
            default: null,
            trim: true
        },

        // ==================================================
        // Refund Ledger (Multiple Partial Refunds)
        // ==================================================

        refunds: [
            {
                refundId: { type: String, required: true },
                amount: { type: Number, required: true },
                status: { type: String, default: "processed" },
                createdAt: { type: Date, default: Date.now }
            }
        ],

        // ==================================================
        // Cumulative Amount Refunded (in Rupees)
        // ==================================================

        amountRefunded: {
            type: Number,
            default: 0,
            min: 0
        },

        // ==================================================
        // Reconciliation Required (e.g. captured after cancellation)
        // ==================================================

        reconciliationRequired: {
            type: Boolean,
            default: false,
            index: true
        },

        // ==================================================
        // Processed Webhook Events (Deduplication)
        // ==================================================

        processedWebhookEvents: {
            type: [String],
            default: []
        },

        // ==================================================
        // Order Type
        // ==================================================

        orderType: {
            type: String,

            enum: [
                "Dine-In",
                "Takeaway",
                "Delivery"
            ],

            default: "Dine-In",

            required: true
        },

        // ==================================================
        // Table
        // ==================================================

        table: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Table",
            default: null
        },

        // ==================================================
        // Table Closed / Customer Left
        // ==================================================

        tableClosed: {
            type: Boolean,
            default: false
        },

        // ==================================================
        // Reservation
        // ==================================================

        reservation: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Reservation",
            default: null
        },
    },

    {
        timestamps: true
    }
);


// ======================================================
// Helpful Indexes
// ======================================================

orderSchema.index({
    user: 1,
    createdAt: -1
});

orderSchema.index({
    orderStatus: 1,
    createdAt: -1
});

orderSchema.index({
    paymentStatus: 1,
    createdAt: -1
});

orderSchema.index({
    paymentPolicy: 1,
    createdAt: -1
});


// ======================================================
// Export Model
// ======================================================

module.exports =
    mongoose.models.Order ||
    mongoose.model("Order", orderSchema);