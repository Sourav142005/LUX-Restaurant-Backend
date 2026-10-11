const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
    {
        fullName: {
            type: String,
            required: true,
            trim: true
        },
        email: {
            type: String,
            required: false,
            unique: true,
            sparse: true,
            lowercase: true,
            trim: true
        },
        password: {
            type: String,
            required: true
        },
        passwordChangedAt: {
            type: Date,
            default: null
        },
        phone: {
            type: String,
            required: true,
            unique: true,
            trim: true
        },
        role: {
            type: String,
            enum: ["customer", "admin"],
            default: "customer"
        },
        phoneVerified: {
            type: Boolean,
            default: false
        },
        phoneVerificationOTP: {
            type: String,
            default: null
        },
        phoneVerificationOTPExpire: {
            type: Date,
            default: null
        },
        phoneVerificationOTPAttempts: {
            type: Number,
            default: 0
        },
        phoneVerificationOTPResendAt: {
            type: Date,
            default: null
        },
        passwordResetOTP: {
            type: String,
            default: null
        },
        passwordResetOTPExpire: {
            type: Date,
            default: null
        },
        passwordResetOTPAttempts: {
            type: Number,
            default: 0
        },
        passwordResetOTPResendAt: {
            type: Date,
            default: null
        },
        resetPasswordToken: {
            type: String,
            default: null
        },
        resetPasswordExpire: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model("User", userSchema);
