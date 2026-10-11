const User = require("../models/User");

// ======================================
// Get All Users - Admin Only
// ======================================

const getAllUsers = async (req, res) => {

    try {

        const users = await User.find()
            .select("-password")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: users.length,
            users
        });

    } catch (error) {

        console.error("Get Users Error:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

module.exports = {
    getAllUsers
};