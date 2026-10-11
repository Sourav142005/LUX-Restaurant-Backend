const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
// ======================================================
// OTP HELPERS
// ======================================================
const generateOTP = () => {
return crypto.randomInt(100000, 1000000).toString();
};
const hashOTP = (otp) => {
return crypto
.createHash("sha256")
.update(otp)
.digest("hex");
};
const normalizePhone = (phone) => {
if (!phone) return null;
let cleaned = phone.toString().replace(/\D/g, "");
// Remove India's country code if supplied
if (cleaned.startsWith("91") && cleaned.length === 12) {
cleaned = cleaned.substring(2);
}
return cleaned;
};
const isValidPhone = (phone) => {
return /^[6-9]\d{9}$/.test(phone);
};
// ======================================================
// REGISTER USER
// ======================================================
const registerUser = async (req, res) => {
try {
const {
fullName,
email,
password,
phone
} = req.body;
if (!fullName || !password || !phone) {
return res.status(400).json({
success: false,
message: "Please fill name, phone number and password"
});
}
if (password.length < 6) {
return res.status(400).json({
success: false,
message: "Password must be at least 6 characters"
});
}
const normalizedPhone = normalizePhone(phone);
if (!isValidPhone(normalizedPhone)) {
return res.status(400).json({
success: false,
message: "Please enter a valid Indian mobile number"
});
}
const normalizedEmail =
email?.trim()
? email.toLowerCase().trim()
: undefined;
// Check email only if provided
if (normalizedEmail) {
const existingEmail = await User.findOne({
email: normalizedEmail
});
if (existingEmail) {
return res.status(400).json({
success: false,
message: "User already exists with this email"
});
}
}
console.log("1️⃣ Checking phone:", normalizedPhone);
// Check phone
const existingPhone = await User.findOne({
phone: normalizedPhone
});
console.log("2️⃣ Phone check complete:", !!existingPhone);
if (existingPhone) {
return res.status(400).json({
success: false,
message: "User already exists with this phone number"
});
}
console.log("3️⃣ Hashing password...");
const hashedPassword = await bcrypt.hash(
password,
10
);
console.log("4️⃣ Password hashed");
// Generate OTP
const otp = generateOTP();
const hashedOTP = hashOTP(otp);
console.log("5️⃣ Creating user in MongoDB...");
const user = await User.create({
fullName: fullName.trim(),
email: normalizedEmail,
password: hashedPassword,
phone: normalizedPhone,
// New registrations require verification
phoneVerified: false,
phoneVerificationOTP: hashedOTP,
// OTP valid for 10 minutes
phoneVerificationOTPExpire:
Date.now() + 10 * 60 * 1000,
phoneVerificationOTPAttempts: 0,
phoneVerificationOTPResendAt: Date.now() + 60 * 1000
});
console.log("6️⃣ User created:", user._id);
// DEVELOPMENT MODE
if (
process.env.NODE_ENV === "development" &&
process.env.OTP_DELIVERY === "console"
) {
console.log("\n========================================");
console.log("LUX DEVELOPMENT OTP");
console.log("Phone:", normalizedPhone);
console.log("OTP:", otp);
console.log("Expires: 10 minutes");
console.log("========================================\n");
}
res.status(201).json({
success: true,
message:
"Registration successful. Please verify your phone number.",
requiresPhoneVerification: true,
phone: normalizedPhone
});
} catch (error) {
console.error("Register Error:", error);
// Duplicate phone/email protection
if (error.code === 11000) {
const duplicateField =
Object.keys(error.keyPattern || {})[0];
return res.status(400).json({
success: false,
message:
duplicateField === "phone"
? "Phone number already registered"
: "Email already registered"
});
}
res.status(500).json({
success: false,
message: "Something went wrong during registration"
});
}
};
// ======================================================
// VERIFY REGISTRATION OTP
// ======================================================
const verifyPhoneOTP = async (req, res) => {
try {
const { phone, otp } = req.body;
if (!phone || !otp) {
return res.status(400).json({
success: false,
message: "Phone number and OTP are required"
});
}
const normalizedPhone = normalizePhone(phone);
const user = await User.findOne({
phone: normalizedPhone
});
if (!user) {
return res.status(404).json({
success: false,
message: "User not found"
});
}
if (user.phoneVerified) {
return res.status(400).json({
success: false,
message: "Phone number is already verified"
});
}
if (
!user.phoneVerificationOTP ||
!user.phoneVerificationOTPExpire
) {
return res.status(400).json({
success: false,
message: "No active OTP. Please request a new OTP."
});
}
if (
user.phoneVerificationOTPExpire <
Date.now()
) {
return res.status(400).json({
success: false,
message: "OTP has expired. Please request a new OTP."
});
}
// Limit registration OTP attempts to 5.
if ((user.phoneVerificationOTPAttempts || 0) >= 5) {
return res.status(429).json({
success: false,
message: "Too many incorrect attempts. Please request a new OTP."
});
}
const hashedOTP = hashOTP(otp.toString());
if (hashedOTP !== user.phoneVerificationOTP) {
user.phoneVerificationOTPAttempts =
(user.phoneVerificationOTPAttempts || 0) + 1;
await user.save();
return res.status(400).json({
success: false,
message: "Invalid OTP"
});
}
// Verification successful
user.phoneVerified = true;
user.phoneVerificationOTP = null;
user.phoneVerificationOTPExpire = null;
user.phoneVerificationOTPAttempts = 0;
user.phoneVerificationOTPResendAt = Date.now() + 60 * 1000;
await user.save();
// Create login token
const token = jwt.sign(
{
id: user._id,
role: user.role
},
process.env.JWT_SECRET,
{
expiresIn: "7d"
}
);
res.status(200).json({
success: true,
message: "Phone number verified successfully",
token,
user: {
id: user._id,
fullName: user.fullName,
email: user.email,
phone: user.phone,
role: user.role
}
});
} catch (error) {
console.error(
"Verify Phone OTP Error:",
error
);
res.status(500).json({
success: false,
message: "Something went wrong"
});
}
};
// ======================================================
// RESEND REGISTRATION OTP
// ======================================================
const resendPhoneOTP = async (req, res) => {
try {
const { phone } = req.body;
if (!phone) {
return res.status(400).json({
success: false,
message: "Phone number is required"
});
}
const normalizedPhone = normalizePhone(phone);
const user = await User.findOne({
phone: normalizedPhone
});
if (!user) {
return res.status(404).json({
success: false,
message: "User not found"
});
}
if (user.phoneVerified) {
return res.status(400).json({
success: false,
message: "Phone number is already verified"
});
}
const now = Date.now();
if (user.phoneVerificationOTPResendAt && user.phoneVerificationOTPResendAt.getTime() > now) {
const retryAfterSeconds = Math.ceil((user.phoneVerificationOTPResendAt.getTime() - now) / 1000);
return res.status(429).json({
success: false,
message: "Please wait before requesting another OTP.",
retryAfterSeconds
});
}
const otp = generateOTP();
user.phoneVerificationOTP =
hashOTP(otp);
user.phoneVerificationOTPExpire =
Date.now() + 10 * 60 * 1000;
user.phoneVerificationOTPAttempts = 0;
user.phoneVerificationOTPResendAt = Date.now() + 60 * 1000;
await user.save();
if (
process.env.NODE_ENV === "development" &&
process.env.OTP_DELIVERY === "console"
) {
console.log("\n========================================");
console.log("LUX DEVELOPMENT OTP");
console.log("Phone:", normalizedPhone);
console.log("OTP:", otp);
console.log("Expires: 10 minutes");
console.log("========================================\n");
}
res.status(200).json({
success: true,
message: "A new OTP has been sent"
});
} catch (error) {
console.error(
"Resend OTP Error:",
error
);
res.status(500).json({
success: false,
message: "Something went wrong"
});
}
};
// ======================================================
// LOGIN USER
// ======================================================
const loginUser = async (req, res) => {
try {
const {
email,
phone,
identifier,
password
} = req.body;
const loginIdentifier =
identifier || email || phone;
if (!loginIdentifier || !password) {
return res.status(400).json({
success: false,
message:
"Please enter your email or phone and password"
});
}
let user;
const cleanedIdentifier =
loginIdentifier.toString().trim();
// If it looks like an email
if (cleanedIdentifier.includes("@")) {
user = await User.findOne({
email: cleanedIdentifier.toLowerCase()
});
} else {
const normalizedPhone =
normalizePhone(cleanedIdentifier);
user = await User.findOne({
phone: normalizedPhone
});
}
if (!user) {
return res.status(401).json({
success: false,
message: "User not found"
});
}
const isMatch = await bcrypt.compare(
password,
user.password
);
if (!isMatch) {
return res.status(401).json({
success: false,
message: "Invalid Password"
});
}
// New accounts must verify phone
if (user.phoneVerified === false) {
return res.status(403).json({
success: false,
message:
"Please verify your phone number before logging in",
requiresPhoneVerification: true,
phone: user.phone
});
}
const token = jwt.sign(
{
id: user._id,
role: user.role
},
process.env.JWT_SECRET,
{
expiresIn: "7d"
}
);
res.status(200).json({
success: true,
message: "Login Successful",
token,
user: {
id: user._id,
fullName: user.fullName,
email: user.email,
phone: user.phone,
role: user.role
}
});
} catch (error) {
console.error("Login Error:", error);
res.status(500).json({
success: false,
message: "Something went wrong"
});
}
};
// ======================================================
// FORGOT PASSWORD — EMAIL RESET
// ======================================================
const forgotPassword = async (req, res) => {
try {
const { email } = req.body;
if (!email) {
return res.status(400).json({
success: false,
message: "Please enter your email"
});
}
const user = await User.findOne({
email: email.toLowerCase().trim()
});
if (!user) {
return res.status(200).json({
success: true,
message:
"If an account exists with this email, a password reset link will be available."
});
}
const resetToken =
crypto.randomBytes(32).toString("hex");
const hashedToken =
crypto
.createHash("sha256")
.update(resetToken)
.digest("hex");
user.resetPasswordToken =
hashedToken;
user.resetPasswordExpire =
Date.now() + 15 * 60 * 1000;
await user.save();
const resetUrl =
`http://localhost:5173/reset-password/${resetToken}`;
console.log("\n========================================");
console.log("PASSWORD RESET LINK");
console.log(resetUrl);
console.log("========================================\n");
res.status(200).json({
success: true,
message:
"If an account exists with this email, a password reset link will be available.",
resetUrl
});
} catch (error) {
console.error(
"Forgot Password Error:",
error
);
res.status(500).json({
success: false,
message: "Something went wrong"
});
}
};
// ======================================================
// SEND PASSWORD RESET OTP — PHONE
// ======================================================
const sendPasswordResetOTP = async (req, res) => {
try {
const { phone } = req.body;
if (!phone) {
return res.status(400).json({
success: false,
message: "Please enter your phone number"
});
}
const normalizedPhone =
normalizePhone(phone);
const user = await User.findOne({
phone: normalizedPhone
});
// Don't reveal whether account exists
if (!user) {
return res.status(200).json({
success: true,
message:
"If an account exists with this phone number, an OTP will be sent."
});
}
const now = Date.now();
if (user.passwordResetOTPResendAt && user.passwordResetOTPResendAt.getTime() > now) {
return res.status(200).json({
success: true,
message: "If an account exists with this phone number, an OTP will be sent."
});
}
const otp = generateOTP();
user.passwordResetOTP =
hashOTP(otp);
user.passwordResetOTPExpire =
Date.now() + 10 * 60 * 1000;
user.passwordResetOTPAttempts = 0;
user.passwordResetOTPResendAt = Date.now() + 60 * 1000;
await user.save();
if (
process.env.NODE_ENV === "development" &&
process.env.OTP_DELIVERY === "console"
) {
console.log("\n========================================");
console.log("LUX DEVELOPMENT OTP");
console.log("Phone:", normalizedPhone);
console.log("OTP:", otp);
console.log("Expires: 10 minutes");
console.log("========================================\n");
}
res.status(200).json({
success: true,
message:
"If an account exists with this phone number, an OTP will be sent.",
phone: normalizedPhone
});
} catch (error) {
console.error(
"Password Reset OTP Error:",
error
);
res.status(500).json({
success: false,
message: "Something went wrong"
});
}
};
// ======================================================
// RESET PASSWORD USING PHONE OTP
// ======================================================
const resetPasswordWithOTP = async (req, res) => {
try {
const {
phone,
otp,
password
} = req.body;
if (!phone || !otp || !password) {
return res.status(400).json({
success: false,
message:
"Phone, OTP and new password are required"
});
}
if (password.length < 6) {
return res.status(400).json({
success: false,
message:
"Password must be at least 6 characters"
});
}
const normalizedPhone =
normalizePhone(phone);
const user = await User.findOne({
phone: normalizedPhone
});
if (!user) {
return res.status(400).json({
success: false,
message: "Invalid OTP"
});
}
if (
!user.passwordResetOTP ||
!user.passwordResetOTPExpire
) {
return res.status(400).json({
success: false,
message:
"No active reset OTP. Please request a new OTP."
});
}
if (
user.passwordResetOTPExpire <
Date.now()
) {
return res.status(400).json({
success: false,
message:
"OTP has expired. Please request a new OTP."
});
}
// Attempt protection
if (
user.passwordResetOTPAttempts >= 5
) {
return res.status(429).json({
success: false,
message:
"Too many incorrect attempts. Please request a new OTP."
});
}
const hashedOTP =
hashOTP(otp.toString());
if (
hashedOTP !== user.passwordResetOTP
) {
user.passwordResetOTPAttempts += 1;
await user.save();
return res.status(400).json({
success: false,
message: "Invalid OTP"
});
}
// OTP correct
user.password = await bcrypt.hash(password, 10);
user.passwordChangedAt = new Date();
user.passwordResetOTP = null;
user.passwordResetOTPExpire = null;
user.passwordResetOTPAttempts = 0;
await user.save();
res.status(200).json({
success: true,
message:
"Password reset successful. You can now login."
});
} catch (error) {
console.error(
"Reset Password OTP Error:",
error
);
res.status(500).json({
success: false,
message: "Something went wrong"
});
}
};
// ======================================================
// RESET PASSWORD — EXISTING EMAIL TOKEN
// ======================================================
const resetPassword = async (req, res) => {
try {
const { token } = req.params;
const { password } = req.body;
if (!password) {
return res.status(400).json({
success: false,
message:
"Please enter a new password"
});
}
if (password.length < 6) {
return res.status(400).json({
success: false,
message:
"Password must be at least 6 characters"
});
}
const hashedToken =
crypto
.createHash("sha256")
.update(token)
.digest("hex");
const user = await User.findOne({
resetPasswordToken: hashedToken,
resetPasswordExpire: {
$gt: Date.now()
}
});
if (!user) {
return res.status(400).json({
success: false,
message:
"Password reset link is invalid or has expired"
});
}
user.password = await bcrypt.hash(password, 10);
user.passwordChangedAt = new Date();
user.resetPasswordToken = null;
user.resetPasswordExpire = null;
await user.save();
res.status(200).json({
success: true,
message:
"Password reset successful. You can now login."
});
} catch (error) {
console.error(
"Reset Password Error:",
error
);
res.status(500).json({
success: false,
message: "Something went wrong"
});
}
};
// ======================================================
// EXPORT
// ======================================================
module.exports = {
registerUser,
verifyPhoneOTP,
resendPhoneOTP,
loginUser,
forgotPassword,
sendPasswordResetOTP,
resetPasswordWithOTP,
resetPassword
};
