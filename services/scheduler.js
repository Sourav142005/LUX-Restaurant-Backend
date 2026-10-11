const {
    completeExpiredReservations
} = require("../controllers/reservationController");


// ======================================================
// Reservation Scheduler
// ======================================================

const runReservationScheduler = async () => {

    try {

        await completeExpiredReservations();

    } catch (error) {

        console.error(
            "❌ Reservation scheduler error:",
            error
        );

    }

};


// Run immediately when server starts
runReservationScheduler();


// Run every 60 seconds
setInterval(() => {

    runReservationScheduler();

}, 60000);