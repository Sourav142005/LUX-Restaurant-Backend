const {
    completeExpiredReservations
} = require("../controllers/reservationController");
const {
    processScheduledOrders
} = require("./scheduledOrderService");

// ======================================================
// Background Tasks Scheduler
// ======================================================

const runBackgroundTasks = async () => {
    // 1. Complete expired reservations
    try {
        await completeExpiredReservations();
    } catch (error) {
        console.error(
            "❌ Reservation scheduler error:",
            error
        );
    }

    // 2. Process scheduled orders
    try {
        await processScheduledOrders();
    } catch (error) {
        console.error(
            "❌ Scheduled orders processor error:",
            error
        );
    }
};

// Run immediately when server starts
runBackgroundTasks();

// Run every 60 seconds
setInterval(() => {
    runBackgroundTasks();
}, 60000);

module.exports = {
    runBackgroundTasks
};
