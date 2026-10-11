
const rateLimit = require("express-rate-limit");

// General authentication limiter
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10, // Maximum 10 requests per IP per window
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many requests. Please try again after 15 minutes."
    }
});

// Strict limiter for OTP-related requests
const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 5, // Maximum 5 requests per IP per window
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many OTP requests. Please try again after 15 minutes."
    }
});

module.exports = {
    authLimiter,
    otpLimiter
};
