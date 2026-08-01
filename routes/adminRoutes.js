const express = require("express");
const router = express.Router();

const { getDashboard } = require("../controllers/adminController");
const { getAllOrders } = require("../controllers/orderController");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

router.get("/dashboard", auth, admin, getDashboard);
router.get("/orders", auth, admin, getAllOrders);

module.exports = router;