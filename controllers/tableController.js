const Table = require("../models/Table");
const Reservation = require("../models/Reservation");

// =========================================
// Helper: Convert Date To YYYY-MM-DD
// =========================================

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


// =========================================
// Helper: Check Active Reservation
// =========================================

const isReservationActive = (reservation) => {

    if (!reservation?.reservationDate) {
        return false;
    }

    const reservationDate =
        getDateString(reservation.reservationDate);

    const today =
        getDateString(new Date());

    if (!reservationDate) {
        return false;
    }

    // Reservation is from a previous day
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
        currentTime >= reservation.startTime &&
        currentTime < reservation.endTime
    );
};


// =========================================
// Helper: Check Upcoming Reservation
// =========================================

const isReservationUpcoming = (reservation) => {

    if (!reservation?.reservationDate) {
        return false;
    }

    const reservationDate =
        getDateString(reservation.reservationDate);

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

    return currentTime < reservation.startTime;
};


// =========================================
// Get All Tables
// =========================================

const getTables = async (req, res) => {

    try {

        const tables =
            await Table.find()
                .sort({
                    tableNumber: 1
                });

        return res.status(200).json({

            success: true,

            count: tables.length,

            tables

        });

    } catch (error) {

        return res.status(500).json({

            success: false,

            message: error.message

        });

    }

};


// =========================================
// Create Table
// =========================================

const createTable = async (req, res) => {

    try {

        const {
            tableNumber,
            capacity,
            tableType
        } = req.body;


        // =========================================
        // Basic Validation
        // =========================================

        if (!tableNumber || !capacity) {

            return res.status(400).json({

                success: false,

                message:
                    "Table number and capacity are required"

            });

        }


        // =========================================
        // Validate Table Type
        // =========================================

        const allowedTableTypes = [
            "Reservation",
            "Walk-In"
        ];


        if (
            !allowedTableTypes.includes(
                tableType
            )
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid table type"

            });

        }


        // =========================================
        // Check Existing Table
        // =========================================

        const existingTable =
            await Table.findOne({
                tableNumber
            });


        if (existingTable) {

            return res.status(400).json({

                success: false,

                message:
                    "Table already exists"

            });

        }


        // =========================================
        // Create Table
        // =========================================

        const table =
            await Table.create({

                tableNumber,

                capacity,

                tableType

            });


        // =========================================
        // Response
        // =========================================

        return res.status(201).json({

            success: true,

            message:
                "Table created successfully",

            table

        });

    } catch (error) {

        console.error(
            "Create Table Error:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                error.message

        });

    }

};


// =========================================
// Update Table Status
// =========================================

const updateTableStatus = async (req, res) => {

    try {

        const { status } = req.body;


        // =========================================
        // Validate Status
        // =========================================

        const allowedStatuses = [
            "Available",
            "Occupied",
            "Reserved"
        ];


        if (
            !allowedStatuses.includes(status)
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid table status"

            });

        }


        // =========================================
        // Find Table
        // =========================================

        const table =
            await Table.findById(
                req.params.id
            );


        if (!table) {

            return res.status(404).json({

                success: false,

                message:
                    "Table not found"

            });

        }


        // =========================================
        // RESERVATION TABLE PROTECTION
        // =========================================
        //
        // Reservation tables are controlled by the
        // reservation system.
        //
        // Admin should NOT manually make an active
        // or upcoming reservation table Available.
        //
        // The reservation scheduler will release the
        // table automatically.
        //
        // =========================================

        if (
            table.tableType === "Reservation"
        ) {

            const reservations =
                await Reservation.find({

                    table: table._id,

                    status: {
                        $in: [
                            "Pending",
                            "Confirmed"
                        ]
                    }

                });


            // =========================================
            // Check Active Reservation
            // =========================================

            const activeReservation =
                reservations.find(
                    (reservation) =>
                        isReservationActive(
                            reservation
                        )
                );


            if (
                activeReservation &&
                status === "Available"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "This table has an active reservation and cannot be released manually"

                });

            }


            // =========================================
            // Check Upcoming Reservation
            // =========================================

            const upcomingReservation =
                reservations.find(
                    (reservation) =>
                        isReservationUpcoming(
                            reservation
                        )
                );


            if (
                upcomingReservation &&
                status === "Available"
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "This table has an upcoming reservation and cannot be made Available manually"

                });

            }

        }


        // =========================================
        // Update Status
        // =========================================

        table.status = status;

        await table.save();


        // =========================================
        // Response
        // =========================================

        return res.status(200).json({

            success: true,

            message:
                "Table status updated successfully",

            table

        });

    } catch (error) {

        console.error(
            "Update Table Status Error:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                error.message

        });

    }

};


// =========================================
// Delete Table
// =========================================

const deleteTable = async (req, res) => {

    try {

        // =========================================
        // Find Table
        // =========================================

        const table =
            await Table.findById(
                req.params.id
            );


        if (!table) {

            return res.status(404).json({

                success: false,

                message:
                    "Table not found"

            });

        }


        // =========================================
        // Prevent Deleting Occupied Table
        // =========================================

        if (table.status === "Occupied") {
            return res.status(400).json({
                success: false,
                message:
                    "Occupied table cannot be deleted"
            });
        }


        // =========================================
        // Prevent Deleting Active / Upcoming
        // Reservation Table
        // =========================================

        if (table.tableType === "Reservation") {

            const reservations =
                await Reservation.find({
                    table: table._id,
                    status: {
                        $in: [
                            "Pending",
                            "Confirmed"
                        ]
                    }
                });

            const hasActiveOrUpcoming =
                reservations.some(
                    (reservation) =>
                        isReservationActive(reservation) ||
                        isReservationUpcoming(reservation)
                );

            if (hasActiveOrUpcoming) {
                return res.status(400).json({
                    success: false,
                    message:
                        "This table has an active or upcoming reservation and cannot be deleted"
                });
            }
        }


        // =========================================
        // Delete Table
        // =========================================

        await Table.findByIdAndDelete(
            req.params.id
        );


        return res.status(200).json({

            success: true,

            message:
                "Table deleted successfully"

        });

    } catch (error) {

        console.error(
            "Delete Table Error:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                error.message

        });

    }

};


// =========================================
// Export
// =========================================

module.exports = {

    getTables,

    createTable,

    updateTableStatus,

    deleteTable

};