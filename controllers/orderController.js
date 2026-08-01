const Order = require("../models/Order");
const Menu = require("../models/Menu");

// ===============================
// Create Order
// ===============================
const createOrder = async (req, res) => {

    try {

        const { items, orderType } = req.body;

        // Validation
        if (!items || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Order must contain at least one item"
            });
        }

        let totalPrice = 0;
        const orderItems = [];

        // Process each menu item
        for (const item of items) {

            const menu = await Menu.findById(item.menu);

            if (!menu) {
                return res.status(404).json({
                    success: false,
                    message: "Menu item not found"
                });
            }

            totalPrice += menu.price * item.quantity;

            orderItems.push({
                menu: menu._id,
                quantity: item.quantity,
                price: menu.price
            });

        }

        // Create Order
        const order = await Order.create({
            user: req.user.id,
            items: orderItems,
            totalPrice,
            orderType
        });

        res.status(201).json({
            success: true,
            message: "Order placed successfully",
            order
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

// ===============================
// Get Logged-in User Orders
// ===============================
const getMyOrders = async (req, res) => {

    try {

        const orders = await Order.find({
            user: req.user.id
        })
            .populate("items.menu", "name price image")
            .sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            count: orders.length,
            orders
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

// ===============================
// Get Order By ID
// ===============================
const getOrderById = async (req, res) => {

    try {

        const order = await Order.findById(req.params.id)
            .populate("user", "-password")
            .populate("items.menu");

        if (!order) {
            return res.status(404).json({
                success: false,
                message: "Order not found"
            });
        }

        // Only owner or admin can access
        if (
            order.user._id.toString() !== req.user.id &&
            req.user.role !== "admin"
        ) {
            return res.status(403).json({
                success: false,
                message: "Access denied"
            });
        }

        res.status(200).json({
            success: true,
            order
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

// ===============================
// Update Order Status (Admin)
// ===============================
const updateOrderStatus = async (req, res) => {

    try {

        const { orderStatus } = req.body;

        const validStatus = [
            "Pending",
            "Preparing",
            "Ready",
            "Delivered",
            "Cancelled"
        ];

        if (!validStatus.includes(orderStatus)) {
            return res.status(400).json({
                success: false,
                message: "Invalid order status"
            });
        }

        const order = await Order.findByIdAndUpdate(
            req.params.id,
            { orderStatus },
            {
                new: true,
                runValidators: true
            }
        )
            .populate("user", "-password")
            .populate("items.menu");

        if (!order) {
            return res.status(404).json({
                success: false,
                message: "Order not found"
            });
        }

        res.status(200).json({
            success: true,
            message: "Order status updated successfully",
            order
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

// ===============================
// Delete Order (Admin)
// ===============================
const deleteOrder = async (req, res) => {

    try {

        const order = await Order.findByIdAndDelete(req.params.id);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: "Order not found"
            });
        }

        res.status(200).json({
            success: true,
            message: "Order deleted successfully"
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};
// ===============================
// Cancel Order
// ===============================
const cancelOrder = async (req, res) => {
    try {

    const orderId = req.params.id;

        const order = await Order.findById(orderId);


        if (!order) {
        return res.status(404).json({
            success: false,
            message: "Order not found"
        });
        }

        if (order.user.toString() !== req.user.id) {
            return res.status(403).json({
            success: false,
            message: "Access denied"
            });
        }
        if (order.orderStatus !== "Pending") {
            return res.status(400).json({
                success: false,
                message: "Only pending orders can be cancelled"
            });
        }

        order.orderStatus = "Cancelled";

        await order.save();

        return res.status(200).json({
            success: true,
            message: "Order cancelled successfully",
            order
        });
        } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

const getAllOrders = async (req, res) => {
    try {
        const orders = await Order.find()
            .populate("user", "fullName email")
            .populate("items.menu", "name price image")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: orders.length,
            orders
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};
// ===============================
// Export Controllers
// ===============================
module.exports = {
    createOrder,
    getMyOrders,
    getOrderById,
    updateOrderStatus,
    deleteOrder,
    cancelOrder,
    getAllOrders
};