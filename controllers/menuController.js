const Menu = require("../models/Menu");
const Category = require("../models/Category");
const Order = require("../models/Order");

const getMenu = async (req, res) => {

    try {

        const menus = await Menu.find().populate("category");

        res.status(200).json({
            success: true,
            count: menus.length,
            menus
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });
        

    }

};

const getMenuById = async (req, res) => {

    try {

        const { id } = req.params;

        const menu = await Menu.findById(id).populate("category");

        if (!menu) {
            return res.status(404).json({
                success: false,
                message: "Menu not found"
            });
        }

        res.status(200).json({
            success: true,
            menu
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};
const updateMenu = async (req, res) => {

    try {

        const { id } = req.params;

        if (req.body.specialStartDate !== undefined || req.body.specialEndDate !== undefined) {
            const currentMenu = await Menu.findById(id);
            if (!currentMenu) {
                return res.status(404).json({
                    success: false,
                    message: "Menu not found"
                });
            }

            let parsedStart = undefined;
            if (req.body.specialStartDate !== undefined) {
                try {
                    parsedStart = parseSpecialDate(req.body.specialStartDate, false);
                    req.body.specialStartDate = parsedStart;
                } catch {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid start date format"
                    });
                }
            }

            let parsedEnd = undefined;
            if (req.body.specialEndDate !== undefined) {
                try {
                    parsedEnd = parseSpecialDate(req.body.specialEndDate, true);
                    req.body.specialEndDate = parsedEnd;
                } catch {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid end date format"
                    });
                }
            }

            const effectiveStart = parsedStart !== undefined ? parsedStart : currentMenu.specialStartDate;
            const effectiveEnd = parsedEnd !== undefined ? parsedEnd : currentMenu.specialEndDate;

            if (effectiveStart && effectiveEnd && effectiveEnd < effectiveStart) {
                return res.status(400).json({
                    success: false,
                    message: "End date cannot be earlier than start date"
                });
            }
        }

        const updatedMenu = await Menu.findByIdAndUpdate(
            id,
            req.body,
            {
                new: true
            }
        ).populate("category");

        if (!updatedMenu) {
            return res.status(404).json({
                success: false,
                message: "Menu not found"
            });
        }

        res.status(200).json({
            success: true,
            message: "Menu updated successfully",
            menu: updatedMenu
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

const deleteMenu = async (req, res) => {

    try {

        const { id } = req.params;

        const menu = await Menu.findByIdAndDelete(id);

        if (!menu) {
            return res.status(404).json({
                success: false,
                message: "Menu not found"
            });
        }

        res.status(200).json({
            success: true,
            message: "Menu deleted successfully"
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

const createMenu = async (req, res) => {

    try {

        const {
            name,
            description,
            price,
            category,
            image,
            model3D,
            isVeg,
            preparationTime,
            isSeasonalSpecial,
            specialStartDate,
            specialEndDate
        } = req.body;

        // Step 1: Validation
        if (!name || !description || !price || !category) {
            return res.status(400).json({
                success: false,
                message: "Please fill all required fields"
            });
        }

        let parsedStart = null;
        if (specialStartDate) {
            try {
                parsedStart = parseSpecialDate(specialStartDate, false);
            } catch {
                return res.status(400).json({
                    success: false,
                    message: "Invalid start date format"
                });
            }
        }

        let parsedEnd = null;
        if (specialEndDate) {
            try {
                parsedEnd = parseSpecialDate(specialEndDate, true);
            } catch {
                return res.status(400).json({
                    success: false,
                    message: "Invalid end date format"
                });
            }
        }

        if (parsedStart && parsedEnd && parsedEnd < parsedStart) {
            return res.status(400).json({
                success: false,
                message: "End date cannot be earlier than start date"
            });
        }

        // Step 2: Check if menu already exists
        const existingMenu = await Menu.findOne({ name });

        if (existingMenu) {
            return res.status(400).json({
                success: false,
                message: "Menu already exists"
            });
        }

        // Step 3: Check if category exists
        const existingCategory = await Category.findById(category);

        if (!existingCategory) {
            return res.status(404).json({
                success: false,
                message: "Category not found"
            });
        }

        // Step 4: Create menu
        const menu = await Menu.create({
            name,
            description,
            price,
            category,
            image: image || "",
            model3D: model3D || "",
            isVeg: isVeg ?? true,
            preparationTime: preparationTime || 15,
            isSeasonalSpecial: Boolean(isSeasonalSpecial),
            specialStartDate: parsedStart,
            specialEndDate: parsedEnd
        });

        res.status(201).json({
            success: true,
            message: "Menu item created successfully",
            menu
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

// ======================================================
// Most Ordered Dishes (Last 7 Days)
// GET /api/menu/most-ordered
// ======================================================
const getMostOrderedDishes = async (req, res) => {

    try {

        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const pipeline = [
            // 1. Filter eligible orders in rolling 7-day window
            {
                $match: {
                    createdAt: { $gte: sevenDaysAgo },
                    orderStatus: { $ne: "Cancelled" },
                    paymentStatus: { $in: ["Paid", "PartiallyRefunded"] },
                    reconciliationRequired: { $ne: true }
                }
            },
            // 2. Unwind items
            {
                $unwind: "$items"
            },
            // 3. Group by dish and sum total quantities ordered
            {
                $group: {
                    _id: "$items.menu",
                    totalQuantityOrdered: { $sum: "$items.quantity" },
                    orderCount: { $sum: 1 }
                }
            },
            // 4. Exclude missing references
            {
                $match: {
                    _id: { $ne: null }
                }
            },
            // 5. Sort by popularity (totalQuantityOrdered descending)
            {
                $sort: {
                    totalQuantityOrdered: -1,
                    orderCount: -1
                }
            },
            // 6. Join menu collection
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
            // 7. Exclude unavailable dishes
            {
                $match: {
                    "menu.isAvailable": true
                }
            },
            // 8. Populate category
            {
                $lookup: {
                    from: "categories",
                    localField: "menu.category",
                    foreignField: "_id",
                    as: "menu.category"
                }
            },
            {
                $unwind: {
                    path: "$menu.category",
                    preserveNullAndEmptyArrays: true
                }
            },
            // 9. Limit to top 10
            {
                $limit: 10
            },
            // 10. Project final dish shape matching MenuCard requirements
            {
                $project: {
                    _id: "$menu._id",
                    name: "$menu.name",
                    description: "$menu.description",
                    price: "$menu.price",
                    category: "$menu.category",
                    image: "$menu.image",
                    model3D: "$menu.model3D",
                    isVeg: "$menu.isVeg",
                    isAvailable: "$menu.isAvailable",
                    preparationTime: "$menu.preparationTime",
                    rating: "$menu.rating",
                    totalQuantityOrdered: 1,
                    orderCount: 1
                }
            }
        ];

        const dishes = await Order.aggregate(pipeline);

        return res.status(200).json({
            success: true,
            count: dishes.length,
            timeWindow: "7d",
            dishes
        });

    } catch (error) {

        console.error("❌ Failed to fetch most ordered dishes:", error);

        return res.status(500).json({
            success: false,
            message: error.message || "Failed to fetch most ordered dishes"
        });

    }

};


// Helper: parse special dates in restaurant timezone (Asia/Kolkata)
const parseSpecialDate = (dateVal, isEnd = false) => {
    if (dateVal === null || dateVal === undefined || dateVal === "") {
        return null;
    }
    if (typeof dateVal === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateVal.trim())) {
        const timeSuffix = isEnd ? "T23:59:59.999+05:30" : "T00:00:00.000+05:30";
        const d = new Date(dateVal.trim() + timeSuffix);
        if (isNaN(d.getTime())) {
            const err = new Error("Invalid date format");
            err.status = 400;
            throw err;
        }
        return d;
    }
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) {
        const err = new Error("Invalid date format");
        err.status = 400;
        throw err;
    }
    return d;
};

// ======================================================
// Seasonal Specials
// GET /api/menu/seasonal-specials
// ======================================================
const getSeasonalSpecials = async (req, res) => {

    try {

        const now = new Date();

        const query = {
            isSeasonalSpecial: true,
            isAvailable: true,
            $and: [
                {
                    $or: [
                        { specialStartDate: null },
                        { specialStartDate: { $exists: false } },
                        { specialStartDate: { $lte: now } }
                    ]
                },
                {
                    $or: [
                        { specialEndDate: null },
                        { specialEndDate: { $exists: false } },
                        { specialEndDate: { $gte: now } }
                    ]
                }
            ]
        };

        const specials = await Menu.find(query).populate("category").sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: specials.length,
            specials
        });

    } catch (error) {

        console.error("❌ Failed to fetch seasonal specials:", error);

        return res.status(500).json({
            success: false,
            message: error.message || "Failed to fetch seasonal specials"
        });

    }

};

// ======================================================
// Update Seasonal Special (Admin only)
// PUT /api/menu/:id/seasonal-special
// ======================================================
const updateSeasonalSpecial = async (req, res) => {

    try {

        const { id } = req.params;
        const { isSeasonalSpecial, specialStartDate, specialEndDate } = req.body;

        const menu = await Menu.findById(id);

        if (!menu) {
            return res.status(404).json({
                success: false,
                message: "Menu not found"
            });
        }

        let parsedStart = undefined;
        if (specialStartDate !== undefined) {
            try {
                parsedStart = parseSpecialDate(specialStartDate, false);
            } catch {
                return res.status(400).json({
                    success: false,
                    message: "Invalid start date format"
                });
            }
        }

        let parsedEnd = undefined;
        if (specialEndDate !== undefined) {
            try {
                parsedEnd = parseSpecialDate(specialEndDate, true);
            } catch {
                return res.status(400).json({
                    success: false,
                    message: "Invalid end date format"
                });
            }
        }

        const effectiveStart = parsedStart !== undefined ? parsedStart : menu.specialStartDate;
        const effectiveEnd = parsedEnd !== undefined ? parsedEnd : menu.specialEndDate;

        if (effectiveStart && effectiveEnd && effectiveEnd < effectiveStart) {
            return res.status(400).json({
                success: false,
                message: "End date cannot be earlier than start date"
            });
        }

        if (typeof isSeasonalSpecial === "boolean") {
            menu.isSeasonalSpecial = isSeasonalSpecial;
        } else if (isSeasonalSpecial !== undefined) {
            menu.isSeasonalSpecial = Boolean(isSeasonalSpecial);
        }

        if (parsedStart !== undefined) {
            menu.specialStartDate = parsedStart;
        }

        if (parsedEnd !== undefined) {
            menu.specialEndDate = parsedEnd;
        }

        await menu.save();
        if (typeof menu.populate === "function") {
            await menu.populate("category");
        }

        return res.status(200).json({
            success: true,
            message: "Seasonal special updated successfully",
            menu
        });

    } catch (error) {

        console.error("❌ Failed to update seasonal special:", error);

        return res.status(500).json({
            success: false,
            message: error.message || "Failed to update seasonal special"
        });

    }

};

module.exports = {
    getMenu,
    getMenuById,
    getMostOrderedDishes,
    getSeasonalSpecials,
    updateSeasonalSpecial,
    createMenu,
    updateMenu,
    deleteMenu
};