const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");

const {
    getMenuReviews,
    getMyReviewForDish,
    createOrUpdateReview,
    updateReviewById,
    deleteReview
} = require("../controllers/reviewController");

// Public: View all reviews for a dish
router.get("/menu/:menuId", getMenuReviews);

// Authenticated: Get customer's own review & purchase eligibility for a dish
router.get("/my/:menuId", auth, getMyReviewForDish);

// Authenticated: Submit or update a review (one review per user per dish)
router.post("/", auth, createOrUpdateReview);

// Authenticated: Update review by ID
router.put("/:id", auth, updateReviewById);

// Authenticated: Delete review by ID (Author or Admin)
router.delete("/:id", auth, deleteReview);

module.exports = router;

