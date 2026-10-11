const mongoose = require("mongoose");

const reservationSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        table: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Table",
            required: true
        },

        reservationDate: {
            type: Date,
            required: true
        },

        startTime: {
            type: String,
            required: true
        },

        endTime: {
            type: String,
            required: true
        },

        guests: {
            type: Number,
            required: true,
            min: 1
        },

        status: {
            type: String,
            enum: [
                "Pending",
                "Confirmed",
                "Cancelled",
                "Completed"
            ],
            default: "Pending"
        },

        notes: {
            type: String,
            default: ""
        }
    },
    {
        timestamps: true
    }
);

module.exports =
    mongoose.model("Reservation", reservationSchema);