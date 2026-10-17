const crypto = require("crypto");
const Order = require("../models/Order");

// ======================================================
// Helper: Verify Webhook Signature
// ======================================================

const verifyWebhookSignature = (rawBody, signature, secret) => {
    try {
        if (!rawBody || !signature || !secret) {
            return false;
        }

        if (typeof signature !== "string" || typeof secret !== "string") {
            return false;
        }

        const payloadBuffer = Buffer.isBuffer(rawBody)
            ? rawBody
            : Buffer.from(rawBody, "utf8");

        const expectedSignature = crypto
            .createHmac("sha256", secret)
            .update(payloadBuffer)
            .digest("hex");

        const expectedBuffer = Buffer.from(expectedSignature, "utf8");
        const receivedBuffer = Buffer.from(signature, "utf8");

        if (expectedBuffer.length !== receivedBuffer.length) {
            return false;
        }

        return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
    } catch (error) {
        return false;
    }
};

// ======================================================
// Webhook Handler Factory
// ======================================================

const createWebhookHandler = (options = {}) => {
    const OrderModel = options.OrderModel || Order;

    return async (req, res) => {
        try {
            const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

            if (!webhookSecret) {
                console.error("❌ RAZORPAY_WEBHOOK_SECRET is not configured on the server");
                return res.status(500).json({
                    success: false,
                    message: "Webhook secret is not configured"
                });
            }

            const signature = req.headers["x-razorpay-signature"];

            if (!signature) {
                return res.status(400).json({
                    success: false,
                    message: "Missing Razorpay webhook signature header"
                });
            }

            // Extract raw body preserved by express.json({ verify })
            const rawBody =
                req.rawBody ||
                (typeof req.body === "string"
                    ? Buffer.from(req.body, "utf8")
                    : Buffer.from(JSON.stringify(req.body || {}), "utf8"));

            const isSignatureValid = verifyWebhookSignature(
                rawBody,
                signature,
                webhookSecret
            );

            if (!isSignatureValid) {
                console.error("❌ Invalid Razorpay webhook signature");
                return res.status(400).json({
                    success: false,
                    message: "Invalid webhook signature"
                });
            }

            const eventId =
                req.headers["x-razorpay-event-id"] ||
                req.body?.id ||
                null;

            const eventType = req.body?.event;
            const payload = req.body?.payload;

            console.log(`🔔 Razorpay Webhook Event: ${eventType} (Event ID: ${eventId || "N/A"})`);

            // ==================================================
            // Event: payment.captured
            // ==================================================
            if (eventType === "payment.captured") {
                const payment = payload?.payment?.entity;

                if (!payment || !payment.order_id || !payment.id) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid payment payload in webhook"
                    });
                }

                // Currency check
                if (payment.currency && payment.currency !== "INR") {
                    return res.status(400).json({
                        success: false,
                        message: "Unsupported currency"
                    });
                }

                // Check capture status
                if (payment.status !== "captured" || payment.captured !== true) {
                    console.log(
                        `ℹ️ Payment ${payment.id} status is '${payment.status}' (captured: ${payment.captured}). Awaiting capture.`
                    );
                    return res.status(200).json({
                        success: true,
                        message: "Payment not yet captured; acknowledged"
                    });
                }

                // Find matching LUX order by Razorpay order ID
                let order = await OrderModel.findOne({
                    razorpayOrderId: payment.order_id
                });

                // Fallback to notes if order_id did not match directly
                if (!order && payment.notes) {
                    const restaurantOrderId =
                        payment.notes.restaurantOrderId || payment.notes.orderId;
                    if (restaurantOrderId) {
                        const candidateOrder = await OrderModel.findById(restaurantOrderId);
                        if (candidateOrder) {
                            if (
                                candidateOrder.razorpayOrderId &&
                                candidateOrder.razorpayOrderId !== payment.order_id
                            ) {
                                console.error(
                                    `❌ Webhook order ID mismatch: payment ${payment.id} has order_id ${payment.order_id}, but order ${candidateOrder._id} already has razorpayOrderId ${candidateOrder.razorpayOrderId}`
                                );
                                return res.status(400).json({
                                    success: false,
                                    message: "Razorpay order ID conflicts with order gateway order ID"
                                });
                            }
                            order = candidateOrder;
                        }
                    }
                }

                if (!order) {
                    console.warn(
                        `⚠️ Webhook payment.captured received for unmatched order_id: ${payment.order_id}`
                    );
                    return res.status(200).json({
                        success: true,
                        message: "No matching order found; acknowledged"
                    });
                }

                // Amount validation - do not trust client-supplied amounts
                const expectedPaise = Math.round(Number(order.totalPrice) * 100);
                if (payment.amount !== expectedPaise) {
                    console.error(
                        `❌ Webhook amount mismatch for order ${order._id}: expected ${expectedPaise}, received ${payment.amount}`
                    );
                    return res.status(400).json({
                        success: false,
                        message: "Payment amount mismatch"
                    });
                }

                // Deterministic deduplication key
                const dedupeKey = eventId || `payment.captured:${payment.id}`;

                // Fast in-memory check for already-processed dedupeKey
                if (
                    order.processedWebhookEvents &&
                    order.processedWebhookEvents.includes(dedupeKey)
                ) {
                    return res.status(200).json({
                        success: true,
                        message: "Event already processed"
                    });
                }

                // Check if already marked Paid with another payment ID (conflicting payment)
                if (
                    order.paymentStatus === "Paid" &&
                    order.razorpayPaymentId &&
                    order.razorpayPaymentId !== payment.id
                ) {
                    console.warn(
                        `⚠️ Order ${order._id} already Paid with payment ID ${order.razorpayPaymentId}; received conflicting payment ${payment.id}`
                    );
                    return res.status(200).json({
                        success: true,
                        message:
                            "Order already paid with different payment ID; preserved existing payment"
                    });
                }

                // Do not mark an already PartiallyRefunded order back to Paid
                if (order.paymentStatus === "PartiallyRefunded") {
                    console.log(
                        `ℹ️ Order ${order._id} is already PartiallyRefunded; ignoring late payment.captured`
                    );
                    return res.status(200).json({
                        success: true,
                        message: "Order is already partially refunded; preserved payment status"
                    });
                }

                // Do not mark an already Refunded order as Paid
                if (order.paymentStatus === "Refunded") {
                    console.warn(
                        `⚠️ Order ${order._id} is already Refunded; ignoring payment.captured`
                    );
                    return res.status(200).json({
                        success: true,
                        message: "Order is already Refunded; ignored payment capture"
                    });
                }

                // Do not mark an order with pending refund as Paid
                if (order.paymentStatus === "RefundPending") {
                    console.log(
                        `ℹ️ Order ${order._id} refund is pending; ignoring late payment.captured`
                    );
                    return res.status(200).json({
                        success: true,
                        message: "Order refund is pending; preserved payment status"
                    });
                }

                // Atomic update: only apply if dedupeKey is not yet present,
                // order is not Refunded/PartiallyRefunded/RefundPending, and order is either not Paid yet or already has this payment ID.
                const updateFields = {
                    paymentStatus: "Paid",
                    razorpayPaymentId: payment.id,
                    razorpayOrderId: payment.order_id
                };

                // Alert and mark durable reconciliation flag if payment captured for a cancelled order
                if (order.orderStatus === "Cancelled") {
                    console.warn(
                        `🚨 ALERT: Payment ${payment.id} captured for CANCELLED order ${order._id}. Immediate refund or manual review required.`
                    );
                    updateFields.reconciliationRequired = true;
                }

                const updatedOrder = await OrderModel.findOneAndUpdate(
                    {
                        _id: order._id,
                        processedWebhookEvents: { $ne: dedupeKey },
                        paymentStatus: { $nin: ["Refunded", "PartiallyRefunded", "RefundPending"] },
                        $or: [
                            { paymentStatus: { $ne: "Paid" } },
                            { razorpayPaymentId: payment.id }
                        ]
                    },
                    {
                        $set: updateFields,
                        $addToSet: { processedWebhookEvents: dedupeKey }
                    },
                    { new: true, runValidators: true }
                );

                if (!updatedOrder) {
                    // Re-query current state to determine exact race outcome
                    const currentOrder = await OrderModel.findById(order._id);
                    if (
                        currentOrder?.processedWebhookEvents &&
                        currentOrder.processedWebhookEvents.includes(dedupeKey)
                    ) {
                        return res.status(200).json({
                            success: true,
                            message: "Event already processed"
                        });
                    }
                    if (
                        currentOrder?.paymentStatus === "Paid" &&
                        currentOrder.razorpayPaymentId &&
                        currentOrder.razorpayPaymentId !== payment.id
                    ) {
                        return res.status(200).json({
                            success: true,
                            message:
                                "Order already paid with different payment ID; preserved existing payment"
                        });
                    }
                    if (currentOrder?.paymentStatus === "PartiallyRefunded") {
                        return res.status(200).json({
                            success: true,
                            message: "Order is already partially refunded; preserved payment status"
                        });
                    }
                    if (currentOrder?.paymentStatus === "Refunded") {
                        return res.status(200).json({
                            success: true,
                            message: "Order is already Refunded; ignored payment capture"
                        });
                    }
                    if (currentOrder?.paymentStatus === "RefundPending") {
                        return res.status(200).json({
                            success: true,
                            message: "Order refund is pending; preserved payment status"
                        });
                    }
                    return res.status(200).json({
                        success: true,
                        message: "Order update skipped due to state conflict"
                    });
                }

                console.log(
                    `✅ Webhook: Order ${order._id} marked as Paid (payment: ${payment.id})`
                );

                return res.status(200).json({
                    success: true,
                    message: "Order payment successfully recorded",
                    orderId: order._id.toString()
                });
            }

            // ==================================================
            // Event: order.paid
            // ==================================================
            if (eventType === "order.paid") {
                const orderEntity = payload?.order?.entity;
                const paymentEntity = payload?.payment?.entity;

                // If payment entity is present and captured, process using payment logic
                if (paymentEntity && paymentEntity.status === "captured") {
                    const payment = paymentEntity;

                    let order = await OrderModel.findOne({
                        razorpayOrderId: orderEntity?.id || payment.order_id
                    });

                    if (!order && payment.notes) {
                        const restaurantOrderId =
                            payment.notes.restaurantOrderId || payment.notes.orderId;
                        if (restaurantOrderId) {
                            const candidateOrder = await OrderModel.findById(restaurantOrderId);
                            if (candidateOrder) {
                                const expectedGatewayOrderId = orderEntity?.id || payment.order_id;
                                if (
                                    candidateOrder.razorpayOrderId &&
                                    expectedGatewayOrderId &&
                                    candidateOrder.razorpayOrderId !== expectedGatewayOrderId
                                ) {
                                    console.error(
                                        `❌ Webhook order.paid order ID mismatch: gateway order ${expectedGatewayOrderId}, but order ${candidateOrder._id} already has razorpayOrderId ${candidateOrder.razorpayOrderId}`
                                    );
                                    return res.status(400).json({
                                        success: false,
                                        message: "Razorpay order ID conflicts with order gateway order ID"
                                    });
                                }
                                order = candidateOrder;
                            }
                        }
                    }

                    if (!order) {
                        return res.status(200).json({
                            success: true,
                            message: "No matching order found; acknowledged"
                        });
                    }

                    const expectedPaise = Math.round(Number(order.totalPrice) * 100);
                    if (payment.amount !== expectedPaise) {
                        return res.status(400).json({
                            success: false,
                            message: "Payment amount mismatch"
                        });
                    }

                    const dedupeKey = eventId || `order.paid:${orderEntity?.id || payment.id}`;

                    if (
                        order.processedWebhookEvents &&
                        order.processedWebhookEvents.includes(dedupeKey)
                    ) {
                        return res.status(200).json({
                            success: true,
                            message: "Event already processed"
                        });
                    }

                    if (
                        order.paymentStatus === "Paid" &&
                        order.razorpayPaymentId &&
                        order.razorpayPaymentId !== payment.id
                    ) {
                        return res.status(200).json({
                            success: true,
                            message:
                                "Order already paid with different payment ID; preserved existing payment"
                        });
                    }

                    if (order.paymentStatus === "PartiallyRefunded") {
                        return res.status(200).json({
                            success: true,
                            message: "Order is already partially refunded; preserved payment status"
                        });
                    }

                    if (order.paymentStatus === "Refunded") {
                        return res.status(200).json({
                            success: true,
                            message: "Order is already Refunded; ignored payment capture"
                        });
                    }

                    if (order.paymentStatus === "RefundPending") {
                        return res.status(200).json({
                            success: true,
                            message: "Order refund is pending; preserved payment status"
                        });
                    }

                    const updateFields = {
                        paymentStatus: "Paid",
                        razorpayPaymentId: payment.id,
                        razorpayOrderId: orderEntity?.id || payment.order_id
                    };

                    if (order.orderStatus === "Cancelled") {
                        updateFields.reconciliationRequired = true;
                    }

                    const updatedOrder = await OrderModel.findOneAndUpdate(
                        {
                            _id: order._id,
                            processedWebhookEvents: { $ne: dedupeKey },
                            paymentStatus: { $nin: ["Refunded", "PartiallyRefunded", "RefundPending"] },
                            $or: [
                                { paymentStatus: { $ne: "Paid" } },
                                { razorpayPaymentId: payment.id }
                            ]
                        },
                        {
                            $set: updateFields,
                            $addToSet: { processedWebhookEvents: dedupeKey }
                        },
                        { new: true, runValidators: true }
                    );

                    if (!updatedOrder) {
                        const currentOrder = await OrderModel.findById(order._id);
                        if (currentOrder?.processedWebhookEvents?.includes(dedupeKey)) {
                            return res.status(200).json({
                                success: true,
                                message: "Event already processed"
                            });
                        }
                        if (
                            currentOrder?.paymentStatus === "Paid" &&
                            currentOrder.razorpayPaymentId !== payment.id
                        ) {
                            return res.status(200).json({
                                success: true,
                                message:
                                    "Order already paid with different payment ID; preserved existing payment"
                            });
                        }
                        if (currentOrder?.paymentStatus === "PartiallyRefunded") {
                            return res.status(200).json({
                                success: true,
                                message: "Order is already partially refunded; preserved payment status"
                            });
                        }
                        if (currentOrder?.paymentStatus === "Refunded") {
                            return res.status(200).json({
                                success: true,
                                message: "Order is already Refunded; ignored payment capture"
                            });
                        }
                        if (currentOrder?.paymentStatus === "RefundPending") {
                            return res.status(200).json({
                                success: true,
                                message: "Order refund is pending; preserved payment status"
                            });
                        }
                        return res.status(200).json({
                            success: true,
                            message: "Order update skipped due to state conflict"
                        });
                    }

                    return res.status(200).json({
                        success: true,
                        message: "Order payment successfully recorded",
                        orderId: order._id.toString()
                    });
                }

                // If only orderEntity exists without captured payment, acknowledge
                return res.status(200).json({
                    success: true,
                    message: "Order paid event acknowledged"
                });
            }

            // ==================================================
            // Event: payment.failed
            // ==================================================
            if (eventType === "payment.failed") {
                const payment = payload?.payment?.entity;

                if (!payment || !payment.order_id) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid payment.failed payload"
                    });
                }

                let order = await OrderModel.findOne({
                    razorpayOrderId: payment.order_id
                });

                if (!order && payment.notes) {
                    const restaurantOrderId =
                        payment.notes.restaurantOrderId || payment.notes.orderId;
                    if (restaurantOrderId) {
                        const candidateOrder = await OrderModel.findById(restaurantOrderId);
                        if (candidateOrder) {
                            if (
                                candidateOrder.razorpayOrderId &&
                                candidateOrder.razorpayOrderId !== payment.order_id
                            ) {
                                console.error(
                                    `❌ Webhook payment.failed order ID mismatch: payment ${payment.id || "N/A"} has order_id ${payment.order_id}, but order ${candidateOrder._id} already has razorpayOrderId ${candidateOrder.razorpayOrderId}`
                                );
                                return res.status(400).json({
                                    success: false,
                                    message: "Razorpay order ID conflicts with order gateway order ID"
                                });
                            }
                            order = candidateOrder;
                        }
                    }
                }

                if (!order) {
                    return res.status(200).json({
                        success: true,
                        message: "No matching order found; acknowledged"
                    });
                }

                const dedupeKey =
                    eventId ||
                    (payment.id
                        ? `payment.failed:${payment.id}`
                        : `payment.failed:${payment.order_id}`);

                if (
                    order.processedWebhookEvents &&
                    order.processedWebhookEvents.includes(dedupeKey)
                ) {
                    return res.status(200).json({
                        success: true,
                        message: "Event already processed"
                    });
                }

                // Do not mark an already Paid, PartiallyRefunded, Refunded, or RefundPending order as Failed
                if (["Paid", "PartiallyRefunded", "Refunded", "RefundPending"].includes(order.paymentStatus)) {
                    console.log(
                        `ℹ️ Order ${order._id} is already ${order.paymentStatus}; ignoring payment.failed`
                    );
                    return res.status(200).json({
                        success: true,
                        message: `Order is already ${order.paymentStatus}; ignored failure`
                    });
                }

                const updatedOrder = await OrderModel.findOneAndUpdate(
                    {
                        _id: order._id,
                        processedWebhookEvents: { $ne: dedupeKey },
                        paymentStatus: { $nin: ["Paid", "PartiallyRefunded", "Refunded", "RefundPending"] }
                    },
                    {
                        $set: { paymentStatus: "Failed" },
                        $addToSet: { processedWebhookEvents: dedupeKey }
                    },
                    { new: true, runValidators: true }
                );

                if (!updatedOrder) {
                    return res.status(200).json({
                        success: true,
                        message:
                            "Event already processed or order in non-failable state"
                    });
                }

                console.log(`⚠️ Webhook: Order ${order._id} marked as Failed`);
                return res.status(200).json({
                    success: true,
                    message: "Order marked as Failed"
                });
            }

            // ==================================================
            // Event: refund.processed (Fix 2: Correct Partial-Refund Handling)
            // ==================================================
            if (eventType === "refund.processed") {
                const refund = payload?.refund?.entity;
                const payment = payload?.payment?.entity;

                if (!refund || !refund.payment_id || !refund.id) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid refund.processed payload"
                    });
                }

                // Only process confirmed successful refunds
                if (refund.status && refund.status !== "processed") {
                    console.log(
                        `ℹ️ Refund ${refund.id} status is '${refund.status}'; awaiting processing.`
                    );
                    return res.status(200).json({
                        success: true,
                        message: `Refund status is '${refund.status}'; awaiting processing`
                    });
                }

                let order = await OrderModel.findOne({
                    razorpayPaymentId: refund.payment_id
                });

                if (!order && refund.notes) {
                    const restaurantOrderId =
                        refund.notes.restaurantOrderId || refund.notes.orderId;
                    if (restaurantOrderId) {
                        const candidateOrder = await OrderModel.findById(restaurantOrderId);
                        if (candidateOrder) {
                            if (
                                candidateOrder.razorpayPaymentId &&
                                candidateOrder.razorpayPaymentId !== refund.payment_id
                            ) {
                                console.error(
                                    `❌ Refund payment ID mismatch: refund ${refund.id} has payment_id ${refund.payment_id}, but order ${candidateOrder._id} has razorpayPaymentId ${candidateOrder.razorpayPaymentId}`
                                );
                                return res.status(400).json({
                                    success: false,
                                    message: "Refund payment ID conflicts with order payment ID"
                                });
                            }
                            order = candidateOrder;
                        }
                    }
                }

                if (!order) {
                    return res.status(200).json({
                        success: true,
                        message: "No matching order found for refund; acknowledged"
                    });
                }

                const dedupeKey = eventId || `refund.processed:${refund.id}`;

                if (
                    order.processedWebhookEvents &&
                    order.processedWebhookEvents.includes(dedupeKey)
                ) {
                    return res.status(200).json({
                        success: true,
                        message: "Refund event already processed",
                        refundId: refund.id
                    });
                }

                // Check if this specific refund is already in order.refunds
                const existingRefundEntry = order.refunds?.find(
                    r => r.refundId === refund.id
                );

                if (existingRefundEntry && existingRefundEntry.status === "processed") {
                    if (!order.processedWebhookEvents?.includes(dedupeKey)) {
                        await OrderModel.findByIdAndUpdate(order._id, {
                            $addToSet: { processedWebhookEvents: dedupeKey }
                        });
                    }
                    return res.status(200).json({
                        success: true,
                        message: "Refund event already processed",
                        refundId: refund.id
                    });
                }

                const totalOrderPaise = Math.round(Number(order.totalPrice) * 100);
                const thisRefundPaise = Number(refund.amount || 0);
                const previousRefundedPaise = Math.round(
                    Number(order.amountRefunded || 0) * 100
                );

                // Calculate cumulative refunded amount:
                // Use official gateway amount_refunded if provided, otherwise accumulate in database
                let cumulativeRefundedPaise;
                if (
                    payment &&
                    payment.amount_refunded !== undefined &&
                    payment.amount_refunded !== null
                ) {
                    const gatewayCumulativePaise = Number(payment.amount_refunded);
                    // Monotonic: prevent older out-of-order webhook delivery from reducing amountRefunded
                    cumulativeRefundedPaise = Math.max(previousRefundedPaise, gatewayCumulativePaise);
                } else if (existingRefundEntry && existingRefundEntry.status === "pending") {
                    // Was pending at cancellation, not yet counted in amountRefunded
                    cumulativeRefundedPaise = previousRefundedPaise + thisRefundPaise;
                } else if (existingRefundEntry && existingRefundEntry.status === "failed") {
                    // Was previously marked failed; amount was NOT counted in amountRefunded! Add it now.
                    cumulativeRefundedPaise = previousRefundedPaise + thisRefundPaise;
                } else if (existingRefundEntry) {
                    // Already processed and counted in amountRefunded
                    cumulativeRefundedPaise = previousRefundedPaise;
                } else {
                    // Brand new refund from gateway
                    cumulativeRefundedPaise = previousRefundedPaise + thisRefundPaise;
                }

                // Validate: clamp to [0, totalOrderPaise] to prevent negative or excessive totals
                cumulativeRefundedPaise = Math.max(0, Math.min(totalOrderPaise, cumulativeRefundedPaise));

                // Distinguish partial vs. full refund
                const isFullRefund =
                    payment?.refund_status === "full" ||
                    cumulativeRefundedPaise >= totalOrderPaise;

                if (order.paymentStatus === "Refunded" && !isFullRefund) {
                    console.warn(
                        `⚠️ Order ${order._id} is already fully Refunded; ignoring partial refund downgrade`
                    );
                    return res.status(200).json({
                        success: true,
                        message: "Order is already fully Refunded; ignored partial refund",
                        refundId: refund.id
                    });
                }

                const refundAmountRupees = Number((thisRefundPaise / 100).toFixed(2));
                const updateFields = {
                    refundId: refund.id,
                    amountRefunded: Number((cumulativeRefundedPaise / 100).toFixed(2))
                };

                if (isFullRefund) {
                    updateFields.paymentStatus = "Refunded";
                    // Only cancel order if not already in terminal completed/delivered states
                    if (["Pending", "Scheduled"].includes(order.orderStatus)) {
                        updateFields.orderStatus = "Cancelled";
                    }
                } else {
                    // Partial refund: mark PartiallyRefunded and do NOT cancel order!
                    updateFields.paymentStatus = "PartiallyRefunded";
                    console.log(
                        `ℹ️ Partial refund of ₹${thisRefundPaise / 100} processed for order ${order._id}. Cumulative refunded: ₹${cumulativeRefundedPaise / 100} / ₹${order.totalPrice}`
                    );
                }

                let updatedOrder = null;
                if (existingRefundEntry) {
                    // Positional update: update existing ledger entry status to "processed" atomically without duplicating
                    const filter = {
                        _id: order._id,
                        "refunds.refundId": refund.id,
                        processedWebhookEvents: { $ne: dedupeKey }
                    };
                    if (!isFullRefund) {
                        filter.paymentStatus = { $ne: "Refunded" };
                    }
                    updatedOrder = await OrderModel.findOneAndUpdate(
                        filter,
                        {
                            $set: {
                                ...updateFields,
                                "refunds.$.status": "processed"
                            },
                            $addToSet: { processedWebhookEvents: dedupeKey }
                        },
                        { new: true, runValidators: true }
                    );
                } else {
                    // Push new ledger entry atomically: require that refundId is NOT yet in refunds array
                    const filter = {
                        _id: order._id,
                        "refunds.refundId": { $ne: refund.id },
                        processedWebhookEvents: { $ne: dedupeKey }
                    };
                    if (!isFullRefund) {
                        filter.paymentStatus = { $ne: "Refunded" };
                    }
                    updatedOrder = await OrderModel.findOneAndUpdate(
                        filter,
                        {
                            $set: updateFields,
                            $addToSet: { processedWebhookEvents: dedupeKey },
                            $push: {
                                refunds: {
                                    refundId: refund.id,
                                    amount: refundAmountRupees,
                                    status: "processed",
                                    createdAt: new Date()
                                }
                            }
                        },
                        { new: true, runValidators: true }
                    );
                }

                if (!updatedOrder) {
                    const currentOrder = await OrderModel.findById(order._id);
                    if (
                        currentOrder?.processedWebhookEvents &&
                        currentOrder.processedWebhookEvents.includes(dedupeKey)
                    ) {
                        return res.status(200).json({
                            success: true,
                            message: "Refund event already processed",
                            refundId: refund.id
                        });
                    }
                    if (currentOrder?.refunds?.some(r => r.refundId === refund.id)) {
                        return res.status(200).json({
                            success: true,
                            message: "Refund event already processed",
                            refundId: refund.id
                        });
                    }
                    if (currentOrder?.paymentStatus === "Refunded" && !isFullRefund) {
                        return res.status(200).json({
                            success: true,
                            message: "Order is already fully Refunded; ignored partial refund",
                            refundId: refund.id
                        });
                    }
                    return res.status(200).json({
                        success: true,
                        message: "Refund update skipped due to state conflict"
                    });
                }

                console.log(
                    `✅ Webhook: Order ${order._id} refund recorded (isFull: ${isFullRefund}, refund: ${refund.id}, amount: ₹${thisRefundPaise / 100})`
                );

                return res.status(200).json({
                    success: true,
                    message: isFullRefund
                        ? "Order marked as Refunded"
                        : "Partial refund successfully recorded",
                    refundId: refund.id,
                    isFullRefund,
                    amountRefunded: updateFields.amountRefunded
                });
            }

            // ==================================================
            // Event: refund.failed
            // ==================================================
            if (eventType === "refund.failed") {
                const refund = payload?.refund?.entity;
                const payment = payload?.payment?.entity;

                if (!refund || !refund.payment_id || !refund.id) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid refund.failed payload"
                    });
                }

                let order = await OrderModel.findOne({
                    razorpayPaymentId: refund.payment_id
                });

                if (!order && refund.notes) {
                    const restaurantOrderId =
                        refund.notes.restaurantOrderId || refund.notes.orderId;
                    if (restaurantOrderId) {
                        const candidateOrder = await OrderModel.findById(restaurantOrderId);
                        if (candidateOrder) {
                            if (
                                candidateOrder.razorpayPaymentId &&
                                candidateOrder.razorpayPaymentId !== refund.payment_id
                            ) {
                                console.error(
                                    `❌ Refund.failed payment ID mismatch: refund ${refund.id} has payment_id ${refund.payment_id}, but order ${candidateOrder._id} has razorpayPaymentId ${candidateOrder.razorpayPaymentId}`
                                );
                                return res.status(400).json({
                                    success: false,
                                    message: "Refund payment ID conflicts with order payment ID"
                                });
                            }
                            order = candidateOrder;
                        }
                    }
                }

                if (!order) {
                    return res.status(200).json({
                        success: true,
                        message: "No matching order found for failed refund; acknowledged"
                    });
                }

                const dedupeKey = eventId || `refund.failed:${refund.id}`;

                if (
                    order.processedWebhookEvents &&
                    order.processedWebhookEvents.includes(dedupeKey)
                ) {
                    return res.status(200).json({
                        success: true,
                        message: "Refund failed event already processed",
                        refundId: refund.id
                    });
                }

                const updateFields = {
                    reconciliationRequired: true
                };

                // If order paymentStatus is RefundPending, revert based on existing confirmed amountRefunded
                if (order.paymentStatus === "RefundPending") {
                    const confirmedRefundedPaise = Math.round(Number(order.amountRefunded || 0) * 100);
                    updateFields.paymentStatus = (confirmedRefundedPaise > 0)
                        ? "PartiallyRefunded"
                        : "Paid";
                }

                const existingRefundEntry = order.refunds?.find(
                    r => r.refundId === refund.id
                );

                // Prevent delayed or out-of-order refund.failed from overwriting a processed refund
                if (existingRefundEntry && existingRefundEntry.status === "processed") {
                    console.warn(
                        `⚠️ Order ${order._id} refund ${refund.id} is already processed; ignoring delayed refund.failed event.`
                    );
                    if (!order.processedWebhookEvents?.includes(dedupeKey)) {
                        await OrderModel.findByIdAndUpdate(order._id, {
                            $addToSet: { processedWebhookEvents: dedupeKey }
                        });
                    }
                    return res.status(200).json({
                        success: true,
                        message: "Refund is already processed; ignored late failed event",
                        refundId: refund.id
                    });
                }

                let updatedOrder = null;
                if (existingRefundEntry) {
                    updatedOrder = await OrderModel.findOneAndUpdate(
                        {
                            _id: order._id,
                            "refunds.refundId": refund.id,
                            processedWebhookEvents: { $ne: dedupeKey }
                        },
                        {
                            $set: {
                                ...updateFields,
                                "refunds.$.status": "failed"
                            },
                            $addToSet: { processedWebhookEvents: dedupeKey }
                        },
                        { new: true, runValidators: true }
                    );
                } else {
                    const refundAmountRupees = Number((Number(refund.amount || 0) / 100).toFixed(2));
                    updatedOrder = await OrderModel.findOneAndUpdate(
                        {
                            _id: order._id,
                            "refunds.refundId": { $ne: refund.id },
                            processedWebhookEvents: { $ne: dedupeKey }
                        },
                        {
                            $set: updateFields,
                            $addToSet: { processedWebhookEvents: dedupeKey },
                            $push: {
                                refunds: {
                                    refundId: refund.id,
                                    amount: refundAmountRupees,
                                    status: "failed",
                                    createdAt: new Date()
                                }
                            }
                        },
                        { new: true, runValidators: true }
                    );
                }

                if (!updatedOrder) {
                    const currentOrder = await OrderModel.findById(order._id);
                    if (currentOrder?.processedWebhookEvents?.includes(dedupeKey)) {
                        return res.status(200).json({
                            success: true,
                            message: "Refund failed event already processed",
                            refundId: refund.id
                        });
                    }
                    if (currentOrder?.refunds?.some(r => r.refundId === refund.id && r.status === "processed")) {
                        return res.status(200).json({
                            success: true,
                            message: "Refund is already processed; ignored late failed event",
                            refundId: refund.id
                        });
                    }
                    if (currentOrder?.refunds?.some(r => r.refundId === refund.id)) {
                        return res.status(200).json({
                            success: true,
                            message: "Refund failed event already processed",
                            refundId: refund.id
                        });
                    }
                    return res.status(200).json({
                        success: true,
                        message: "Refund failed update skipped due to state conflict"
                    });
                }

                console.warn(
                    `🚨 ALERT: Refund ${refund.id} FAILED for order ${order._id}. Marked reconciliationRequired=true.`
                );

                return res.status(200).json({
                    success: true,
                    message: "Refund failure recorded; marked for reconciliation",
                    refundId: refund.id,
                    reconciliationRequired: true
                });
            }

            // ==================================================
            // Unhandled Events (Acknowledged)
            // ==================================================
            console.log(`ℹ️ Webhook event '${eventType}' acknowledged with no action required`);
            return res.status(200).json({
                success: true,
                message: `Event ${eventType} acknowledged`
            });

        } catch (error) {
            console.error("❌ Webhook Processing Error:", error.message);
            return res.status(500).json({
                success: false,
                message: "Webhook processing error"
            });
        }
    };
};

const handleRazorpayWebhook = createWebhookHandler();

module.exports = {
    verifyWebhookSignature,
    createWebhookHandler,
    handleRazorpayWebhook
};
