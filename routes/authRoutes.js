
const auth = require("../middleware/auth");
const express = require("express");
const router = express.Router();

const { authLimiter, otpLimiter } = require("../middleware/rateLimiter");

const {
    registerUser,
    verifyPhoneOTP,
    resendPhoneOTP,
    loginUser,
    forgotPassword,
    sendPasswordResetOTP,
    resetPasswordWithOTP,
    resetPassword
} = require("../controllers/authController");


// ======================================================
// AUTHENTICATION
// ======================================================

// Register
router.post("/register", authLimiter, registerUser);

// Login with email or phone
router.post("/login", authLimiter, loginUser);


// ======================================================
// PHONE OTP
// ======================================================

// Verify phone after registration
router.post("/verify-phone", otpLimiter, verifyPhoneOTP);

// Resend registration OTP
router.post("/resend-phone-otp", otpLimiter, resendPhoneOTP);


// ======================================================
// PASSWORD RECOVERY
// ======================================================

// Existing email password reset
router.post("/forgot-password", authLimiter, forgotPassword);

// Phone OTP password reset
router.post("/forgot-password-phone", otpLimiter, sendPasswordResetOTP);

// Reset password using phone OTP
router.post("/reset-password-phone", otpLimiter, resetPasswordWithOTP);

// Existing email reset-token flow
router.post("/reset-password/:token", authLimiter, resetPassword);


// ======================================================
// PROFILE
// ======================================================

router.get("/profile", auth, (req, res) => {
    res.json({
        success: true,
        message: "Profile Loaded Successfully",
        user: req.user
    });
});


// ======================================================
// ADMIN TEST
// ======================================================

const admin = require("../middleware/admin");

router.get("/admin-test", auth, admin, (req, res) => {
    res.json({
        success: true,
        message: "Welcome Admin!"
    });
});


module.exports = router;
