const Reservation = require("../models/Reservation");
const Table = require("../models/Table");

const {
    cancelReservationOrders
} = require("../services/orderCancellationService");


// ======================================================
// Helper: Convert Date To YYYY-MM-DD
// ======================================================

const getDateString = (date) => {

    const d = new Date(date);

    if (isNaN(d.getTime())) {
        return null;
    }

    return `${d.getFullYear()}-${String(
        d.getMonth() + 1
    ).padStart(2, "0")}-${String(
        d.getDate()
    ).padStart(2, "0")}`;
};


// ======================================================
// Helper: Check Whether Reservation Is Currently Active
// ======================================================

const isReservationActive = (reservation) => {

    if (!reservation?.reservationDate) {
        return false;
    }

    const reservationDate =
        getDateString(
            reservation.reservationDate
        );

    const today =
        getDateString(new Date());

    if (!reservationDate) {
        return false;
    }


    // Reservation was on an earlier day

    if (reservationDate < today) {
        return false;
    }


    // Reservation is on a future day

    if (reservationDate > today) {
        return false;
    }


    // Reservation is today

    const now = new Date();

    const currentTime =
        `${String(
            now.getHours()
        ).padStart(2, "0")}:${String(
            now.getMinutes()
        ).padStart(2, "0")}`;


    return (
        currentTime >=
            reservation.startTime &&

        currentTime <
            reservation.endTime
    );
};


// ======================================================
// Helper: Check Whether Reservation Is Upcoming
// ======================================================

const isReservationUpcoming = (
    reservation
) => {

    if (!reservation?.reservationDate) {
        return false;
    }

    const reservationDate =
        getDateString(
            reservation.reservationDate
        );

    const today =
        getDateString(new Date());

    if (!reservationDate) {
        return false;
    }


    // Future date

    if (reservationDate > today) {
        return true;
    }


    // Past date

    if (reservationDate < today) {
        return false;
    }


    // Same date

    const now = new Date();

    const currentTime =
        `${String(
            now.getHours()
        ).padStart(2, "0")}:${String(
            now.getMinutes()
        ).padStart(2, "0")}`;


    return (
        currentTime <
        reservation.startTime
    );
};


// ======================================================
// Synchronize Single Table Status
// ======================================================
//
// Reservation tables:
//     Active reservation
//          ↓
//       Occupied
//
//     Future reservation
//          ↓
//       Reserved
//
//     No reservation
//          ↓
//       Available
//
// Walk-In tables:
//     Status is controlled by the Walk-In order lifecycle.
//     Reservation synchronization must NEVER change them.
//
// ======================================================

const syncTableStatus = async (tableId) => {

    try {

        if (!tableId) {
            return;
        }


        // ==================================================
        // Find Table
        // ==================================================

        const table =
            await Table.findById(tableId);


        if (!table) {
            return;
        }


        // ==================================================
        // WALK-IN TABLE
        // ==================================================
        //
        // Walk-In tables are NOT controlled by reservations.
        //
        // Their status is controlled by the order lifecycle:
        //
        // Available
        //     ↓
        // Occupied
        //     ↓
        // Order Delivered / Cancelled / Deleted
        //     ↓
        // Available
        //
        // Therefore the reservation scheduler must leave
        // Walk-In tables completely untouched.
        //
        // ==================================================

        if (
            table.tableType === "Walk-In"
        ) {

            return;

        }


        // ==================================================
        // RESERVATION TABLE
        // ==================================================

        const reservations =
            await Reservation.find({

                table: tableId,

                status: "Confirmed"

            }).sort({

                reservationDate: 1,

                startTime: 1

            });


        // ==================================================
        // Check Active Reservation
        // ==================================================

        const activeReservation =
            reservations.find(
                (reservation) =>
                    isReservationActive(
                        reservation
                    )
            );


        // ==================================================
        // ACTIVE RESERVATION
        // ==================================================

        if (activeReservation) {

            if (
                table.status !==
                "Occupied"
            ) {

                table.status =
                    "Occupied";

                await table.save();

                console.log(
                    `🪑 Table ${table.tableNumber} → Occupied`
                );

            }

            return;

        }


        // ==================================================
        // Check Upcoming Reservation
        // ==================================================

        const upcomingReservation =
            reservations.find(
                (reservation) =>
                    isReservationUpcoming(
                        reservation
                    )
            );


        // ==================================================
        // UPCOMING RESERVATION
        // ==================================================

        if (upcomingReservation) {

            if (
                table.status !==
                "Reserved"
            ) {

                table.status =
                    "Reserved";

                await table.save();

                console.log(
                    `🪑 Table ${table.tableNumber} → Reserved`
                );

            }

            return;

        }


        // ==================================================
        // NO ACTIVE / UPCOMING RESERVATION
        // ==================================================

        if (
            table.status !==
            "Available"
        ) {

            table.status =
                "Available";

            await table.save();

            console.log(
                `🪑 Table ${table.tableNumber} → Available`
            );

        }

    } catch (error) {

        console.error(
            "❌ Table Status Sync Error:",
            error
        );

    }

};


// ======================================================
// Synchronize All Tables
// ======================================================

const synchronizeAllTables = async () => {

    try {

        const tables =
            await Table.find();


        for (
            const table
            of tables
        ) {

            await syncTableStatus(
                table._id
            );

        }


        console.log(
            "✅ Reservation/table synchronization completed"
        );


    } catch (error) {

        console.error(
            "❌ Reservation/table synchronization error:",
            error
        );

    }

};


// ======================================================
// Create Reservation
// ======================================================

const createReservation = async (
    req,
    res
) => {

    try {

        const {
            table,
            reservationDate,
            startTime,
            endTime,
            guests,
            notes
        } = req.body;


        // ==================================================
        // Basic Validation
        // ==================================================

        if (
            !table ||
            !reservationDate ||
            !startTime ||
            !endTime ||
            !guests
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Table, date, start time, end time and guests are required"

            });

        }


        // ==================================================
        // Validate Guests
        // ==================================================

        if (
            Number(guests) < 1
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Guests must be at least 1"

            });

        }


        // ==================================================
        // Find Table
        // ==================================================

        const selectedTable =
            await Table.findById(
                table
            );


        if (!selectedTable) {

            return res.status(404).json({

                success: false,

                message:
                    "Selected table not found"

            });

        }

        // ==================================================
        // Reservation Table Check
        // ==================================================
        //
        // Only tables marked as "Reservation" can be
        // booked through the reservation system.
        //
        // Walk-In tables cannot be reserved in advance.
        //

        if (selectedTable.tableType !== "Reservation") {

            return res.status(400).json({

                success: false,

                message:
                    "This table is reserved for walk-in customers"

            });

        }

        // ==================================================
        // Check Capacity
        // ==================================================

        if (
            Number(guests) >
            selectedTable.capacity
        ) {

            return res.status(400).json({

                success: false,

                message:
                    `This table can accommodate only ${selectedTable.capacity} guests`

            });

        }


        // ==================================================
        // Validate Time
        // ==================================================

        if (
            startTime >= endTime
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "End time must be after start time"

            });

        }


        // ==================================================
        // Validate Reservation Date
        // ==================================================

        const reservationDateTime =
            new Date(
                `${reservationDate}T${startTime}:00`
            );


        if (
            isNaN(
                reservationDateTime.getTime()
            )
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid reservation date or time"

            });

        }


        // ==================================================
        // Prevent Past Reservation
        // ==================================================

        const now = new Date();

        if (reservationDateTime.getTime() <= now.getTime()) {
            return res.status(400).json({
                success: false,
                message: "Reservation cannot be made in the past"
            });
        }


        // ==================================================
        // Check Overlapping Reservations
        // ==================================================

        const existingReservation =
            await Reservation.findOne({

                table,

                reservationDate:
                    new Date(
                        reservationDate
                    ),

                status: "Confirmed",

                $and: [

                    {
                        startTime: {
                            $lt: endTime
                        }
                    },

                    {
                        endTime: {
                            $gt: startTime
                        }
                    }

                ]

            });


        if (
            existingReservation
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "This table is already reserved for the selected time"

            });

        }


        // ==================================================
        // Create Reservation
        // ==================================================

        const reservation =
            await Reservation.create({

                user:
                    req.user.id,

                table,

                reservationDate:
                    new Date(
                        reservationDate
                    ),

                startTime,

                endTime,

                guests:
                    Number(
                        guests
                    ),

                notes:
                    notes || "",

                status:
                    "Pending"

            });


        // ==================================================
        // Synchronize Table
        // ==================================================

        await syncTableStatus(
            table
        );


        // ==================================================
        // Populate Table
        // ==================================================

        await reservation.populate(
            "table",
            "tableNumber capacity status"
        );


        // ==================================================
        // Response
        // ==================================================

        return res.status(201).json({

            success: true,

            message:
                "Reservation created successfully",

            reservation

        });


    } catch (error) {

        console.error(
            "Create Reservation Error:",
            error
        );


        return res.status(500).json({

            success: false,

            message:
                error.message

        });

    }

};


// ======================================================
// Get My Reservations
// ======================================================

const getMyReservations = async (
    req,
    res
) => {

    try {

        const reservations =
            await Reservation.find({

                user:
                    req.user.id

            })

            .populate(
                "table",
                "tableNumber capacity status tableType"
            )

            .sort({

                reservationDate: 1,

                startTime: 1

            });


        // ==================================================
        // Synchronize Tables
        // ==================================================

        for (
            const reservation
            of reservations
        ) {

            await syncTableStatus(
                reservation.table?._id
            );

        }


        // ==================================================
        // Re-fetch Updated Reservations
        // ==================================================

        const updatedReservations =
            await Reservation.find({

                user:
                    req.user.id

            })

            .populate(
                "table",
                "tableNumber capacity status tableType"
            )

            .sort({

                reservationDate: 1,

                startTime: 1

            });


        return res.status(200).json({

            success: true,

            count:
                updatedReservations.length,

            reservations:
                updatedReservations

        });


    } catch (error) {

        console.error(
            "Get My Reservations Error:",
            error
        );


        return res.status(500).json({

            success: false,

            message:
                error.message

        });

    }

};


// ======================================================
// Cancel Reservation
// ======================================================

const cancelReservation = async (
    req,
    res
) => {

    try {

        // ==================================================
        // Find Reservation
        // ==================================================

        const reservation =
            await Reservation.findById(
                req.params.id
            );


        if (!reservation) {

            return res.status(404).json({

                success: false,

                message:
                    "Reservation not found"

            });

        }


        // ==================================================
        // Ownership Check
        // ==================================================

        if (
            reservation.user.toString() !==
            req.user.id &&
            req.user.role !==
            "admin"
        ) {

            return res.status(403).json({

                success: false,

                message:
                    "Access denied"

            });

        }


        // ==================================================
        // Status Check
        // ==================================================

        if (
            reservation.status ===
            "Cancelled" ||

            reservation.status ===
            "Completed"
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Reservation cannot be cancelled"

            });

        }


        // ==================================================
        // Active Reservation Cannot Be Cancelled
        // ==================================================

        if (
            isReservationActive(
                reservation
            )
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Active reservation cannot be cancelled"

            });

        }


        // ==================================================
        // Cancel Associated Orders
        // ==================================================
        //
        // This will:
        //
        // Scheduled/Pending + unpaid
        //      → Cancel
        //
        // Scheduled/Pending + paid
        //      → Razorpay refund
        //      → Cancel
        //
        // Preparing/Ready/Delivered
        //      → Block cancellation
        //
        // ==================================================

        await cancelReservationOrders(
            reservation._id,
            "Reservation cancelled"
        );


        // ==================================================
        // Cancel Reservation
        // ==================================================

        reservation.status =
            "Cancelled";


        await reservation.save();


        // ==================================================
        // Synchronize Table
        // ==================================================

        await syncTableStatus(
            reservation.table
        );


        return res.status(200).json({

            success: true,

            message:
                "Reservation cancelled successfully",

            reservation

        });


    } catch (error) {

        console.error(
            "Cancel Reservation Error:",
            error
        );


        return res.status(
            error.statusCode || 500
        ).json({

            success: false,

            message:
                error.message

        });

    }

};


// ======================================================
// Get All Reservations - Admin
// ======================================================

const getAllReservations = async (
    req,
    res
) => {

    try {

        const reservations =
            await Reservation.find()

            .populate(
                "user",
                "fullName email phone"
            )

            .populate(
                "table",
                "tableNumber capacity status"
            )

            .sort({

                reservationDate: 1,

                startTime: 1

            });


        // ==================================================
        // Get Unique Table IDs
        // ==================================================

        const tableIds = [

            ...new Set(

                reservations

                    .map(
                        reservation =>
                            reservation.table?._id?.toString()
                    )

                    .filter(Boolean)

            )

        ];


        // ==================================================
        // Synchronize Tables
        // ==================================================

        for (
            const tableId
            of tableIds
        ) {

            await syncTableStatus(
                tableId
            );

        }


        // ==================================================
        // Re-fetch Updated Reservations
        // ==================================================

        const updatedReservations =
            await Reservation.find()

            .populate(
                "user",
                "fullName email phone"
            )

            .populate(
                "table",
                "tableNumber capacity status"
            )

            .sort({

                reservationDate: 1,

                startTime: 1

            });


        return res.status(200).json({

            success: true,

            count:
                updatedReservations.length,

            reservations:
                updatedReservations

        });


    } catch (error) {

        console.error(
            "Get All Reservations Error:",
            error
        );


        return res.status(500).json({

            success: false,

            message:
                error.message

        });

    }

};


// ======================================================
// Update Reservation Status - Admin
// ======================================================

const updateReservationStatus = async (
    req,
    res
) => {

    try {

        const {
            status
        } = req.body;


        // ==================================================
        // Valid Statuses
        // ==================================================

        const validStatuses = [

            "Pending",

            "Confirmed",

            "Cancelled",

            "Completed"

        ];


        if (
            !validStatuses.includes(status)
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid reservation status"

            });

        }


        // ==================================================
        // Find Reservation
        // ==================================================

        const reservation =
            await Reservation.findById(
                req.params.id
            );


        if (!reservation) {

            return res.status(404).json({

                success: false,

                message:
                    "Reservation not found"

            });

        }


        // ==================================================
        // Current Status
        // ==================================================

        const currentStatus =
            reservation.status;


        // ==================================================
        // Prevent Changes To Completed
        // ==================================================

        if (
            currentStatus ===
            "Completed"
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Completed reservation cannot be changed"

            });

        }


        // ==================================================
        // Prevent Reactivating Cancelled Reservation
        // ==================================================

        if (
            currentStatus ===
            "Cancelled"
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Cancelled reservation cannot be reactivated"

            });

        }


        // ==================================================
        // Pending Reservation
        // ==================================================

        if (
            currentStatus ===
            "Pending"
        ) {

            // ----------------------------------------------
            // Pending → Confirmed
            // ----------------------------------------------

            if (
                status ===
                "Confirmed"
            ) {

                // ==================================================
                // CHECK FOR TABLE TIME CONFLICT
                // ==================================================

                const conflictingReservation =
                    await Reservation.findOne({

                        // Same table
                        table: reservation.table,

                        // Same reservation date
                        reservationDate:
                            reservation.reservationDate,

                        // Ignore the reservation being confirmed
                        _id: {
                            $ne: reservation._id
                        },

                        // Only reservations that occupy the table
                        status:"Confirmed",

                        // Time overlap check
                        $and: [

                            {
                                startTime: {
                                    $lt:
                                        reservation.endTime
                                }
                            },

                            {
                                endTime: {
                                    $gt:
                                        reservation.startTime
                                }
                            }

                        ]

                    });


                // ==================================================
                // CONFLICT FOUND
                // ==================================================

                if (
                    conflictingReservation
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "This table is already reserved for the selected time"

                    });

                }


                // ==================================================
                // NO CONFLICT → CONFIRM
                // ==================================================

                reservation.status =
                    "Confirmed";

            }


            // ----------------------------------------------
            // Pending → Cancelled
            // ----------------------------------------------

            else if (
                status ===
                "Cancelled"
            ) {

                // Cancel associated Scheduled/Pending orders
                await cancelReservationOrders(
                    reservation._id,
                    "Reservation cancelled by admin"
                );

                reservation.status =
                    "Cancelled";

            }


            // ----------------------------------------------
            // Block Everything Else
            // ----------------------------------------------

            else {

                return res.status(400).json({

                    success: false,

                    message:
                        "Pending reservation can only be Confirmed or Cancelled"

                });

            }

        }


        // ==================================================
        // Confirmed Reservation
        // ==================================================

        else if (
            currentStatus ===
            "Confirmed"
        ) {

            // ----------------------------------------------
            // Confirmed → Cancelled
            // ----------------------------------------------

            if (
                status ===
                "Cancelled"
            ) {

                // Cancel associated Scheduled/Pending orders
                await cancelReservationOrders(
                    reservation._id,
                    "Reservation cancelled by admin"
                );

                reservation.status =
                    "Cancelled";

            }


            // ----------------------------------------------
            // Block Manual Completion
            // ----------------------------------------------

            else if (
                status ===
                "Completed"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Confirmed reservation is completed automatically after its end time"

                });

            }


            // ----------------------------------------------
            // Already Confirmed
            // ----------------------------------------------

            else if (
                status ===
                "Confirmed"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Reservation is already Confirmed"

                });

            }


            // ----------------------------------------------
            // Block Other Changes
            // ----------------------------------------------

            else {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid status change"

                });

            }

        }


        // ==================================================
        // Save Reservation
        // ==================================================

        await reservation.save();


        // ==================================================
        // Synchronize Table
        // ==================================================

        await syncTableStatus(
            reservation.table
        );


        // ==================================================
        // Populate User
        // ==================================================

        await reservation.populate(
            "user",
            "fullName email phone"
        );


        // ==================================================
        // Populate Table
        // ==================================================

        await reservation.populate(
            "table",
            "tableNumber capacity status"
        );


        // ==================================================
        // Response
        // ==================================================

        return res.status(200).json({

            success: true,

            message:
                "Reservation status updated",

            reservation

        });


    } catch (error) {

        console.error(
            "Update Reservation Status Error:",
            error
        );


        return res.status(
            error.statusCode || 500
        ).json({

            success: false,

            message:
                error.message

        });

    }

};


// ======================================================
// Get Available Tables
// GET /reservation/available
// ======================================================

const getAvailableTables = async (
    req,
    res
) => {

    try {

        const {
            reservationDate,
            startTime,
            endTime
        } = req.query;


        // ==================================================
        // Validate Query
        // ==================================================

        if (
            !reservationDate ||
            !startTime ||
            !endTime
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Date, start time and end time are required"

            });

        }


        // ==================================================
        // Validate Time
        // ==================================================

        if (
            startTime >= endTime
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "End time must be after start time"

            });

        }

        // Prevent checking availability for past reservations
        const reservationDateTime = new Date(
            `${reservationDate}T${startTime}:00`
        );

        if (isNaN(reservationDateTime.getTime())) {
            return res.status(400).json({
                success: false,
                message: "Invalid reservation date or time"
            });
        }

        if (reservationDateTime.getTime() <= Date.now()) {
            return res.status(400).json({
                success: false,
                message: "Please select a future reservation time"
            });
        }



        // ==================================================
        // Get All Tables
        // ==================================================

        const tables =
            await Table.find({
                tableType: "Reservation"
            })
                .sort({
                    tableNumber: 1
                });


        // ==================================================
        // Synchronize Table Status
        // ==================================================

        for (
            const table of tables
        ) {

            await syncTableStatus(
                table._id
            );

        }


        // ==================================================
        // Re-fetch Tables
        // ==================================================

        const updatedTables =
            await Table.find({
                tableType: "Reservation"
            })
                .sort({
                    tableNumber: 1
                });

        // ==================================================
        // Find Reservations That Overlap
        // ======================================================

        const reservations =
            await Reservation.find({

                reservationDate:
                    new Date(
                        reservationDate
                    ),

                status : "Confirmed",

                $and: [

                    {
                        startTime: {
                            $lt: endTime
                        }
                    },

                    {
                        endTime: {
                            $gt: startTime
                        }
                    }

                ]

            }).select("table");


        // ==================================================
        // Get IDs Of Tables Having Overlapping Reservations
        // ==================================================

        const reservedTableIds =
            reservations
                .map(
                    reservation =>
                        reservation.table
                            ?.toString()
                )
                .filter(Boolean);


        // ==================================================
        // Mark Availability
        // ==================================================
        //
        // IMPORTANT:
        //
        // Do NOT use:
        //
        // table.status === "Occupied"
        //
        // because a table can be occupied RIGHT NOW but
        // become available for a reservation later.
        //
        // Example:
        //
        // Current table status:
        // Occupied
        //
        // Existing reservation:
        // 10:30 → 11:17
        //
        // Requested reservation:
        // 11:20 → 11:59
        //
        // This IS available.
        //
        // ==================================================

        const tablesWithAvailability =
            updatedTables.map(
                table => {

                    const isBooked =
                        reservedTableIds.includes(
                            table._id.toString()
                        );


                    return {

                        ...table.toObject(),

                        isAvailable:
                            !isBooked

                    };

                }
            );


        // ==================================================
        // Response
        // ==================================================

        return res.status(200).json({

            success: true,

            tables:
                tablesWithAvailability

        });


    } catch (error) {

        console.error(
            "Get Available Tables Error:",
            error
        );


        return res.status(500).json({

            success: false,

            message:
                error.message

        });

    }

};


// ======================================================
// Automatically complete expired reservations
// ======================================================

const completeExpiredReservations = async () => {

    try {

        // Get all reservations that are still active

        const activeReservations =
            await Reservation.find({

                status: "Confirmed"

            });


        // Current time

        const now = new Date();


        for (
            const reservation
            of activeReservations
        ) {

            // --------------------------------------------------
            // Build reservation end date + time
            // --------------------------------------------------

            const reservationDate =
                new Date(
                    reservation.reservationDate
                );


            const year =
                reservationDate.getFullYear();


            const month =
                reservationDate.getMonth();


            const day =
                reservationDate.getDate();


            // Convert "12:30" into hours and minutes

            const [
                hours,
                minutes
            ] =
                reservation.endTime
                    .split(":")
                    .map(Number);


            const reservationEnd =
                new Date(
                    year,
                    month,
                    day,
                    hours,
                    minutes,
                    0,
                    0
                );


            // --------------------------------------------------
            // Check whether reservation has ended
            // --------------------------------------------------

            if (
                now >=
                reservationEnd
            ) {

                // ----------------------------------------------
                // Mark reservation as completed
                // ----------------------------------------------

                reservation.status =
                    "Completed";


                await reservation.save();


                // ----------------------------------------------
                // Update table status
                // ----------------------------------------------

                if (
                    reservation.table
                ) {

                    await syncTableStatus(
                        reservation.table
                    );

                }


                console.log(
                    `Reservation ${reservation._id} automatically completed`
                );

            }

        }


    } catch (error) {

        console.error(
            "Complete Expired Reservations Error:",
            error
        );

    }

};


// ======================================================
// Export
// ======================================================

module.exports = {

    createReservation,

    getMyReservations,

    cancelReservation,

    getAllReservations,

    updateReservationStatus,

    getAvailableTables,

    synchronizeAllTables,

    completeExpiredReservations

};