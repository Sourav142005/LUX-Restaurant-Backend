const auth = require("../middleware/auth");
const express = require("express");
const router = express.Router();

// console.log("Auth Middleware:", auth);
// console.log("Type:", typeof auth);

const {
    registerUser,
    loginUser
} = require("../controllers/authController");

router.post("/register", registerUser);

router.post("/login", loginUser);

router.get("/profile", auth, (req, res) => {

    res.json({
        success: true,
        message: "Profile Loaded Successfully",
        user: req.user
    });

});

const admin = require("../middleware/admin");

router.get("/admin-test", auth, admin, (req, res) => {
    res.json({
        success: true,
        message: "Welcome Admin!"
    });
});

module.exports = router;