const Order = require("../models/Order");
const User = require("../models/User");
const Menu = require("../models/Menu");
const Category = require("../models/Category");
const Table = require("../models/Table");
const Reservation = require("../models/Reservation");


// ======================================================
// ADMIN DASHBOARD
// ======================================================

const getDashboard = async (req, res) => {

    try {

        // ==================================================
        // Basic Counts
        // ==================================================

        const totalOrders =
            await Order.countDocuments();

        const totalCustomers =
            await User.countDocuments({
                role: "customer"
            });

        const totalMenuItems =
            await Menu.countDocuments();

        const totalCategories =
            await Category.countDocuments();


        // ==================================================
        // Order Status Counts
        // ==================================================

        const pendingOrders =
            await Order.countDocuments({
                orderStatus: "Pending"
            });

        const preparingOrders =
            await Order.countDocuments({
                orderStatus: "Preparing"
            });

        const deliveredOrders =
            await Order.countDocuments({
                orderStatus: "Delivered"
            });

        const cancelledOrders =
            await Order.countDocuments({
                orderStatus: "Cancelled"
            });


        // ==================================================
        // Total Revenue
        // ==================================================

        const revenue =
            await Order.aggregate([

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
            revenue.length > 0
                ? revenue[0].totalRevenue
                : 0;


        // ==================================================
        // Today's Revenue
        // ==================================================

        const startOfToday =
            new Date();

        startOfToday.setHours(
            0,
            0,
            0,
            0
        );


        const endOfToday =
            new Date();

        endOfToday.setHours(
            23,
            59,
            59,
            999
        );


        const todayRevenueResult =
            await Order.aggregate([

                {
                    $match: {

                        paymentStatus:
                            "Paid",

                        createdAt: {

                            $gte:
                                startOfToday,

                            $lte:
                                endOfToday

                        }

                    }
                },

                {
                    $group: {

                        _id: null,

                        revenue: {
                            $sum:
                                "$totalPrice"
                        }

                    }
                }

            ]);


        const todayRevenue =
            todayRevenueResult.length > 0
                ? todayRevenueResult[0].revenue
                : 0;


        // ==================================================
        // This Month Revenue
        // ==================================================

        const startOfMonth =
            new Date();

        startOfMonth.setDate(1);

        startOfMonth.setHours(
            0,
            0,
            0,
            0
        );


        const endOfMonth =
            new Date(
                startOfMonth.getFullYear(),
                startOfMonth.getMonth() + 1,
                0,
                23,
                59,
                59,
                999
            );


        const monthlyRevenueResult =
            await Order.aggregate([

                {
                    $match: {

                        paymentStatus:
                            "Paid",

                        createdAt: {

                            $gte:
                                startOfMonth,

                            $lte:
                                endOfMonth

                        }

                    }
                },

                {
                    $group: {

                        _id: null,

                        revenue: {
                            $sum:
                                "$totalPrice"
                        }

                    }
                }

            ]);


        const currentMonthRevenue =
            monthlyRevenueResult.length > 0
                ? monthlyRevenueResult[0].revenue
                : 0;


        // ==================================================
        // Recent Orders
        // ==================================================

        const recentOrders =
            await Order.find()

                .populate(
                    "user",
                    "fullName email"
                )

                .sort({
                    createdAt: -1
                })

                .limit(5);


        // ==================================================
        // Top Selling Items
        // ==================================================

        const topSellingItems =
            await Order.aggregate([

                {
                    $unwind:
                        "$items"
                },

                {
                    $group: {

                        _id:
                            "$items.menu",

                        quantitySold: {

                            $sum:
                                "$items.quantity"

                        }

                    }
                },

                {
                    $sort: {

                        quantitySold:
                            -1

                    }
                },

                {
                    $limit: 5
                },

                {
                    $lookup: {

                        from:
                            "menus",

                        localField:
                            "_id",

                        foreignField:
                            "_id",

                        as:
                            "menu"

                    }
                },

                {
                    $unwind:
                        "$menu"
                },

                {
                    $project: {

                        _id: 0,

                        name:
                            "$menu.name",

                        image:
                            "$menu.image",

                        quantitySold: 1

                    }

                }

            ]);


        // ==================================================
        // Monthly Revenue
        // ==================================================

        const monthlyRevenue =
            await Order.aggregate([

                {
                    $match: {

                        paymentStatus:
                            "Paid"

                    }
                },

                {
                    $group: {

                        _id: {

                            year: {
                                $year:
                                    "$createdAt"
                            },

                            month: {
                                $month:
                                    "$createdAt"
                            }

                        },

                        revenue: {

                            $sum:
                                "$totalPrice"

                        }

                    }
                },

                {
                    $sort: {

                        "_id.year":
                            1,

                        "_id.month":
                            1

                    }
                },

                {
                    $project: {

                        _id: 0,

                        year:
                            "$_id.year",

                        monthNumber:
                            "$_id.month",

                        revenue: 1

                    }

                }

            ]);


        // ==================================================
        // Month Names
        // ==================================================

        const monthNames = [

            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December"

        ];


        const formattedMonthlyRevenue =
            monthlyRevenue.map(
                item => ({

                    year:
                        item.year,

                    month:
                        monthNames[
                            item.monthNumber - 1
                        ],

                    revenue:
                        item.revenue

                })
            );


        // ==================================================
        // Orders By Status
        // ==================================================

        const ordersByStatus =
            await Order.aggregate([

                {
                    $group: {

                        _id:
                            "$orderStatus",

                        count: {

                            $sum: 1

                        }

                    }
                },

                {
                    $project: {

                        _id: 0,

                        status:
                            "$_id",

                        count: 1

                    }
                },

                {
                    $sort: {

                        count:
                            -1

                    }
                }

            ]);


        // ==================================================
        // Last 7 Days Revenue
        // ==================================================

        const sevenDaysAgo =
            new Date(
                Date.now() -
                7 * 24 * 60 * 60 * 1000
            );


        const last7DaysRevenue =
            await Order.aggregate([

                {
                    $match: {

                        paymentStatus:
                            "Paid",

                        createdAt: {

                            $gte:
                                sevenDaysAgo

                        }

                    }
                },

                {
                    $group: {

                        _id: {

                            $dateToString: {

                                format:
                                    "%Y-%m-%d",

                                date:
                                    "$createdAt"

                            }

                        },

                        revenue: {

                            $sum:
                                "$totalPrice"

                        },

                        orders: {

                            $sum: 1

                        }

                    }
                },

                {
                    $sort: {

                        _id:
                            1

                    }
                }

            ]);


        // ==================================================
        // LIVE TABLE DATA
        // ==================================================

        const tables =
            await Table.find()

                .sort({
                    tableNumber: 1
                })

                .lean();


        // ==================================================
        // ACTIVE / UPCOMING RESERVATIONS
        // ==================================================

        const activeReservations =
            await Reservation.find({

                status: {

                    $in: [
                        "Pending",
                        "Confirmed"
                    ]

                }

            })

                .populate(
                    "user",
                    "fullName email"
                )

                .populate(
                    "table",
                    "tableNumber capacity status"
                )

                .sort({

                    reservationDate:
                        1,

                    startTime:
                        1

                })

                .lean();

        // ==================================================
        // Final Dashboard Response
        // ==================================================

        res.status(200).json({

            success: true,

            dashboard: {

                // -------------------------------
                // Basic
                // -------------------------------

                totalOrders,

                totalCustomers,

                totalMenuItems,

                totalCategories,


                // -------------------------------
                // Orders
                // -------------------------------

                pendingOrders,

                preparingOrders,

                deliveredOrders,

                cancelledOrders,


                // -------------------------------
                // Revenue
                // -------------------------------

                totalRevenue,

                todayRevenue,

                currentMonthRevenue,


                // -------------------------------
                // Existing Dashboard Data
                // -------------------------------

                recentOrders,

                topSellingItems,

                monthlyRevenue:
                    formattedMonthlyRevenue,

                ordersByStatus,

                last7DaysRevenue,


                // -------------------------------
                // NEW
                // Restaurant Tables
                // -------------------------------

                tables,


                // -------------------------------
                // NEW
                // Reservations
                // -------------------------------

                activeReservations

            }

        });


    } catch (error) {

        console.error(
            "Dashboard Error:",
            error
        );


        res.status(500).json({

            success: false,

            message:
                error.message

        });

    }

};


// ======================================================
// EXPORT
// ======================================================

module.exports = {
    getDashboard
};