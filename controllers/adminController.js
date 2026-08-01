const Order = require("../models/Order");
const User = require("../models/User");
const Menu = require("../models/Menu");
const Category = require("../models/Category");

const getDashboard = async (req, res) => {

    try {

        // Basic Counts
        const totalOrders = await Order.countDocuments();

        const totalCustomers = await User.countDocuments({
            role: "customer"
        });

        const totalMenuItems = await Menu.countDocuments();

        const totalCategories = await Category.countDocuments();

        // Order Status Counts
        const pendingOrders = await Order.countDocuments({
            orderStatus: "Pending"
        });

        const preparingOrders = await Order.countDocuments({
            orderStatus: "Preparing"
        });

        const deliveredOrders = await Order.countDocuments({
            orderStatus: "Delivered"
        });

        const cancelledOrders = await Order.countDocuments({
            orderStatus: "Cancelled"
        });

        // Revenue
        const revenue = await Order.aggregate([
            {
                $match: {
                    paymentStatus: "Paid"
                }
            },
            {
                $group: {
                    _id: null,
                    totalRevenue: {
                        $sum: "$totalPrice"
                    }
                }
            }
        ]);

        const totalRevenue =
            revenue.length > 0 ? revenue[0].totalRevenue : 0;

            const recentOrders = await Order.find()
    .populate("user", "fullName email")
    .sort({ createdAt: -1 })
    .limit(5);
        
    const topSellingItems = await Order.aggregate([
    {
        $unwind: "$items"
    },
    {
        $group: {
            _id: "$items.menu",
            quantitySold: {
                $sum: "$items.quantity"
            }
        }
    },
    {
        $sort: {
            quantitySold: -1
        }
    },
    {
        $limit: 5
    },
    {
        $lookup: {
            from: "menus",
            localField: "_id",
            foreignField: "_id",
            as: "menu"
        }
    },
    {
        $unwind: "$menu"
    },
    {
        $project: {
            _id: 0,
            name: "$menu.name",
            image: "$menu.image",
            quantitySold: 1
        }
    }
]);
const monthlyRevenue = await Order.aggregate([
    {
        $match: {
            paymentStatus: "Paid"
        }
    },
    {
        $group: {
            _id: {
                $month: "$createdAt"
            },
            revenue: {
                $sum: "$totalPrice"
            }
        }
    },
    {
        $sort: {
            _id: 1
        }
    },
    {
        $project: {
            _id: 0,
            month: {
                $switch: {
                    branches: [
                        { case: { $eq: ["$_id", 1] }, then: "January" },
                        { case: { $eq: ["$_id", 2] }, then: "February" },
                        { case: { $eq: ["$_id", 3] }, then: "March" },
                        { case: { $eq: ["$_id", 4] }, then: "April" },
                        { case: { $eq: ["$_id", 5] }, then: "May" },
                        { case: { $eq: ["$_id", 6] }, then: "June" },
                        { case: { $eq: ["$_id", 7] }, then: "July" },
                        { case: { $eq: ["$_id", 8] }, then: "August" },
                        { case: { $eq: ["$_id", 9] }, then: "September" },
                        { case: { $eq: ["$_id", 10] }, then: "October" },
                        { case: { $eq: ["$_id", 11] }, then: "November" },
                        { case: { $eq: ["$_id", 12] }, then: "December" }
                    ],
                    default: "Unknown"
                }
            },
            revenue: 1
        }
    }
]);

const ordersByStatus = await Order.aggregate([
    {
        $group: {
            _id: "$orderStatus",
            count: {
                $sum: 1
            }
        }
    },
    {
        $project: {
            _id: 0,
            status: "$_id",
            count: 1
        }
    },
    {
        $sort: {
            count: -1
        }
    }
]);

const last7DaysRevenue = await Order.aggregate([
    {
        $match: {
            paymentStatus: "Paid",
            createdAt: {
                $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
            }
        }
    },
    {
        $group: {
            _id: {
                $dateToString: {
                    format: "%Y-%m-%d",
                    date: "$createdAt"
                }
            },
            revenue: {
                $sum: "$totalPrice"
            },
            orders: {
                $sum: 1
            }
        }
    },
    {
        $sort: {
            _id: 1
        }
    }
]);
        

        res.status(200).json({
            success: true,
            dashboard: {
                totalOrders,
                pendingOrders,
                preparingOrders,
                deliveredOrders,
                cancelledOrders,
                totalRevenue,
                totalCustomers,
                totalMenuItems,
                totalCategories,
                recentOrders,
                topSellingItems,
                monthlyRevenue,
                ordersByStatus,
                last7DaysRevenue
            }
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

module.exports = {
    getDashboard
};