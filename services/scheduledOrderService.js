const Order = require("../models/Order");
const Table = require("../models/Table");
const Reservation = require("../models/Reservation");

// ======================================================
// Helper: Get Current Local Date
// ======================================================

const getCurrentDateString = () => {
    const now = new Date();

    return `${now.getFullYear()}-${String(
        now.getMonth() + 1
    ).padStart(2, "0")}-${String(
        now.getDate()
    ).padStart(2, "0")}`;
};

// ======================================================
// Helper: Get Current Local Time
// ======================================================

const getCurrentTimeString = () => {
    const now = new Date();

    return `${String(
        now.getHours()
    ).padStart(2, "0")}:${String(
        now.getMinutes()
    ).padStart(2, "0")}`;
};

// ======================================================
// Helper: Get Reservation Date
//
// Reservation dates are stored as Date objects.
// We use UTC date components because the frontend
// also interprets reservationDate using UTC.
// ======================================================

const getReservationDateString = (reservationDate) => {
    const date = new Date(reservationDate);

    return `${date.getUTCFullYear()}-${String(
        date.getUTCMonth() + 1
    ).padStart(2, "0")}-${String(
        date.getUTCDate()
    ).padStart(2, "0")}`;
};

// ======================================================
// Process Scheduled Orders
// ======================================================

const processScheduledOrders = async () => {
    try {
        // ==================================================
        // Current Date & Time
        // ==================================================

        const currentDate = getCurrentDateString();
        const currentTime = getCurrentTimeString();

        console.log(
            `🕐 Scheduled order check: ${currentDate} ${currentTime}`
        );

        // ==================================================
        // Find Scheduled Orders
        // ==================================================

        const scheduledOrders = await Order.find({
            orderStatus: "Scheduled",
            reservation: { $ne: null }
        });

        console.log(
            `📋 Scheduled orders found: ${scheduledOrders.length}`
        );

        let activatedCount = 0;

        // ==================================================
        // Process Each Scheduled Order
        // ==================================================

        for (const order of scheduledOrders) {
            try {
                // ==========================================
                // Find Reservation
                // ==========================================

                const reservation =
                    await Reservation.findById(
                        order.reservation
                    );

                if (!reservation) {
                    console.log(
                        `⚠️ Reservation not found for order ${order._id}`
                    );

                    continue;
                }

                // ==========================================
                // Reservation Must Be Confirmed
                // ==========================================

                if (
                    reservation.status !== "Confirmed"
                ) {
                    console.log(
                        `⏭️ Reservation ${reservation._id} is not confirmed`
                    );

                    continue;
                }

                // ==========================================
                // Reservation Must Have Table
                // ==========================================

                if (!reservation.table) {
                    console.log(
                        `⚠️ No table assigned to reservation ${reservation._id}`
                    );

                    continue;
                }

                // ==========================================
                // Reservation Date
                // ==========================================

                const reservationDateString =
                    getReservationDateString(
                        reservation.reservationDate
                    );

                // ==========================================
                // Compare Reservation Date
                // ==========================================

                // Reservation is from a previous day
                if (
                    reservationDateString <
                    currentDate
                ) {
                    console.log(
                        `⏭️ Reservation ${reservation._id} is from the past`
                    );

                    continue;
                }

                // Reservation is on a future day
                if (
                    reservationDateString >
                    currentDate
                ) {
                    console.log(
                        `⏳ Reservation ${reservation._id} is upcoming`
                    );

                    continue;
                }

                // ==========================================
                // Reservation is TODAY
                // ==========================================

                // Check whether current time is inside
                // reservation start/end time.
                const isActive =
                    currentTime >=
                        reservation.startTime &&
                    currentTime <
                        reservation.endTime;

                if (!isActive) {
                    console.log(
                        `⏳ Reservation ${reservation._id} is not active yet`
                    );

                    continue;
                }

                // ==========================================
                // Find Table
                // ==========================================

                const table =
                    await Table.findById(
                        reservation.table
                    );

                if (!table) {
                    console.log(
                        `⚠️ Table not found for reservation ${reservation._id}`
                    );

                    continue;
                }

                // ==========================================
                // Check Table Status
                // ==========================================

                if (
                    table.status !== "Available" &&
                    table.status !== "Reserved"
                ) {
                    console.log(
                        `⚠️ Table ${table.tableNumber} is currently ${table.status}`
                    );

                    continue;
                }

                // ==========================================
                // Activate Order
                // ==========================================

                order.orderStatus = "Pending";
                order.table = table._id;

                await order.save();

                // ==========================================
                // Occupy Table
                // ==========================================

                table.status = "Occupied";

                await table.save();

                activatedCount++;

                console.log(
                    `✅ Scheduled Order ${order._id} activated`
                );

            } catch (orderError) {
                console.error(
                    `❌ Error processing scheduled order ${order._id}:`,
                    orderError
                );
            }
        }

        // ==================================================
        // Complete
        // ==================================================

        console.log(
            `✅ Scheduled order check complete. Activated: ${activatedCount}`
        );

        return activatedCount;

    } catch (error) {
        console.error(
            "❌ Scheduled Order Processing Error:",
            error
        );

        return 0;
    }
};

// ======================================================
// Export
// ======================================================

module.exports = {
    processScheduledOrders
};