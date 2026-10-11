const Order = require("../models/Order");
const Menu = require("../models/Menu");
const Table = require("../models/Table");
const Reservation = require("../models/Reservation");

const Razorpay = require("razorpay");
const crypto = require("crypto");

const {
    processScheduledOrders:
        processScheduledOrdersService
} = require("../services/scheduledOrderService");


// ======================================================
// Razorpay Configuration
// ======================================================

if (
    !process.env.RAZORPAY_KEY_ID ||
    !process.env.RAZORPAY_KEY_SECRET
) {
    console.error(
        "❌ Razorpay keys are missing from .env"
    );
} else {
    console.log(
        "✅ Razorpay keys loaded"
    );
}


const razorpay = new Razorpay({
    key_id:
        process.env.RAZORPAY_KEY_ID,

    key_secret:
        process.env.RAZORPAY_KEY_SECRET
});


// ======================================================
// Create Order
// POST /order
// ======================================================

const createOrder = async (
    req,
    res
) => {

    try {

        const {
            items,
            orderType,
            reservation,
            table
        } = req.body;


        // ==================================================
        // Validate Items
        // ==================================================

        if (
            !items ||
            !Array.isArray(items) ||
            items.length === 0
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Order must contain at least one item"

            });

        }


        let totalPrice = 0;

        const orderItems = [];


        // ==================================================
        // Process Menu Items
        // ==================================================

        for (const item of items) {

            if (
                !item.menu ||
                !item.quantity ||
                item.quantity < 1
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid order item"

                });

            }


            const menu =
                await Menu.findById(
                    item.menu
                );


            if (!menu) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Menu item not found"

                });

            }


            // --------------------------------------------------
            // Check Menu Availability
            // --------------------------------------------------

            if (
                menu.isAvailable === false
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        `${menu.name} is currently unavailable`

                });

            }


            // --------------------------------------------------
            // Calculate Total
            // --------------------------------------------------

            totalPrice +=
                menu.price *
                item.quantity;


            orderItems.push({

                menu:
                    menu._id,

                quantity:
                    item.quantity,

                price:
                    menu.price

            });

        }


        // ==================================================
        // Validate Order Type
        // ==================================================

        const validOrderTypes = [
            "Dine-In",
            "Takeaway",
            "Delivery"
        ];


        if (
            !validOrderTypes.includes(
                orderType
            )
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid order type"

            });

        }


        // ==================================================
        // Reservation / Table
        // ==================================================

        let selectedTable = null;

        let selectedReservation = null;

        let isActiveReservation = false;


        // ==================================================
        // DINE-IN ORDER
        // ==================================================

        if (
            orderType === "Dine-In"
        ) {


            // ==================================================
            // RESERVATION CUSTOMER
            // ==================================================

            if (reservation) {

                // --------------------------------------------------
                // Find Reservation
                // --------------------------------------------------

                selectedReservation =
                    await Reservation.findOne({

                        _id:
                            reservation,

                        user:
                            req.user.id,

                        status:
                            "Confirmed"

                    });


                if (!selectedReservation) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Selected reservation is not valid or confirmed"

                    });

                }


                // --------------------------------------------------
                // Reservation Must Have Table
                // --------------------------------------------------

                if (
                    !selectedReservation.table
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Your reservation does not have a table assigned"

                    });

                }


                // --------------------------------------------------
                // Find Reserved Table
                // --------------------------------------------------

                selectedTable =
                    await Table.findById(
                        selectedReservation.table
                    );


                if (!selectedTable) {

                    return res.status(404).json({

                        success: false,

                        message:
                            "Reserved table not found"

                    });

                }


                // --------------------------------------------------
                // Ensure Table Is Reservation Table
                // --------------------------------------------------

                if (
                    selectedTable.tableType !==
                    "Reservation"
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "This table is not assigned to reservation customers"

                    });

                }


                // ==================================================
                // Determine Current Date & Time
                // ==================================================

                const now =
                    new Date();


                const currentDate =
                    `${now.getFullYear()}-${String(
                        now.getMonth() + 1
                    ).padStart(2, "0")}-${String(
                        now.getDate()
                    ).padStart(2, "0")}`;


                const currentTime =
                    `${String(
                        now.getHours()
                    ).padStart(2, "0")}:${String(
                        now.getMinutes()
                    ).padStart(2, "0")}`;


                // --------------------------------------------------
                // Reservation Date
                // --------------------------------------------------

                const reservationDate =
                    new Date(
                        selectedReservation.reservationDate
                    );


                const reservationDateString =
                    `${reservationDate.getUTCFullYear()}-${String(
                        reservationDate.getUTCMonth() + 1
                    ).padStart(2, "0")}-${String(
                        reservationDate.getUTCDate()
                    ).padStart(2, "0")}`;


                // ==================================================
                // Check If Reservation Is Active
                // ==================================================

                isActiveReservation =
                    reservationDateString ===
                        currentDate &&

                    currentTime >=
                        selectedReservation.startTime &&

                    currentTime <
                        selectedReservation.endTime;


                // --------------------------------------------------
                // Future Reservation
                // --------------------------------------------------

                if (
                    !isActiveReservation
                ) {

                    // Keep reservation reference,
                    // but don't attach table to order yet.

                    selectedTable = null;

                }

            }


            // ==================================================
            // WALK-IN CUSTOMER
            // ==================================================

            else {

                // --------------------------------------------------
                // Walk-In Table Required
                // --------------------------------------------------

                if (!table) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Please select a table for your walk-in order"

                    });

                }


                // --------------------------------------------------
                // Find Walk-In Table
                // --------------------------------------------------

                selectedTable =
                    await Table.findOne({

                        _id:
                            table,

                        tableType:
                            "Walk-In",

                        status:
                            "Available"

                    });


                if (!selectedTable) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Selected table is not available for walk-in customers"

                    });

                }


                // --------------------------------------------------
                // Walk-In Orders Are Immediately Active
                // --------------------------------------------------

                isActiveReservation =
                    false;

            }

        }


        // ==================================================
        // Determine Initial Order Status
        // ==================================================

        let initialOrderStatus =
            "Pending";


        // Reservation order for future time
        // becomes Scheduled.

        if (
            orderType === "Dine-In" &&
            selectedReservation &&
            !isActiveReservation
        ) {

            initialOrderStatus =
                "Scheduled";

        }


        // ==================================================
        // Create Order
        // ==================================================

        const order =
            await Order.create({

                user:
                    req.user.id,

                items:
                    orderItems,

                totalPrice,

                orderStatus:
                    initialOrderStatus,

                paymentStatus:
                    "Pending",

                orderType,

                table:
                    selectedTable
                        ? selectedTable._id
                        : null,

                reservation:
                    selectedReservation
                        ? selectedReservation._id
                        : null

            });


        // ==================================================
        // OCCUPY TABLE
        // ==================================================

        // --------------------------------------------------
        // Walk-In Customer
        // --------------------------------------------------

        if (
            orderType === "Dine-In" &&
            !selectedReservation &&
            selectedTable
        ) {

            const occupiedTable =
                await Table.findOneAndUpdate(
                    {
                        _id: selectedTable._id,
                        tableType: "Walk-In",
                        status: "Available"
                    },
                    {
                        $set: {
                            status: "Occupied"
                        }
                    },
                    {
                        new: true,
                        runValidators: true
                    }
                );

            if (!occupiedTable) {

                return res.status(409).json({
                    success: false,
                    message:
                        "This table is no longer available"
                });

            }

            selectedTable = occupiedTable;

        }


        // --------------------------------------------------
        // Active Reservation
        // --------------------------------------------------

        if (
            selectedTable &&
            isActiveReservation
        ) {

            const occupiedTable =
                await Table.findOneAndUpdate(
                    {
                        _id: selectedTable._id
                    },
                    {
                        $set: {
                            status: "Occupied"
                        }
                    },
                    {
                        new: true,
                        runValidators: true
                    }
                );

            if (occupiedTable) {
                selectedTable = occupiedTable;
            }

        }


        // ==================================================
        // Populate Response
        // ==================================================

        await order.populate(
            "items.menu",
            "name price image"
        );


        await order.populate(
            "table",
            "tableNumber capacity status tableType"
        );


        await order.populate(
            "reservation"
        );


        // ==================================================
        // Response Message
        // ==================================================

        let successMessage =
            "Order placed successfully";


        if (
            initialOrderStatus ===
            "Scheduled"
        ) {

            successMessage =
                "Order scheduled for your reservation";

        }


        if (
            orderType === "Dine-In" &&
            !selectedReservation
        ) {

            successMessage =
                "Walk-in order placed successfully";

        }


        return res.status(201).json({

            success: true,

            message:
                successMessage,

            order

        });


    } catch (error) {

        console.error(
            "Create Order Error:",
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
// Get Logged-in User Orders
// GET /order/my
// ======================================================

const getMyOrders = async (
    req,
    res
) => {

    try {

        const orders =
            await Order.find({

                user:
                    req.user.id

            })

                .populate(
                    "items.menu",
                    "name price image"
                )

                .populate(
                    "table",
                    "tableNumber capacity status tableType"
                )

                .populate(
                    "reservation"
                )

                .sort({

                    createdAt:
                        -1

                });


        return res.status(200).json({

            success: true,

            count:
                orders.length,

            orders

        });


    } catch (error) {

        console.error(
            "Get My Orders Error:",
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
// Get Order By ID
// GET /order/:id
// ======================================================

const getOrderById = async (
    req,
    res
) => {

    try {

        const order =
            await Order.findById(
                req.params.id
            )

                .populate(
                    "user",
                    "-password"
                )

                .populate(
                    "items.menu"
                )

                .populate(
                    "table",
                    "tableNumber capacity status tableType"
                )

                .populate(
                    "reservation"
                );


        if (!order) {

            return res.status(404).json({

                success: false,

                message:
                    "Order not found"

            });

        }


        // ==================================================
        // Access Control
        // ==================================================

        if (
            order.user._id.toString() !==
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


        return res.status(200).json({

            success: true,

            order

        });


    } catch (error) {

        console.error(
            "Get Order By ID Error:",
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
// Update Order Status
// PUT /order/:id
// ======================================================

const updateOrderStatus = async (
    req,
    res
) => {

    try {

        const {
            orderStatus
        } = req.body;


        // ==================================================
        // Valid Statuses
        // ==================================================

        const validStatuses = [

            "Scheduled",
            "Pending",
            "Preparing",
            "Ready",
            "Delivered",
            "Cancelled"

        ];


        if (
            !validStatuses.includes(
                orderStatus
            )
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid order status"

            });

        }


        // ==================================================
        // Find Order
        // ==================================================

        const order =
            await Order.findById(
                req.params.id
            );


        if (!order) {

            return res.status(404).json({

                success: false,

                message:
                    "Order not found"

            });

        }


        // ==================================================
        // Allowed Transitions
        // ==================================================

        const allowedTransitions = {

            Scheduled: [
                "Preparing",
                "Cancelled"
            ],

            Pending: [
                "Preparing",
                "Cancelled"
            ],

            Preparing: [
                "Ready"
            ],

            Ready: [
                "Delivered"
            ],

            Delivered: [],

            Cancelled: []

        };


        if (
            !allowedTransitions[
                order.orderStatus
            ] ||

            !allowedTransitions[
                order.orderStatus
            ].includes(
                orderStatus
            )
        ) {

            return res.status(400).json({

                success: false,

                message:
                    `Cannot change order from ${order.orderStatus} to ${orderStatus}`

            });

        }


        const previousStatus =
            order.orderStatus;


        order.orderStatus =
            orderStatus;


        // ==================================================
        // Scheduled Order Starts
        // ==================================================

        if (
            orderStatus === "Preparing" &&
            order.reservation &&
            !order.table
        ) {

            const reservation =
                await Reservation.findById(
                    order.reservation
                );


            if (
                reservation &&
                reservation.table
            ) {

                order.table =
                    reservation.table;


                await order.save();


                await Table.findByIdAndUpdate(
                    reservation.table,
                    {
                        status:
                            "Occupied"
                    }
                );

            }

        }


        await order.save();


        // ==================================================
        // WALK-IN TABLE LIFECYCLE
        // ==================================================
        //
        // Delivered means the food has been delivered.
        // It does NOT mean the customer has left.
        //
        // Therefore:
        //
        // Pending
        //     ↓
        // Preparing
        //     ↓
        // Ready
        //     ↓
        // Delivered
        //     ↓
        // Table remains Occupied
        //
        // The table will only become Available when the
        // restaurant explicitly closes the table/session.
        //
        // ==================================================


        // ==================================================
        // Reservation Table Lifecycle
        // ==================================================

        // IMPORTANT:
        //
        // Do NOT release a reservation table here.
        //
        // Reservation controls its table lifecycle.
        //
        // Delivered order
        //       ↓
        // Reservation continues
        //       ↓
        // Reservation ends
        //       ↓
        // Table becomes Available


        // ==================================================
        // Populate Response
        // ==================================================

        await order.populate(
            "user",
            "fullName email"
        );


        await order.populate(
            "items.menu",
            "name price image"
        );


        await order.populate(
            "table",
            "tableNumber capacity status tableType"
        );


        await order.populate(
            "reservation"
        );


        return res.status(200).json({

            success: true,

            message:
                "Order status updated successfully",

            previousStatus,

            order

        });


    } catch (error) {

        console.error(
            "Update Order Status Error:",
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
// Process Scheduled Orders
// POST /order/process-scheduled
// ======================================================

const processScheduledOrders = async (
    req,
    res
) => {

    try {

        const activatedCount =
            await processScheduledOrdersService();


        return res.status(200).json({

            success: true,

            message:
                "Scheduled orders processed successfully",

            activatedCount

        });


    } catch (error) {

        console.error(
            "Process Scheduled Orders Error:",
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
// Close Dine-In Table
// POST /order/:id/close-table
// ======================================================
//
// Customer finishes eating and leaves the table.
//
// Lifecycle:
//
// Dine-In
//     ↓
// Food Delivered
//     ↓
// Payment Paid
//     ↓
// Customer clicks "Finish & Leave"
//     ↓
// Reservation Completed (if applicable)
//     ↓
// Table Available
//
// IMPORTANT:
// "Delivered" does NOT mean the customer has left.
// The customer must explicitly finish the meal.
// ======================================================

const closeTable = async (req, res) => {

    try {

        // ==================================================
        // Find Order
        // ==================================================

        const order = await Order.findById(
            req.params.id
        );

        if (!order) {

            return res.status(404).json({
                success: false,
                message: "Order not found"
            });

        }


        // ==================================================
        // Ownership
        // ==================================================

        if (
            order.user.toString() !== req.user.id &&
            req.user.role !== "admin"
        ) {

            return res.status(403).json({
                success: false,
                message: "Access denied"
            });

        }


        // ==================================================
        // Only Dine-In Orders
        // ==================================================

        if (
            order.orderType !== "Dine-In"
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Only dine-in orders can close a table"
            });

        }


        // ==================================================
        // Table Required
        // ==================================================

        if (!order.table) {

            return res.status(400).json({
                success: false,
                message:
                    "No table is assigned to this order"
            });

        }


        // ==================================================
        // Order Must Be Delivered
        // ==================================================

        if (
            order.orderStatus !== "Delivered"
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Please wait until your order has been delivered"
            });

        }


        // ==================================================
        // Payment Must Be Completed
        // ==================================================

        if (
            order.paymentStatus !== "Paid"
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Please complete payment before leaving the table"
            });

        }


        // ==================================================
        // Already Closed
        // ==================================================

        if (order.tableClosed === true) {

            return res.status(400).json({
                success: false,
                message:
                    "This table has already been closed"
            });

        }


        // ==================================================
        // Find Table
        // ==================================================

        const table = await Table.findById(
            order.table
        );

        if (!table) {

            return res.status(404).json({
                success: false,
                message: "Table not found"
            });

        }


        // ==================================================
        // Reservation Handling
        // ==================================================
        //
        // If this order belongs to a reservation,
        // the customer has explicitly confirmed that
        // they have finished dining.
        //
        // Therefore we complete the reservation now.
        //
        // This is important because the scheduler otherwise
        // sees the reservation as still active and can
        // occupy the table again.
        // ==================================================

        if (order.reservation) {

            const reservation =
                await Reservation.findById(
                    order.reservation
                );

            if (reservation) {

                reservation.status = "Completed";

                await reservation.save();

                console.log(
                    `✅ Reservation ${reservation._id} completed because customer left`
                );

            }

        }


        // ==================================================
        // Release Table
        // ==================================================

        table.status = "Available";

        await table.save();


        // ==================================================
        // Mark Order Table Closed
        // ==================================================

        order.tableClosed = true;

        await order.save();


        // ==================================================
        // Success Response
        // ==================================================

        return res.status(200).json({

            success: true,

            message:
                "Table closed successfully. Thank you for dining with LUX Restaurant!",

            table: {

                _id: table._id,

                tableNumber:
                    table.tableNumber,

                status:
                    table.status

            }

        });


    } catch (error) {

        console.error(
            "Close Table Error:",
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
// Delete Order
// DELETE /order/:id
// ======================================================

const deleteOrder = async (
    req,
    res
) => {

    try {

        const order =
            await Order.findById(
                req.params.id
            );


        if (!order) {

            return res.status(404).json({

                success: false,

                message:
                    "Order not found"

            });

        }


        // ==================================================
        // Release Only Walk-In Table
        // ==================================================

        if (
            order.table &&
            !order.reservation
        ) {

            await Table.findByIdAndUpdate(
                order.table,
                {
                    status:
                        "Available"
                }
            );

        }


        await Order.findByIdAndDelete(
            req.params.id
        );


        return res.status(200).json({

            success: true,

            message:
                "Order deleted successfully"

        });


    } catch (error) {

        console.error(
            "Delete Order Error:",
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
// Cancel Order
// PATCH /order/:id/cancel
// ======================================================

const cancelOrder = async (
    req,
    res
) => {

    try {

        // ==================================================
        // Find Order
        // ==================================================

        const order =
            await Order.findById(
                req.params.id
            );


        if (!order) {

            return res.status(404).json({

                success: false,

                message:
                    "Order not found"

            });

        }


        // ==================================================
        // Ownership
        // ==================================================

        if (
            order.user.toString() !==
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
        // Scheduled / Pending Can Cancel
        // ==================================================

        if (
            ![
                "Scheduled",
                "Pending"
            ].includes(
                order.orderStatus
            )
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Only scheduled or pending orders can be cancelled"

            });

        }


        // ==================================================
        // PAID ORDER
        // ==================================================

        if (
            order.paymentStatus ===
            "Paid"
        ) {

            // ----------------------------------------------
            // Razorpay Payment ID Required
            // ----------------------------------------------

            if (
                !order.razorpayPaymentId
            ) {

                console.error(
                    "❌ Razorpay Payment ID missing for refund"
                );


                return res.status(400).json({

                    success: false,

                    message:
                        "Payment was successful, but the Razorpay payment ID is missing. Refund cannot be processed automatically."

                });

            }


            try {

                // ------------------------------------------
                // Create Razorpay Refund
                // ------------------------------------------

                const refund =
                    await razorpay.payments.refund(

                        order.razorpayPaymentId,

                        {

                            amount:
                                Math.round(
                                    Number(
                                        order.totalPrice
                                    ) * 100
                                ),

                            notes: {

                                orderId:
                                    order._id.toString(),

                                reason:
                                    "Customer cancelled order"

                            }

                        }

                    );


                console.log(
                    "✅ Refund created:",
                    refund.id
                );


                // ------------------------------------------
                // Update Order
                // ------------------------------------------

                order.orderStatus =
                    "Cancelled";


                order.paymentStatus =
                    "Refunded";


                await order.save();


                // ------------------------------------------
                // Release Walk-In Table
                // ------------------------------------------

                if (
                    order.table &&
                    !order.reservation
                ) {

                    await Table.findByIdAndUpdate(
                        order.table,
                        {
                            status:
                                "Available"
                        }
                    );

                }


                return res.status(200).json({

                    success: true,

                    message:
                        "Order cancelled successfully and refund initiated",

                    order

                });


            } catch (refundError) {

                console.error(
                    "❌ Razorpay Refund Error:",
                    refundError
                );


                return res.status(500).json({

                    success: false,

                    message:
                        "Order cancellation failed because the refund could not be processed",

                    error:
                        refundError.error?.description ||
                        refundError.message

                });

            }

        }


        // ==================================================
        // UNPAID ORDER
        // ==================================================

        if (
            order.paymentStatus ===
            "Pending"
        ) {

            order.orderStatus =
                "Cancelled";


            await order.save();


            // ------------------------------------------
            // Release Walk-In Table
            // ------------------------------------------

            if (
                order.table &&
                !order.reservation
            ) {

                await Table.findByIdAndUpdate(
                    order.table,
                    {
                        status:
                            "Available"
                    }
                );

            }


            return res.status(200).json({

                success: true,

                message:
                    "Order cancelled successfully",

                order

            });

        }


        // ==================================================
        // FAILED PAYMENT
        // ==================================================

        if (
            order.paymentStatus ===
            "Failed"
        ) {

            order.orderStatus =
                "Cancelled";


            await order.save();


            // ------------------------------------------
            // Release Walk-In Table
            // ------------------------------------------

            if (
                order.table &&
                !order.reservation
            ) {

                await Table.findByIdAndUpdate(
                    order.table,
                    {
                        status:
                            "Available"
                    }
                );

            }


            return res.status(200).json({

                success: true,

                message:
                    "Order cancelled successfully",

                order

            });

        }


        // ==================================================
        // UNKNOWN PAYMENT STATUS
        // ==================================================

        return res.status(400).json({

            success: false,

            message:
                `Order cannot be cancelled with payment status: ${order.paymentStatus}`

        });


    } catch (error) {

        console.error(
            "Cancel Order Error:",
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
// Get All Orders
// GET /order
// ======================================================

const getAllOrders = async (
    req,
    res
) => {

    try {

        const orders =
            await Order.find()

                .populate(
                    "user",
                    "fullName email"
                )

                .populate(
                    "items.menu",
                    "name price image"
                )

                .populate(
                    "table",
                    "tableNumber capacity status tableType"
                )

                // Populate reservation AND its assigned table
                .populate({
                    path: "reservation",
                    populate: {
                        path: "table",
                        select:
                            "tableNumber capacity status tableType"
                    }
                })

                .sort({

                    createdAt:
                        -1

                });


        return res.status(200).json({

            success: true,

            count:
                orders.length,

            orders

        });


    } catch (error) {

        console.error(
            "Get All Orders Error:",
            error
        );


        return res.status(500).json({

            success: false,

            message:
                error.message ||
                "Failed to fetch orders"

        });

    }

};


// ======================================================
// Create Razorpay Payment Order
// POST /order/:orderId/payment
// ======================================================

const createPaymentOrder = async (
    req,
    res
) => {

    try {

        const {
            orderId
        } = req.params;


        // ==================================================
        // Validate Order ID
        // ==================================================

        if (!orderId) {

            return res.status(400).json({

                success: false,

                message:
                    "Restaurant order ID is required"

            });

        }


        // ==================================================
        // Validate User
        // ==================================================

        if (!req.user?.id) {

            return res.status(401).json({

                success: false,

                message:
                    "User authentication required"

            });

        }


        // ==================================================
        // Validate Razorpay Configuration
        // ==================================================

        if (
            !process.env.RAZORPAY_KEY_ID ||
            !process.env.RAZORPAY_KEY_SECRET
        ) {

            return res.status(500).json({

                success: false,

                message:
                    "Razorpay is not configured correctly"

            });

        }


        // ==================================================
        // Find Restaurant Order
        // ==================================================

        const order =
            await Order.findOne({

                _id:
                    orderId,

                user:
                    req.user.id

            });


        if (!order) {

            return res.status(404).json({

                success: false,

                message:
                    "Order not found"

            });

        }


        // ==================================================
        // Already Paid
        // ==================================================

        if (
            order.paymentStatus ===
            "Paid"
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Order is already paid"

            });

        }


        // ==================================================
        // Calculate Amount
        // ==================================================

        const amountInPaise =
            Math.round(
                Number(
                    order.totalPrice
                ) * 100
            );


        if (
            !Number.isFinite(
                amountInPaise
            ) ||
            amountInPaise <= 0
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid order amount"

            });

        }


        // ==================================================
        // Create Razorpay Order
        // ==================================================

        const razorpayOrder =
            await razorpay.orders.create({

                amount:
                    amountInPaise,

                currency:
                    "INR",

                receipt:
                    `LUX_${order._id.toString()}`,

                notes: {

                    restaurantOrderId:
                        order._id.toString(),

                    userId:
                        req.user.id.toString()

                }

            });


        // ==================================================
        // Save Razorpay Order ID
        // ==================================================

        order.razorpayOrderId =
            razorpayOrder.id;

        order.paymentStatus =
            "Pending";


        await order.save();


        // ==================================================
        // Response
        // ==================================================

        return res.status(200).json({

            success: true,

            message:
                "Payment order created",

            key:
                process.env.RAZORPAY_KEY_ID,

            razorpayOrderId:
                razorpayOrder.id,

            amount:
                razorpayOrder.amount,

            currency:
                razorpayOrder.currency,

            orderId:
                order._id.toString()

        });


    } catch (error) {

        console.error(
            "❌ Create Payment Order Error:",
            error
        );


        return res.status(500).json({

            success: false,

            message:
                error.message ||
                "Failed to create payment order"

        });

    }

};


// ======================================================
// Verify Razorpay Payment
// POST /order/:orderId/payment/verify
// ======================================================

const verifyPayment = async (
    req,
    res
) => {

    try {

        const {
            orderId
        } = req.params;


        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = req.body;


        // ==================================================
        // Validate Order ID
        // ==================================================

        if (!orderId) {

            return res.status(400).json({

                success: false,

                message:
                    "Restaurant order ID is required"

            });

        }


        // ==================================================
        // Validate User
        // ==================================================

        if (!req.user?.id) {

            return res.status(401).json({

                success: false,

                message:
                    "User authentication required"

            });

        }


        // ==================================================
        // Validate Razorpay Response
        // ==================================================

        if (
            !razorpay_order_id ||
            !razorpay_payment_id ||
            !razorpay_signature
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Incomplete payment information"

            });

        }


        // ==================================================
        // Validate Secret
        // ==================================================

        if (
            !process.env.RAZORPAY_KEY_SECRET
        ) {

            return res.status(500).json({

                success: false,

                message:
                    "Razorpay secret key is not configured"

            });

        }


        // ==================================================
        // Find Restaurant Order
        // ==================================================

        const order =
            await Order.findOne({

                _id:
                    orderId,

                user:
                    req.user.id

            });


        if (!order) {

            return res.status(404).json({

                success: false,

                message:
                    "Order not found"

            });

        }


        // ==================================================
        // Prevent Duplicate Verification
        // ==================================================

        if (
            order.paymentStatus ===
            "Paid"
        ) {

            return res.status(200).json({

                success: true,

                message:
                    "Payment already verified",

                order

            });

        }


        // ==================================================
        // Check Razorpay Order ID
        // ==================================================

        if (
            !order.razorpayOrderId ||
            order.razorpayOrderId !==
                razorpay_order_id
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid Razorpay order"

            });

        }


        // ==================================================
        // Generate Signature
        // ==================================================

        const generatedSignature =
            crypto
                .createHmac(
                    "sha256",
                    process.env.RAZORPAY_KEY_SECRET
                )
                .update(
                    `${razorpay_order_id}|${razorpay_payment_id}`
                )
                .digest("hex");


        // ==================================================
        // Safe Signature Comparison
        // ==================================================

        const generatedBuffer =
            Buffer.from(
                generatedSignature,
                "utf8"
            );


        const receivedBuffer =
            Buffer.from(
                razorpay_signature,
                "utf8"
            );


        if (
            generatedBuffer.length !==
            receivedBuffer.length
        ) {

            order.paymentStatus =
                "Failed";

            await order.save();


            return res.status(400).json({

                success: false,

                message:
                    "Payment verification failed"

            });

        }


        const isSignatureValid =
            crypto.timingSafeEqual(
                generatedBuffer,
                receivedBuffer
            );


        // ==================================================
        // Invalid Signature
        // ==================================================

        if (!isSignatureValid) {

            order.paymentStatus =
                "Failed";

            await order.save();


            return res.status(400).json({

                success: false,

                message:
                    "Payment verification failed"

            });

        }


        // ==================================================
        // PAYMENT VERIFIED
        // ==================================================

        order.paymentStatus =
            "Paid";


        order.razorpayPaymentId =
            razorpay_payment_id;


        order.razorpaySignature =
            razorpay_signature;


        await order.save();


        return res.status(200).json({

            success: true,

            message:
                "Payment verified successfully",

            order

        });


    } catch (error) {

        console.error(
            "❌ Verify Payment Error:",
            error
        );


        return res.status(500).json({

            success: false,

            message:
                error.message ||
                "Payment verification failed"

        });

    }

};


// ======================================================
// Export Controllers
// ======================================================

module.exports = {

    createOrder,

    getMyOrders,

    getOrderById,

    updateOrderStatus,

    processScheduledOrders,

    deleteOrder,

    cancelOrder,

    getAllOrders,

    closeTable,

    createPaymentOrder,

    verifyPayment

};