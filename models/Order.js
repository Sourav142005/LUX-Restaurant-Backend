const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

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

                price: {
                    type: Number,
                    required: true
                }
            }
        ],

        totalPrice: {
            type: Number,
            required: true
        },

        orderStatus: {
            type: String,
            enum: [
                "Pending",
                "Preparing",
                "Ready",
                "Delivered",
                "Cancelled"
            ],
            default: "Pending"
        },

        paymentStatus: {
            type: String,
            enum: [
                "Pending",
                "Paid",
                "Failed"
            ],
            default: "Pending"
        },

        orderType: {
            type: String,
            enum: [
                "Dine-In",
                "Takeaway",
                "Delivery"
            ],
            default: "Dine-In"
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model("Order", orderSchema);