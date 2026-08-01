const express = require("express");
const router = express.Router();

const {
    createOrder,
    getMyOrders,
    getOrderById,
    updateOrderStatus,
    deleteOrder,
    cancelOrder
    
} = require("../controllers/orderController");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

// Customer
router.post("/", auth, createOrder);
router.get("/my", auth, getMyOrders);
router.get("/:id", auth, getOrderById);
router.patch("/:id/cancel", auth, cancelOrder);

// Admin
router.put("/:id", auth, admin, updateOrderStatus);
router.delete("/:id", auth, admin, deleteOrder);

module.exports = router;