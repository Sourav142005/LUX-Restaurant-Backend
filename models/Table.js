const mongoose = require("mongoose");

const tableSchema = new mongoose.Schema(
    {
        tableNumber: {
            type: Number,
            required: true,
            unique: true
        },

        capacity: {
            type: Number,
            required: true,
            min: 1
        },

        // ==================================================
        // Table Type
        // ==================================================
        //
        // Reservation → Used for advance reservations
        // Walk-In     → Used for customers without reservation
        //
        // ==================================================

        tableType: {
            type: String,
            enum: [
                "Reservation",
                "Walk-In"
            ],
            default: "Reservation",
            required: true
        },

        status: {
            type: String,
            enum: [
                "Available",
                "Occupied",
                "Reserved"
            ],
            default: "Available"
        }
    },
    {
        timestamps: true
    }
);

module.exports =
    mongoose.model("Table", tableSchema);