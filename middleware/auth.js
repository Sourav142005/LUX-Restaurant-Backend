const jwt = require("jsonwebtoken");
const User = require("../models/User");

const auth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Missing or invalid Authorization header"
            });
        }

        const token = authHeader.slice(7).trim();
        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Invalid token"
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.id) {
            return res.status(401).json({
                success: false,
                message: "Invalid token payload"
            });
        }

        const user = await User.findById(decoded.id).select("-password");
        if (!user) {
            return res.status(401).json({
                success: false,
                message: "User no longer exists"
            });
        }

        // Reject tokens issued before the recorded password change.
        if (
            user.passwordChangedAt &&
            decoded.iat &&
            Math.floor(user.passwordChangedAt.getTime() / 1000) > decoded.iat
        ) {
            return res.status(401).json({
                success: false,
                message: "Password changed. Please log in again."
            });
        }

        req.user = {
            ...decoded,
            role: user.role
        };

        return next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: "Invalid or expired token"
        });
    }
};

module.exports = auth;
