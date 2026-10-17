const mongoose = require("mongoose");
const Razorpay = require("razorpay");
const Order = require("../models/Order");

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
}

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ======================================================
// Gateway Refund Query Helpers
// ======================================================

const fetchGatewayRefundsForPayment = async (paymentId, rzpClient) => {
    if (!paymentId || !rzpClient) return [];
    try {
        if (typeof rzpClient.payments?.fetchMultipleRefund === "function") {
            const resp = await rzpClient.payments.fetchMultipleRefund(paymentId);
            return Array.isArray(resp) ? resp : (resp?.items || []);
        } else if (typeof rzpClient.payments?.fetchRefunds === "function") {
            const resp = await rzpClient.payments.fetchRefunds(paymentId);
            return Array.isArray(resp) ? resp : (resp?.items || []);
        } else if (typeof rzpClient.refunds?.all === "function") {
            const resp = await rzpClient.refunds.all({ payment_id: paymentId });
            return Array.isArray(resp) ? resp : (resp?.items || []);
        }
    } catch (fetchErr) {
        console.warn(`⚠️ Failed to fetch refunds for payment ${paymentId} from Razorpay:`, fetchErr.message);
        throw fetchErr;
    }
    return [];
};

const fetchGatewayPayment = async (paymentId, rzpClient) => {
    if (!paymentId || !rzpClient) return null;
    try {
        if (typeof rzpClient.payments?.fetch === "function") {
            return await rzpClient.payments.fetch(paymentId);
        }
    } catch (fetchErr) {
        console.warn(`⚠️ Failed to fetch payment ${paymentId} from Razorpay:`, fetchErr.message);
        throw fetchErr;
    }
    return null;
};

// ======================================================
// Reconcile Gateway Refunds (Offline / Online)
// ======================================================

const reconcileGatewayRefunds = async (order, options = {}) => {
    const Model = options?.OrderModel || Order;
    const rzpClient = options?.razorpayClient || razorpay;
    const paymentId = order.razorpayPaymentId;

    if (!paymentId) {
        return { reconciled: false, reason: "No payment ID" };
    }

    let gatewayRefunds = [];
    let gatewayPayment = null;
    try {
        gatewayRefunds = await fetchGatewayRefundsForPayment(paymentId, rzpClient);
    } catch (err) {
        return { reconciled: false, uncertain: true, error: err };
    }

    try {
        gatewayPayment = await fetchGatewayPayment(paymentId, rzpClient);
    } catch (err) {
        // Payment fetch failure is non-fatal if refunds were fetched
    }

    // Filter refunds that strictly belong to this payment ID and have valid identifiers
    const validRefunds = gatewayRefunds.filter(rf => {
        if (!rf || typeof rf !== "object") return false;
        if (!rf.id || typeof rf.id !== "string") return false;
        if (rf.payment_id !== paymentId) {
            console.warn(`⚠️ Gateway refund ${rf.id} payment_id ${rf.payment_id} does not match order payment ${paymentId}; ignoring.`);
            return false;
        }
        if (rf.notes?.orderId && rf.notes.orderId !== order._id.toString()) {
            console.warn(`⚠️ Gateway refund ${rf.id} order note ${rf.notes.orderId} does not match order ${order._id}; ignoring.`);
            return false;
        }
        return true;
    });

    if (validRefunds.length === 0) {
        return { reconciled: false, validRefunds: [], gatewayPayment };
    }

    const totalOrderPaise = Math.round(Number(order.totalPrice) * 100);
    const processedRefunds = validRefunds.filter(rf => rf.status === "processed");
    const hasPendingRefund = validRefunds.some(rf => rf.status === "pending");
    const processedPaise = processedRefunds.reduce((sum, rf) => sum + Number(rf.amount || 0), 0);

    let cumulativePaise = 0;
    if (gatewayPayment && gatewayPayment.amount_refunded !== undefined && gatewayPayment.amount_refunded !== null) {
        const gatewayAmountRefunded = Number(gatewayPayment.amount_refunded);
        if (hasPendingRefund) {
            // A pending refund must never inflate amountRefunded even if gatewayPayment reports amount_refunded
            cumulativePaise = processedPaise;
        } else {
            cumulativePaise = processedRefunds.length > 0
                ? Math.min(gatewayAmountRefunded, processedPaise)
                : gatewayAmountRefunded;
        }
    } else {
        cumulativePaise = processedPaise;
    }
    cumulativePaise = Math.max(0, Math.min(totalOrderPaise, cumulativePaise));

    // Pending refunds must NEVER trigger isFullRefund or paymentStatus: "Refunded"
    const isFullRefund = (!hasPendingRefund) && ((gatewayPayment?.refund_status === "full") || (cumulativePaise >= totalOrderPaise));

    const allFailed = validRefunds.length > 0 && validRefunds.every(rf => rf.status === "failed");

    let newPaymentStatus = order.paymentStatus;
    if (hasPendingRefund) {
        newPaymentStatus = "RefundPending";
    } else if (isFullRefund) {
        newPaymentStatus = "Refunded";
    } else if (cumulativePaise > 0) {
        newPaymentStatus = "PartiallyRefunded";
    }

    const isRealObjectId = mongoose.Types.ObjectId.isValid(order._id);
    const canUseModel = typeof Model.findOneAndUpdate === "function" && (options?.OrderModel || isRealObjectId);

    const existingRefundIds = new Set((order.refunds || []).map(r => r.refundId));
    for (const rf of validRefunds) {
        if (!existingRefundIds.has(rf.id)) {
            const refundEntry = {
                refundId: rf.id,
                amount: Number((Number(rf.amount || 0) / 100).toFixed(2)),
                status: rf.status || "processed",
                createdAt: rf.created_at ? new Date(rf.created_at * 1000) : new Date()
            };
            const updateDoc = {
                $push: { refunds: refundEntry }
            };
            if (rf.status === "processed") {
                updateDoc.$addToSet = { processedWebhookEvents: `refund.processed:${rf.id}` };
            }
            if (canUseModel) {
                await Model.findOneAndUpdate(
                    { _id: order._id, "refunds.refundId": { $ne: rf.id } },
                    updateDoc,
                    { new: true }
                );
            } else if (typeof order.save === "function") {
                if (!order.refunds) order.refunds = [];
                order.refunds.push(refundEntry);
                if (rf.status === "processed") {
                    if (!order.processedWebhookEvents) order.processedWebhookEvents = [];
                    if (!order.processedWebhookEvents.includes(`refund.processed:${rf.id}`)) {
                        order.processedWebhookEvents.push(`refund.processed:${rf.id}`);
                    }
                }
            }
            existingRefundIds.add(rf.id);
        } else {
            // Already present in order.refunds: if status changed (e.g. pending -> processed), update status
            const existing = (order.refunds || []).find(r => r.refundId === rf.id);
            if (existing && existing.status !== rf.status) {
                existing.status = rf.status;
                if (canUseModel) {
                    const statusUpdate = {
                        $set: { "refunds.$.status": rf.status }
                    };
                    if (rf.status === "processed") {
                        statusUpdate.$addToSet = { processedWebhookEvents: `refund.processed:${rf.id}` };
                    }
                    await Model.findOneAndUpdate(
                        { _id: order._id, "refunds.refundId": rf.id },
                        statusUpdate,
                        { new: true }
                    );
                } else if (typeof order.save === "function") {
                    if (rf.status === "processed") {
                        if (!order.processedWebhookEvents) order.processedWebhookEvents = [];
                        if (!order.processedWebhookEvents.includes(`refund.processed:${rf.id}`)) {
                            order.processedWebhookEvents.push(`refund.processed:${rf.id}`);
                        }
                    }
                }
            }
        }
    }

    const updateFields = {
        amountRefunded: Number((cumulativePaise / 100).toFixed(2)),
        paymentStatus: newPaymentStatus,
        reconciliationRequired: allFailed ? true : false,
        ...(validRefunds.length > 0 ? { refundId: validRefunds[validRefunds.length - 1].id } : {})
    };
    if ((isFullRefund || hasPendingRefund) && ["Scheduled", "Pending"].includes(order.orderStatus)) {
        updateFields.orderStatus = "Cancelled";
    }

    let updatedOrder = null;
    if (canUseModel) {
        updatedOrder = await Model.findOneAndUpdate(
            { _id: order._id },
            { $set: updateFields },
            { new: true, runValidators: true }
        );
    } else if (typeof order.save === "function") {
        Object.assign(order, updateFields);
        await order.save();
        updatedOrder = order;
    }

    return {
        reconciled: true,
        isFullRefund,
        hasPendingRefund,
        refunded: isFullRefund && !hasPendingRefund,
        cumulativePaise,
        updatedOrder: updatedOrder || order,
        validRefunds
    };
};

// ======================================================
// Cancel Order + Refund If Required
// ======================================================
//
// Reusable order-cancellation business logic.
//
// Allowed:
// Scheduled → Cancelled
// Pending   → Cancelled
//
// Paid:
// Razorpay refund → Cancelled + Refunded
//
// Unpaid/Failed:
// Cancelled
//
// This service does NOT modify table status.
// Reservation controls the table lifecycle.
//
// ======================================================

const cancelOrderAndRefund = async (
    order,
    reason = "Order cancelled",
    options = {}
) => {

    if (!order) {
        const error = new Error("Order not found");
        error.statusCode = 404;
        throw error;
    }

    // 1. Check if already cancelled
    if (order.orderStatus === "Cancelled") {
        if (order.reconciliationRequired) {
            const error = new Error("Order cancellation requires manual reconciliation");
            error.statusCode = 409;
            error.reconciliationRequired = true;
            error.order = order;
            throw error;
        }
        if (order.paymentStatus === "RefundPending") {
            return {
                order,
                refunded: false,
                refundId: order.refundId || null,
                message: "Order refund is pending gateway processing"
            };
        }
        if (order.paymentStatus === "PartiallyRefunded") {
            const error = new Error("Order is only partially refunded and requires reconciliation");
            error.statusCode = 409;
            error.order = order;
            throw error;
        }
        if (["Refunded", "Pending", "Failed"].includes(order.paymentStatus)) {
            return {
                order,
                refunded: order.paymentStatus === "Refunded",
                refundId: order.refundId || (order.refunds?.[order.refunds.length - 1]?.refundId) || null,
                message: "Order is already cancelled"
            };
        }
    }

    // 2. Only Scheduled / Pending orders can be cancelled
    if (!["Scheduled", "Pending"].includes(order.orderStatus)) {
        const error = new Error(`Only scheduled or pending orders can be cancelled. Current status: ${order.orderStatus}`);
        error.statusCode = 400;
        throw error;
    }

    // ==================================================
    // PAID / PARTIALLY REFUNDED ORDER
    // ==================================================

    if (["Paid", "PartiallyRefunded"].includes(order.paymentStatus)) {
        const Model = options?.OrderModel || Order;
        const isRealObjectId = mongoose.Types.ObjectId.isValid(order._id);
        const canUseModel = typeof Model.findOneAndUpdate === "function" && (options?.OrderModel || isRealObjectId);
        const rzpClient = options?.razorpayClient || razorpay;

        // If previous outcome was uncertain, reconcile against gateway before retrying refund
        if (order.reconciliationRequired || options?.forceReconcile) {
            console.log(`ℹ️ Order ${order._id} has uncertain outcome (reconciliationRequired: true); reconciling against gateway before retry.`);
            const recon = await reconcileGatewayRefunds(order, { ...options, OrderModel: Model, razorpayClient: rzpClient });
            if (recon.uncertain) {
                return {
                    order,
                    refunded: false,
                    reconciliationRequired: true,
                    uncertain: true,
                    message: "Refund outcome remains uncertain with payment gateway; manual reconciliation required"
                };
            }
            if (recon.reconciled) {
                if (recon.hasPendingRefund) {
                    return {
                        order: recon.updatedOrder,
                        refunded: false,
                        refundId: recon.validRefunds[recon.validRefunds.length - 1]?.id,
                        message: "Order refund is pending gateway processing"
                    };
                }
                if (recon.isFullRefund) {
                    return {
                        order: recon.updatedOrder,
                        refunded: true,
                        refundId: recon.validRefunds[recon.validRefunds.length - 1]?.id,
                        message: "Order cancelled successfully and refund reconciled"
                    };
                }
                // Partial refund reconciled: update order reference so remaining calculation uses fresh amountRefunded
                order = recon.updatedOrder;
            }
        }

        const totalOrderPaise = Math.round(Number(order.totalPrice) * 100);
        const alreadyRefundedPaise = Math.round(Number(order.amountRefunded || 0) * 100);
        const remainingRefundablePaise = Math.max(0, totalOrderPaise - alreadyRefundedPaise);

        if (remainingRefundablePaise > 0) {
            if (!order.razorpayPaymentId) {
                const error = new Error("Payment was successful, but the Razorpay payment ID is missing. Refund cannot be processed automatically.");
                error.statusCode = 400;
                throw error;
            }

            console.log("=================================");
            console.log("💰 REFUND REQUEST (Remaining Balance)");
            console.log("Order:", order._id.toString());
            console.log("Payment:", order.razorpayPaymentId);
            console.log("Remaining Refund Amount (₹):", remainingRefundablePaise / 100);

            try {
                const refund = await rzpClient.payments.refund(
                    order.razorpayPaymentId,
                    {
                        amount: remainingRefundablePaise,
                        notes: {
                            orderId: order._id.toString(),
                            reason
                        }
                    }
                );

                console.log("✅ Refund created:", refund.id);

                const isRefundPending = refund.status === "pending";
                const isFullConfirmed = (!isRefundPending) && ((alreadyRefundedPaise + remainingRefundablePaise) >= totalOrderPaise);
                const newPaymentStatus = isRefundPending
                    ? "RefundPending"
                    : (isFullConfirmed ? "Refunded" : "PartiallyRefunded");

                const newAmountRefundedRupees = isRefundPending
                    ? Number((alreadyRefundedPaise / 100).toFixed(2))
                    : Number(((alreadyRefundedPaise + remainingRefundablePaise) / 100).toFixed(2));

                const refundEntry = {
                    refundId: refund.id,
                    amount: Number((remainingRefundablePaise / 100).toFixed(2)),
                    status: refund.status || "processed",
                    createdAt: new Date()
                };

                const updateOps = {
                    $set: {
                        orderStatus: "Cancelled",
                        paymentStatus: newPaymentStatus,
                        amountRefunded: newAmountRefundedRupees,
                        refundId: refund.id,
                        reconciliationRequired: false
                    },
                    $push: {
                        refunds: refundEntry
                    }
                };

                if (!isRefundPending) {
                    updateOps.$addToSet = {
                        processedWebhookEvents: `refund.processed:${refund.id}`
                    };
                }

                const cancelFilter = {
                    _id: order._id,
                    orderStatus: { $in: ["Scheduled", "Pending"] }
                };

                let updatedOrder = null;
                if (canUseModel) {
                    updatedOrder = await Model.findOneAndUpdate(
                        cancelFilter,
                        updateOps,
                        { new: true, runValidators: true }
                    );
                    if (!updatedOrder) {
                        // Re-read latest state to handle webhook concurrency race
                        const freshOrder = await (typeof Model.findById === "function" ? Model.findById(order._id) : null);
                        if (freshOrder) {
                            if (freshOrder.orderStatus === "Cancelled") {
                                if (freshOrder.reconciliationRequired) {
                                    const error = new Error("Order cancellation requires manual reconciliation");
                                    error.statusCode = 409;
                                    error.reconciliationRequired = true;
                                    error.order = freshOrder;
                                    throw error;
                                }
                                if (freshOrder.paymentStatus === "RefundPending") {
                                    return {
                                        order: freshOrder,
                                        refunded: false,
                                        refundId: freshOrder.refundId || refund.id,
                                        message: "Order cancelled and refund requested (pending gateway processing)"
                                    };
                                }
                                if (freshOrder.paymentStatus === "PartiallyRefunded" && !isRefundPending && isFullConfirmed) {
                                    const error = new Error("Order is only partially refunded and requires reconciliation");
                                    error.statusCode = 409;
                                    error.order = freshOrder;
                                    throw error;
                                }
                                if (freshOrder.paymentStatus === "Refunded") {
                                    return {
                                        order: freshOrder,
                                        refunded: true,
                                        refundId: freshOrder.refundId || refund.id,
                                        message: "Order cancelled successfully and refund initiated"
                                    };
                                }
                            }
                        }
                        const error = new Error("Order cancellation conflict: order is no longer in a cancellable state");
                        error.statusCode = 409;
                        throw error;
                    }
                } else if (typeof order.save === "function") {
                    Object.assign(order, updateOps.$set);
                    if (!order.refunds) order.refunds = [];
                    order.refunds.push(refundEntry);
                    if (updateOps.$addToSet?.processedWebhookEvents) {
                        if (!order.processedWebhookEvents) order.processedWebhookEvents = [];
                        if (!order.processedWebhookEvents.includes(updateOps.$addToSet.processedWebhookEvents)) {
                            order.processedWebhookEvents.push(updateOps.$addToSet.processedWebhookEvents);
                        }
                    }
                    await order.save();
                    updatedOrder = order;
                } else {
                    const error = new Error("Order cancellation conflict: order is no longer in a cancellable state");
                    error.statusCode = 409;
                    throw error;
                }

                return {
                    order: updatedOrder,
                    refunded: !isRefundPending && isFullConfirmed,
                    refundId: refund.id,
                    message: isRefundPending
                        ? "Order cancelled and refund requested (pending gateway processing)"
                        : "Order cancelled successfully and refund initiated"
                };

            } catch (refundError) {
                console.error("❌ Razorpay Refund Error:", refundError);

                // Detect timeouts, connection resets, or gateway errors where outcome is uncertain
                const isTimeoutOrNetworkError = (
                    refundError.code === "ETIMEDOUT" ||
                    refundError.code === "ECONNRESET" ||
                    refundError.code === "ESOCKETTIMEDOUT" ||
                    refundError.name === "TimeoutError" ||
                    (refundError.statusCode && refundError.statusCode >= 500)
                );

                const errDesc = (
                    refundError.error?.description ||
                    refundError.message ||
                    ""
                ).toLowerCase();

                const isAlreadyRefundedError = (
                    errDesc.includes("already refunded") ||
                    errDesc.includes("fully refunded") ||
                    errDesc.includes("amount exceeds") ||
                    refundError.error?.code === "BAD_REQUEST_ERROR"
                );

                if (isTimeoutOrNetworkError || isAlreadyRefundedError) {
                    console.log(`ℹ️ Refund failed with ${refundError.message || "uncertain error"}; reconciling against Razorpay gateway records.`);
                    const recon = await reconcileGatewayRefunds(order, { ...options, OrderModel: Model, razorpayClient: rzpClient });

                    if (recon.uncertain) {
                        // Gateway query also failed or timed out: outcome remains genuinely uncertain!
                        let updatedOrder = null;
                        if (canUseModel) {
                            updatedOrder = await Model.findByIdAndUpdate(
                                order._id,
                                { $set: { reconciliationRequired: true } },
                                { new: true, runValidators: true }
                            );
                        } else {
                            order.reconciliationRequired = true;
                            if (typeof order.save === "function") await order.save();
                            updatedOrder = order;
                        }
                        return {
                            order: updatedOrder || order,
                            refunded: false,
                            reconciliationRequired: true,
                            uncertain: true,
                            message: "Refund outcome could not be verified with payment gateway; order marked for manual reconciliation"
                        };
                    }

                    if (recon.reconciled && recon.hasPendingRefund) {
                        return {
                            order: recon.updatedOrder,
                            refunded: false,
                            refundId: recon.validRefunds[recon.validRefunds.length - 1]?.id,
                            message: "Order refund is pending gateway processing"
                        };
                    }

                    if (recon.reconciled && recon.isFullRefund) {
                        return {
                            order: recon.updatedOrder,
                            refunded: true,
                            refundId: recon.validRefunds[recon.validRefunds.length - 1]?.id,
                            message: "Order cancelled successfully and refund reconciled"
                        };
                    }

                    if (recon.reconciled && !recon.isFullRefund) {
                        return {
                            order: recon.updatedOrder,
                            refunded: false,
                            refundId: recon.validRefunds[recon.validRefunds.length - 1]?.id,
                            message: "Order partial refund reconciled; remaining balance requires review"
                        };
                    }
                }

                // If not reconciled and not uncertain, rethrow genuine error
                const error = new Error(
                    refundError.error?.description ||
                    refundError.message ||
                    "Order cancellation failed because the refund could not be processed"
                );
                error.statusCode = refundError.statusCode || 500;
                error.originalError = refundError;
                throw error;
            }
        } else {
            // Already fully refunded; no additional gateway call required
            const cancelFilter = {
                _id: order._id,
                orderStatus: { $in: ["Scheduled", "Pending"] }
            };

            let updatedOrder = null;
            if (canUseModel) {
                updatedOrder = await Model.findOneAndUpdate(
                    cancelFilter,
                    {
                        $set: {
                            orderStatus: "Cancelled",
                            paymentStatus: "Refunded"
                        }
                    },
                    { new: true, runValidators: true }
                );
                if (!updatedOrder) {
                    const freshOrder = await (typeof Model.findById === "function" ? Model.findById(order._id) : null);
                    if (freshOrder && freshOrder.orderStatus === "Cancelled") {
                        if (freshOrder.paymentStatus === "Refunded") {
                            return {
                                order: freshOrder,
                                refunded: false,
                                refundId: freshOrder.refundId || order.refundId || null,
                                message: "Order cancelled successfully"
                            };
                        }
                    }
                    const error = new Error("Order cancellation conflict: order is no longer in a cancellable state");
                    error.statusCode = 409;
                    throw error;
                }
            } else if (typeof order.save === "function") {
                order.orderStatus = "Cancelled";
                order.paymentStatus = "Refunded";
                await order.save();
                updatedOrder = order;
            } else {
                const error = new Error("Order cancellation conflict: order is no longer in a cancellable state");
                error.statusCode = 409;
                throw error;
            }

            return {
                order: updatedOrder,
                refunded: false,
                refundId: order.refundId || null,
                message: "Order cancelled successfully"
            };
        }
    }

    // ==================================================
    // UNPAID ORDER
    // ==================================================

    if (order.paymentStatus === "Pending") {
        const cancelFilter = {
            _id: order._id,
            orderStatus: { $in: ["Scheduled", "Pending"] },
            paymentStatus: "Pending"
        };

        let updatedOrder = null;
        const Model = options?.OrderModel || Order;
        const isRealObjectId = mongoose.Types.ObjectId.isValid(order._id);
        const canUseModel = typeof Model.findOneAndUpdate === "function" && (options?.OrderModel || isRealObjectId);

        if (canUseModel) {
            updatedOrder = await Model.findOneAndUpdate(
                cancelFilter,
                {
                    $set: {
                        orderStatus: "Cancelled"
                    }
                },
                { new: true, runValidators: true }
            );
            if (!updatedOrder) {
                const freshOrder = await (typeof Model.findById === "function" ? Model.findById(order._id) : null);
                if (freshOrder) {
                    if (freshOrder.orderStatus === "Cancelled") {
                        return {
                            order: freshOrder,
                            refunded: false,
                            refundId: null,
                            message: "Order cancelled successfully"
                        };
                    }
                    if (
                        ["Scheduled", "Pending"].includes(freshOrder.orderStatus) &&
                        ["Paid", "PartiallyRefunded"].includes(freshOrder.paymentStatus)
                    ) {
                        console.warn(
                            `⚠️ Order ${order._id} was marked Paid concurrently during unpaid cancellation; redirecting to paid cancellation with refund.`
                        );
                        return cancelOrderAndRefund(freshOrder, reason, options);
                    }
                }
                const error = new Error("Order cancellation conflict: order is no longer in a cancellable state");
                error.statusCode = 409;
                throw error;
            }
        } else if (typeof order.save === "function") {
            order.orderStatus = "Cancelled";
            await order.save();
            updatedOrder = order;
        } else {
            const error = new Error("Order cancellation conflict: order is no longer in a cancellable state");
            error.statusCode = 409;
            throw error;
        }

        return {
            order: updatedOrder,
            refunded: false,
            refundId: null,
            message: "Order cancelled successfully"
        };
    }

    // ==================================================
    // FAILED PAYMENT
    // ==================================================

    if (order.paymentStatus === "Failed") {
        const cancelFilter = {
            _id: order._id,
            orderStatus: { $in: ["Scheduled", "Pending"] },
            paymentStatus: "Failed"
        };

        let updatedOrder = null;
        const Model = options?.OrderModel || Order;
        const isRealObjectId = mongoose.Types.ObjectId.isValid(order._id);
        const canUseModel = typeof Model.findOneAndUpdate === "function" && (options?.OrderModel || isRealObjectId);

        if (canUseModel) {
            updatedOrder = await Model.findOneAndUpdate(
                cancelFilter,
                {
                    $set: {
                        orderStatus: "Cancelled"
                    }
                },
                { new: true, runValidators: true }
            );
            if (!updatedOrder) {
                const freshOrder = await (typeof Model.findById === "function" ? Model.findById(order._id) : null);
                if (freshOrder) {
                    if (freshOrder.orderStatus === "Cancelled") {
                        return {
                            order: freshOrder,
                            refunded: false,
                            refundId: null,
                            message: "Order cancelled successfully"
                        };
                    }
                    if (
                        ["Scheduled", "Pending"].includes(freshOrder.orderStatus) &&
                        ["Paid", "PartiallyRefunded"].includes(freshOrder.paymentStatus)
                    ) {
                        console.warn(
                            `⚠️ Order ${order._id} was marked Paid concurrently during failed cancellation; redirecting to paid cancellation with refund.`
                        );
                        return cancelOrderAndRefund(freshOrder, reason, options);
                    }
                }
                const error = new Error("Order cancellation conflict: order is no longer in a cancellable state");
                error.statusCode = 409;
                throw error;
            }
        } else if (typeof order.save === "function") {
            order.orderStatus = "Cancelled";
            await order.save();
            updatedOrder = order;
        } else {
            const error = new Error("Order cancellation conflict: order is no longer in a cancellable state");
            error.statusCode = 409;
            throw error;
        }

        return {
            order: updatedOrder,
            refunded: false,
            refundId: null,
            message: "Order cancelled successfully"
        };
    }

    // ==================================================
    // REFUND PENDING
    // ==================================================

    if (order.paymentStatus === "RefundPending") {
        const error = new Error("Order refund is already pending");
        error.statusCode = 400;
        throw error;
    }

    // ==================================================
    // UNKNOWN PAYMENT STATUS
    // ==================================================

    const error = new Error(`Order cannot be cancelled with payment status: ${order.paymentStatus}`);
    error.statusCode = 400;
    throw error;
};

// ======================================================
// Cancel All Cancellable Orders For A Reservation
// ======================================================
//
// Scheduled / Pending orders:
// → Cancel
// → Refund if Paid
//
// Preparing / Ready / Delivered:
// → Block reservation cancellation
//
// ======================================================

const cancelReservationOrders = async (
    reservationId,
    reason = "Reservation cancelled"
) => {

    const orders =
        await Order.find({

            reservation:
                reservationId,

            orderStatus: {

                $in: [

                    "Scheduled",

                    "Pending",

                    "Preparing",

                    "Ready",

                    "Delivered"

                ]

            }

        });


    // ==================================================
    // Check For Orders Already Being Processed
    // ==================================================

    const activeFoodOrders =
        orders.filter(

            order =>

                [

                    "Preparing",

                    "Ready",

                    "Delivered"

                ].includes(
                    order.orderStatus
                )

        );


    if (
        activeFoodOrders.length > 0
    ) {

        const error =
            new Error(
                "Reservation cannot be cancelled because an associated food order is already being prepared, ready, or delivered"
            );

        error.statusCode = 400;

        throw error;
    }


    // ==================================================
    // Cancel Scheduled / Pending Orders
    // ==================================================

    const results = [];


    for (
        const order of orders
    ) {

        const result =
            await cancelOrderAndRefund(
                order,
                reason
            );

        if (result.reconciliationRequired || result.uncertain) {
            const err = new Error(`Order ${order._id} refund outcome is uncertain and requires manual reconciliation`);
            err.statusCode = 502;
            err.reconciliationRequired = true;
            throw err;
        }

        results.push(
            result
        );

    }


    return results;
};


// ======================================================
// Export
// ======================================================

module.exports = {

    cancelOrderAndRefund,

    cancelReservationOrders,

    reconcileGatewayRefunds

};