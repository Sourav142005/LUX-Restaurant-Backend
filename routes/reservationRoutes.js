const express = require("express");

const router = express.Router();

const {
    createReservation,
    getMyReservations,
    cancelReservation,
    getAllReservations,
    updateReservationStatus,
    getAvailableTables
} = require("../controllers/reservationController");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");


// =====================================
// Customer Routes
// =====================================

// Check table availability
router.get(
    "/available",
    auth,
    getAvailableTables
);

// Create reservation
router.post(
    "/",
    auth,
    createReservation
);

// Get logged-in user's reservations
router.get(
    "/my",
    auth,
    getMyReservations
);

// Cancel reservation
router.patch(
    "/:id/cancel",
    auth,
    cancelReservation
);


// =====================================
// Admin Routes
// =====================================

// Get all reservations
router.get(
    "/",
    auth,
    admin,
    getAllReservations
);

// Update reservation status
router.put(
    "/:id/status",
    auth,
    admin,
    updateReservationStatus
);


module.exports = router;