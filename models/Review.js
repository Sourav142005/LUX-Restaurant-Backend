const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },

        menu: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Menu",
            required: true,
            index: true
        },

        order: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Order",
            required: true
        },

        rating: {
            type: Number,
            required: true,
            min: 1,
            max: 5
        },

        comment: {
            type: String,
            trim: true,
            maxlength: 500,
            default: ""
        }
    },
    {
        timestamps: true
    }
);

// Enforce unique review per user per dish
reviewSchema.index({ user: 1, menu: 1 }, { unique: true });

module.exports = mongoose.model("Review", reviewSchema);

