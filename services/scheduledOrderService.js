const OrderModel = require("../models/Order");
const TableModel = require("../models/Table");
const ReservationModel = require("../models/Reservation");

// ======================================================
// IST Timezone Helpers (Asia/Kolkata)
// ======================================================

const getISTDateString = (date = new Date()) => {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date);
};

const getISTTimeString = (date = new Date()) => {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).format(date);
};

const getReservationDateString = (reservationDate) => {
    if (!reservationDate) return "";

    if (
        typeof reservationDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(reservationDate)
    ) {
        return reservationDate;
    }

    const date = new Date(reservationDate);

    if (isNaN(date.getTime())) return "";

    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date);
};

// ======================================================
// In-process Concurrency Lock
// ======================================================

let isProcessing = false;

// ======================================================
// Process Scheduled Orders
// ======================================================

const processScheduledOrders = async (options = {}) => {
    if (isProcessing) {
        console.log("⏳ Scheduled order processing is already in progress, skipping.");
        return 0;
    }

    isProcessing = true;

    try {
        const {
            nowDate = new Date(),
            Order = OrderModel,
            Table = TableModel,
            Reservation = ReservationModel
        } = options;

        const currentDate = getISTDateString(nowDate);
        const currentTime = getISTTimeString(nowDate);

        console.log(
            `🕐 Scheduled order check (IST): ${currentDate} ${currentTime}`
        );

        // Find Scheduled orders with an associated reservation
        const scheduledOrders = await Order.find({
            orderStatus: "Scheduled",
            reservation: { $ne: null }
        });

        console.log(
            `📋 Scheduled orders found: ${scheduledOrders.length}`
        );

        let activatedCount = 0;

        for (const order of scheduledOrders) {
            try {
                // Must still be Scheduled
                if (order.orderStatus !== "Scheduled") {
                    console.log(`⏭️ Order ${order._id} is no longer Scheduled (${order.orderStatus})`);
                    continue;
                }

                // Payment Policy Validation
                const policy = order.paymentPolicy || "PayNow";

                if (policy === "PayAfterDining") {
                    // PayAfterDining is only valid for Dine-In
                    if (order.orderType !== "Dine-In") {
                        console.log(
                            `⚠️ Order ${order._id} has PayAfterDining policy but is not Dine-In (${order.orderType}). Skipping.`
                        );
                        continue;
                    }

                    // Must not be failed or refunded
                    if (["Failed", "Refunded"].includes(order.paymentStatus)) {
                        console.log(
                            `⚠️ Order ${order._id} has paymentStatus ${order.paymentStatus}. Skipping.`
                        );
                        continue;
                    }
                } else {
                    // PayNow orders MUST have paymentStatus === "Paid" or "PartiallyRefunded"
                    if (!["Paid", "PartiallyRefunded"].includes(order.paymentStatus)) {
                        console.log(
                            `⏳ Order ${order._id} is PayNow with paymentStatus ${order.paymentStatus}. Awaiting payment.`
                        );
                        continue;
                    }
                }

                // Reservation lookup
                const reservation = await Reservation.findById(order.reservation);

                if (!reservation) {
                    console.log(`⚠️ Reservation not found for order ${order._id}`);
                    continue;
                }

                // Reservation must be Confirmed
                if (reservation.status !== "Confirmed") {
                    console.log(`⏭️ Reservation ${reservation._id} is not confirmed (${reservation.status})`);
                    continue;
                }

                // Must have table assigned
                if (!reservation.table) {
                    console.log(`⚠️ No table assigned to reservation ${reservation._id}`);
                    continue;
                }

                // Date comparison (IST)
                const reservationDateString = getReservationDateString(reservation.reservationDate);

                if (reservationDateString < currentDate) {
                    console.log(`⏭️ Reservation ${reservation._id} is from the past (${reservationDateString} < ${currentDate})`);
                    continue;
                }

                if (reservationDateString > currentDate) {
                    console.log(`⏳ Reservation ${reservation._id} is upcoming (${reservationDateString} > ${currentDate})`);
                    continue;
                }

                // Time window check (IST)
                const isActive =
                    currentTime >= reservation.startTime &&
                    currentTime < reservation.endTime;

                if (!isActive) {
                    console.log(
                        `⏳ Reservation ${reservation._id} is not active yet (Window: ${reservation.startTime}-${reservation.endTime}, Now: ${currentTime})`
                    );
                    continue;
                }

                // Table lookup
                const table = await Table.findById(reservation.table);

                if (!table) {
                    console.log(`⚠️ Table not found for reservation ${reservation._id}`);
                    continue;
                }

                // Table status validity
                if (!["Available", "Reserved", "Occupied"].includes(table.status)) {
                    console.log(`⚠️ Table ${table.tableNumber} has unsupported status: ${table.status}`);
                    continue;
                }

                // If table is Occupied, check for conflicting reservation
                if (table.status === "Occupied") {
                    const conflictingReservation = await Reservation.findOne({
                        _id: { $ne: reservation._id },
                        table: table._id,
                        status: "Confirmed",
                        reservationDate: reservation.reservationDate,
                        startTime: { $lte: currentTime },
                        endTime: { $gt: currentTime }
                    });

                    if (conflictingReservation) {
                        console.log(
                            `⚠️ Table ${table.tableNumber} is occupied by conflicting reservation ${conflictingReservation._id}`
                        );
                        continue;
                    }
                }

                // Atomic transition from Scheduled to Pending
                const updatedOrder = await Order.findOneAndUpdate(
                    {
                        _id: order._id,
                        orderStatus: "Scheduled"
                    },
                    {
                        $set: {
                            orderStatus: "Pending",
                            table: table._id
                        }
                    },
                    {
                        new: true
                    }
                );

                if (!updatedOrder) {
                    console.log(
                        `⏭️ Order ${order._id} was already activated or state changed concurrently`
                    );
                    continue;
                }

                // Update table status with atomic conditional update and rollback protection
                try {
                    const updatedTable = await Table.findOneAndUpdate(
                        {
                            _id: table._id,
                            status: { $in: ["Available", "Reserved", "Occupied"] }
                        },
                        {
                            $set: {
                                status: "Occupied"
                            }
                        },
                        {
                            new: true
                        }
                    );

                    if (!updatedTable) {
                        throw new Error(
                            `Table ${table._id} is no longer in a valid state to occupy`
                        );
                    }
                } catch (tableError) {
                    console.error(
                        `❌ Failed to update table ${table._id} for order ${order._id}, rolling back order status:`,
                        tableError
                    );

                    try {
                        const rolledBackOrder = await Order.findOneAndUpdate(
                            {
                                _id: order._id,
                                orderStatus: "Pending"
                            },
                            {
                                $set: {
                                    orderStatus: "Scheduled",
                                    table: null
                                }
                            }
                        );

                        if (rolledBackOrder) {
                            console.log(`🔄 Successfully rolled back order ${order._id} to Scheduled`);
                        } else {
                            console.log(
                                `⚠️ Order ${order._id} status was already updated concurrently; rollback skipped`
                            );
                        }
                    } catch (rollbackError) {
                        console.error(
                            `❌ CRITICAL: Failed to rollback order ${order._id} status:`,
                            rollbackError
                        );
                    }

                    continue;
                }

                activatedCount++;
                console.log(`✅ Scheduled Order ${order._id} activated`);

            } catch (orderError) {
                console.error(
                    `❌ Error processing scheduled order ${order._id}:`,
                    orderError
                );
            }
        }

        console.log(
            `✅ Scheduled order check complete. Activated: ${activatedCount}`
        );

        return activatedCount;

    } catch (error) {
        console.error("❌ Scheduled Order Processing Error:", error);
        return 0;
    } finally {
        isProcessing = false;
    }
};

module.exports = {
    processScheduledOrders,
    getISTDateString,
    getISTTimeString,
    getReservationDateString
};
