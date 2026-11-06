const mongoose = require("mongoose");

const regularOrderItemSchema = new mongoose.Schema(
    {
        menu: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Menu",
            required: true
        },
        quantity: {
            type: Number,
            required: true,
            default: 1,
            min: [1, "Quantity must be at least 1"],
            max: [99, "Quantity cannot exceed 99"]
        }
    },
    { _id: true }
);

const regularOrderSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },
        name: {
            type: String,
            required: [true, "Collection name is required"],
            trim: true,
            maxlength: [60, "Collection name cannot exceed 60 characters"]
        },
        nameLower: {
            type: String,
            required: true,
            lowercase: true,
            trim: true
        },
        items: [regularOrderItemSchema]
    },
    {
        timestamps: true
    }
);

// Compound index for user + nameLower to enforce case-insensitive uniqueness per user
regularOrderSchema.index({ user: 1, nameLower: 1 }, { unique: true });

module.exports = mongoose.model("RegularOrder", regularOrderSchema);

