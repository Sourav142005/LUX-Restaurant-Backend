const mongoose = require("mongoose");
const Review = require("../models/Review");
const Menu = require("../models/Menu");
const Order = require("../models/Order");

// ======================================================
// Helper: Recalculate Menu Average Rating and Review Count
// ======================================================
const recalculateMenuRating = async (menuId) => {
    try {
        const objectId = typeof menuId === "string" ? new mongoose.Types.ObjectId(menuId) : menuId;

        const stats = await Review.aggregate([
            {
                $match: { menu: objectId }
            },
            {
                $group: {
                    _id: "$menu",
                    avgRating: { $avg: "$rating" },
                    numReviews: { $sum: 1 }
                }
            }
        ]);

        if (stats.length > 0) {
            const roundedAvg = Math.round(stats[0].avgRating * 10) / 10;
            await Menu.findByIdAndUpdate(objectId, {
                rating: roundedAvg,
                numReviews: stats[0].numReviews
            });
            return { rating: roundedAvg, numReviews: stats[0].numReviews };
        } else {
            await Menu.findByIdAndUpdate(objectId, {
                rating: 0,
                numReviews: 0
            });
            return { rating: 0, numReviews: 0 };
        }
    } catch (err) {
        console.error("❌ Error recalculating menu rating:", err);
        throw err;
    }
};

// ======================================================
// GET /api/review/menu/:menuId (Public)
// ======================================================
const getMenuReviews = async (req, res) => {
    try {
        const { menuId } = req.params;

        if (!menuId || !mongoose.Types.ObjectId.isValid(menuId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid menu ID"
            });
        }

        const menu = await Menu.findById(menuId).select("name rating numReviews");
        if (!menu) {
            return res.status(404).json({
                success: false,
                message: "Menu item not found"
            });
        }

        // Only populate fullName on user to protect private customer data
        const reviews = await Review.find({ menu: menuId })
            .populate("user", "fullName")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: reviews.length,
            rating: menu.rating || 0,
            numReviews: menu.numReviews !== undefined ? menu.numReviews : reviews.length,
            reviews
        });
    } catch (error) {
        console.error("❌ Failed to fetch menu reviews:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to fetch reviews"
        });
    }
};

// ======================================================
// GET /api/review/my/:menuId (Authenticated)
// ======================================================
const getMyReviewForDish = async (req, res) => {
    try {
        const { menuId } = req.params;
        const userId = req.user?.id || req.user?._id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });
        }

        if (!menuId || !mongoose.Types.ObjectId.isValid(menuId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid menu ID"
            });
        }

        const review = await Review.findOne({ user: userId, menu: menuId });

        // Check if user has an eligible delivered order for this dish
        const eligibleOrder = await Order.findOne({
            user: userId,
            orderStatus: "Delivered",
            paymentStatus: { $in: ["Paid", "PartiallyRefunded"] },
            reconciliationRequired: { $ne: true },
            "items.menu": menuId
        }).sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            review: review || null,
            canReview: !!eligibleOrder,
            eligibleOrderId: eligibleOrder ? eligibleOrder._id : null
        });
    } catch (error) {
        console.error("❌ Failed to fetch customer review status:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to fetch review status"
        });
    }
};

// ======================================================
// POST /api/review (Authenticated Customer Create/Update)
// ======================================================
const createOrUpdateReview = async (req, res) => {
    try {
        const userId = req.user?.id || req.user?._id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });
        }

        const { menuId, menu, orderId, order, rating, comment } = req.body;

        const targetMenuId = menuId || menu;
        const targetOrderId = orderId || order;

        // 1. Validate Menu ID
        if (!targetMenuId || !mongoose.Types.ObjectId.isValid(targetMenuId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid or missing menu ID"
            });
        }

        const menuItem = await Menu.findById(targetMenuId);
        if (!menuItem) {
            return res.status(404).json({
                success: false,
                message: "Menu item not found"
            });
        }

        // 2. Validate Rating (integer 1-5)
        if (
            rating === undefined ||
            rating === null ||
            isNaN(rating) ||
            Number(rating) < 1 ||
            Number(rating) > 5
        ) {
            return res.status(400).json({
                success: false,
                message: "Rating must be a number between 1 and 5"
            });
        }
        const numericRating = Math.round(Number(rating));

        // 3. Validate Comment Length (max 500 chars)
        let trimmedComment = "";
        if (comment !== undefined && comment !== null) {
            if (typeof comment !== "string") {
                return res.status(400).json({
                    success: false,
                    message: "Comment must be a string"
                });
            }
            trimmedComment = comment.trim();
            if (trimmedComment.length > 500) {
                return res.status(400).json({
                    success: false,
                    message: "Review comment cannot exceed 500 characters"
                });
            }
        }

        // 4. Server-Side Purchase Verification
        let qualifyingOrder = null;

        if (targetOrderId) {
            if (!mongoose.Types.ObjectId.isValid(targetOrderId)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid order ID"
                });
            }

            const orderDoc = await Order.findById(targetOrderId);
            if (!orderDoc) {
                return res.status(404).json({
                    success: false,
                    message: "Order not found"
                });
            }

            // Check ownership
            if (orderDoc.user.toString() !== userId.toString()) {
                return res.status(403).json({
                    success: false,
                    message: "You do not own this order"
                });
            }

            // Check order contains dish
            const dishInOrder = orderDoc.items?.some(
                (item) => item.menu && item.menu.toString() === targetMenuId.toString()
            );
            if (!dishInOrder) {
                return res.status(400).json({
                    success: false,
                    message: "Order does not contain the specified dish"
                });
            }

            // Check order status is Delivered
            if (orderDoc.orderStatus !== "Delivered") {
                return res.status(400).json({
                    success: false,
                    message: "Only delivered orders can be reviewed"
                });
            }

            // Check payment status is eligible
            if (
                !["Paid", "PartiallyRefunded"].includes(orderDoc.paymentStatus) ||
                orderDoc.reconciliationRequired === true
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Order payment is not eligible for review"
                });
            }

            qualifyingOrder = orderDoc;
        } else {
            // Find any eligible order owned by the user containing the dish
            qualifyingOrder = await Order.findOne({
                user: userId,
                orderStatus: "Delivered",
                paymentStatus: { $in: ["Paid", "PartiallyRefunded"] },
                reconciliationRequired: { $ne: true },
                "items.menu": targetMenuId
            }).sort({ createdAt: -1 });

            if (!qualifyingOrder) {
                // Determine specific reason for clear rejection
                const anyOrder = await Order.findOne({
                    user: userId,
                    "items.menu": targetMenuId
                }).sort({ createdAt: -1 });

                if (!anyOrder) {
                    return res.status(403).json({
                        success: false,
                        message: "You can only review dishes you have purchased and received"
                    });
                }

                if (anyOrder.orderStatus !== "Delivered") {
                    return res.status(400).json({
                        success: false,
                        message: "Only delivered orders can be reviewed"
                    });
                }

                if (
                    !["Paid", "PartiallyRefunded"].includes(anyOrder.paymentStatus) ||
                    anyOrder.reconciliationRequired === true
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Order payment is not eligible for review"
                    });
                }

                return res.status(403).json({
                    success: false,
                    message: "You can only review dishes you have purchased and received"
                });
            }
        }

        // 5. Create or Update Review (enforcing one review per dish per customer)
        let review = await Review.findOne({ user: userId, menu: targetMenuId });
        let isUpdate = false;

        if (review) {
            isUpdate = true;
            review.rating = numericRating;
            if (comment !== undefined) {
                review.comment = trimmedComment;
            }
            review.order = qualifyingOrder._id;
            await review.save();
        } else {
            review = await Review.create({
                user: userId,
                menu: targetMenuId,
                order: qualifyingOrder._id,
                rating: numericRating,
                comment: trimmedComment
            });
        }

        // 6. Recalculate Menu Average Rating and Review Count
        const updatedStats = await recalculateMenuRating(targetMenuId);

        return res.status(isUpdate ? 200 : 201).json({
            success: true,
            message: isUpdate ? "Review updated successfully" : "Review submitted successfully",
            review,
            menuStats: updatedStats
        });
    } catch (error) {
        console.error("❌ Failed to create/update review:", error);

        // Handle possible duplicate key race condition gracefully
        if (error.code === 11000) {
            try {
                const targetMenuId = req.body.menuId || req.body.menu;
                const userId = req.user?.id || req.user?._id;
                const existing = await Review.findOne({ user: userId, menu: targetMenuId });
                if (existing) {
                    existing.rating = Math.round(Number(req.body.rating)) || existing.rating;
                    if (req.body.comment !== undefined) {
                        existing.comment = (req.body.comment || "").trim().slice(0, 500);
                    }
                    await existing.save();
                    const updatedStats = await recalculateMenuRating(targetMenuId);
                    return res.status(200).json({
                        success: true,
                        message: "Review updated successfully",
                        review: existing,
                        menuStats: updatedStats
                    });
                }
            } catch (innerErr) {
                // fall through to 500
            }
        }

        return res.status(500).json({
            success: false,
            message: error.message || "Failed to process review"
        });
    }
};

// ======================================================
// PUT /api/review/:id (Authenticated Customer Update)
// ======================================================
const updateReviewById = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id || req.user?._id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });
        }

        const { rating, comment } = req.body;

        if (!id || !mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid review ID"
            });
        }

        const review = await Review.findById(id);
        if (!review) {
            return res.status(404).json({
                success: false,
                message: "Review not found"
            });
        }

        // Enforce ownership: only author or admin may update
        if (review.user.toString() !== userId.toString() && req.user?.role !== "admin") {
            return res.status(403).json({
                success: false,
                message: "You can only edit your own reviews"
            });
        }

        // Verify user still has a qualifying purchase for this dish
        if (req.user?.role !== "admin") {
            const qualifyingOrder = await Order.findOne({
                user: review.user,
                orderStatus: "Delivered",
                paymentStatus: { $in: ["Paid", "PartiallyRefunded"] },
                reconciliationRequired: { $ne: true },
                "items.menu": review.menu
            });

            if (!qualifyingOrder) {
                return res.status(403).json({
                    success: false,
                    message: "You must have a qualifying delivered and paid order to update this review"
                });
            }
        }

        // Validate rating if provided
        if (rating !== undefined) {
            if (isNaN(rating) || Number(rating) < 1 || Number(rating) > 5) {
                return res.status(400).json({
                    success: false,
                    message: "Rating must be a number between 1 and 5"
                });
            }
            review.rating = Math.round(Number(rating));
        }

        // Validate comment if provided
        if (comment !== undefined) {
            if (typeof comment !== "string") {
                return res.status(400).json({
                    success: false,
                    message: "Comment must be a string"
                });
            }
            const trimmed = comment.trim();
            if (trimmed.length > 500) {
                return res.status(400).json({
                    success: false,
                    message: "Review comment cannot exceed 500 characters"
                });
            }
            review.comment = trimmed;
        }

        await review.save();

        const updatedStats = await recalculateMenuRating(review.menu);

        return res.status(200).json({
            success: true,
            message: "Review updated successfully",
            review,
            menuStats: updatedStats
        });
    } catch (error) {
        console.error("❌ Failed to update review:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to update review"
        });
    }
};

// ======================================================
// DELETE /api/review/:id (Author or Admin Delete)
// ======================================================
const deleteReview = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id || req.user?._id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });
        }

        if (!id || !mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid review ID"
            });
        }

        const review = await Review.findById(id);
        if (!review) {
            return res.status(404).json({
                success: false,
                message: "Review not found"
            });
        }

        // Enforce ownership: only author or admin may delete
        if (review.user.toString() !== userId.toString() && req.user?.role !== "admin") {
            return res.status(403).json({
                success: false,
                message: "You can only delete your own reviews"
            });
        }

        const menuId = review.menu;
        await Review.findByIdAndDelete(id);

        const updatedStats = await recalculateMenuRating(menuId);

        return res.status(200).json({
            success: true,
            message: "Review deleted successfully",
            menuStats: updatedStats
        });
    } catch (error) {
        console.error("❌ Failed to delete review:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to delete review"
        });
    }
};

module.exports = {
    recalculateMenuRating,
    getMenuReviews,
    getMyReviewForDish,
    createOrUpdateReview,
    updateReviewById,
    deleteReview
};
