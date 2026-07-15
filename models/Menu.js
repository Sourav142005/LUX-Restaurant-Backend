const mongoose = require("mongoose");

const menuSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },

        description: {
            type: String,
            required: true,
            trim: true
        },

        price: {
            type: Number,
            required: true
        },

        category: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Category",
            required: true
        },

        image: {
            type: String,
            default: ""
        },

        isVeg: {
            type: Boolean,
            default: true
        },

        isAvailable: {
            type: Boolean,
            default: true
        },

        preparationTime: {
            type: Number,
            default: 15
        },

        rating: {
            type: Number,
            default: 0
        }

    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model("Menu", menuSchema);