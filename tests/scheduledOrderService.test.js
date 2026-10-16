const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
    processScheduledOrders,
    getISTDateString,
    getISTTimeString,
    getReservationDateString
} = require("../services/scheduledOrderService");

describe("Scheduled Order Processor - Offline Unit Tests", () => {

    // ==========================================================
    // a) Paid PayNow scheduled order activates when reservation is active
    // ==========================================================
    test("a) Paid PayNow scheduled order activates when reservation is active", async () => {
        const orderId = "order_paynow_paid";
        const resId = "res_active_1";
        const tableId = "table_1";

        const mockOrder = {
            _id: orderId,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: resId
        };

        const mockReservation = {
            _id: resId,
            status: "Confirmed",
            table: tableId,
            reservationDate: new Date("2026-10-15T00:00:00.000Z"),
            startTime: "19:00",
            endTime: "21:00"
        };

        let tableUpdateFilter = null;
        let tableUpdateData = null;
        const mockTable = {
            _id: tableId,
            tableNumber: 10,
            status: "Reserved"
        };

        let orderUpdated = false;
        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async (filter, update) => {
                if (filter._id === orderId && filter.orderStatus === "Scheduled") {
                    orderUpdated = true;
                    return { ...mockOrder, orderStatus: update.$set.orderStatus, table: update.$set.table };
                }
                return null;
            }
        };

        const MockReservation = {
            findById: async (id) => (id === resId ? mockReservation : null),
            findOne: async () => null
        };

        const MockTable = {
            findById: async (id) => (id === tableId ? mockTable : null),
            findOneAndUpdate: async (filter, update) => {
                if (filter._id === tableId) {
                    tableUpdateFilter = filter;
                    tableUpdateData = update;
                    mockTable.status = update.$set.status;
                    return mockTable;
                }
                return null;
            }
        };

        // 19:30 IST on 2026-10-15 => UTC is 14:00 on 2026-10-15
        const testDate = new Date("2026-10-15T14:00:00.000Z");

        const count = await processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        assert.equal(count, 1, "Expected 1 order to be activated");
        assert.equal(orderUpdated, true, "Expected order to transition to Pending");
        assert.equal(mockTable.status, "Occupied", "Expected table status to be updated to Occupied");
        assert.deepEqual(
            tableUpdateFilter,
            { _id: tableId, status: { $in: ["Available", "Reserved", "Occupied"] } },
            "Expected atomic Table.findOneAndUpdate filter to check allowed statuses"
        );
        assert.deepEqual(
            tableUpdateData,
            { $set: { status: "Occupied" } },
            "Expected atomic Table.findOneAndUpdate to set status to Occupied"
        );
    });

    // ==========================================================
    // b) Unpaid PayNow scheduled order is skipped and remains Scheduled
    // ==========================================================
    test("b) Unpaid PayNow scheduled order is skipped and remains Scheduled", async () => {
        const orderId = "order_paynow_unpaid";
        const resId = "res_active_2";
        const tableId = "table_2";

        const mockOrder = {
            _id: orderId,
            orderStatus: "Scheduled",
            paymentStatus: "Pending", // Unpaid
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: resId
        };

        const mockReservation = {
            _id: resId,
            status: "Confirmed",
            table: tableId,
            reservationDate: new Date("2026-10-15T00:00:00.000Z"),
            startTime: "19:00",
            endTime: "21:00"
        };

        const mockTable = {
            _id: tableId,
            tableNumber: 11,
            status: "Reserved",
            save: async () => {}
        };

        let findOneAndUpdateCalled = false;
        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async () => {
                findOneAndUpdateCalled = true;
                return null;
            }
        };

        const MockReservation = {
            findById: async () => mockReservation
        };

        const MockTable = {
            findById: async () => mockTable
        };

        const testDate = new Date("2026-10-15T14:00:00.000Z"); // 19:30 IST

        const count = await processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        assert.equal(count, 0, "Unpaid PayNow order must not be activated");
        assert.equal(findOneAndUpdateCalled, false, "Order must not be updated");
        assert.equal(mockOrder.orderStatus, "Scheduled", "Order must remain Scheduled");
    });

    // ==========================================================
    // c) Unpaid PayAfterDining scheduled order activates when reservation is active
    // ==========================================================
    test("c) Unpaid PayAfterDining scheduled order activates when reservation is active", async () => {
        const orderId = "order_payafterdining_unpaid";
        const resId = "res_active_3";
        const tableId = "table_3";

        const mockOrder = {
            _id: orderId,
            orderStatus: "Scheduled",
            paymentStatus: "Pending", // Unpaid is allowed for PayAfterDining
            paymentPolicy: "PayAfterDining",
            orderType: "Dine-In",
            reservation: resId
        };

        const mockReservation = {
            _id: resId,
            status: "Confirmed",
            table: tableId,
            reservationDate: new Date("2026-10-15T00:00:00.000Z"),
            startTime: "12:00",
            endTime: "14:00"
        };

        let tableUpdated = false;
        const mockTable = {
            _id: tableId,
            tableNumber: 5,
            status: "Available"
        };

        let orderActivated = false;
        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async (filter, update) => {
                if (filter._id === orderId && filter.orderStatus === "Scheduled") {
                    orderActivated = true;
                    return { ...mockOrder, orderStatus: update.$set.orderStatus, table: update.$set.table };
                }
                return null;
            }
        };

        const MockReservation = {
            findById: async (id) => (id === resId ? mockReservation : null),
            findOne: async () => null
        };

        const MockTable = {
            findById: async (id) => (id === tableId ? mockTable : null),
            findOneAndUpdate: async (filter, update) => {
                if (filter._id === tableId) {
                    tableUpdated = true;
                    mockTable.status = update.$set.status;
                    return mockTable;
                }
                return null;
            }
        };

        // 13:00 IST on 2026-10-15 => UTC is 07:30 on 2026-10-15
        const testDate = new Date("2026-10-15T07:30:00.000Z");

        const count = await processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        assert.equal(count, 1, "Unpaid PayAfterDining order must activate when reservation is active");
        assert.equal(orderActivated, true, "Order state must be updated to Pending");
        assert.equal(mockTable.status, "Occupied", "Table must be set to Occupied");
        assert.equal(tableUpdated, true, "Table findOneAndUpdate must be called");
    });

    // ==========================================================
    // d) Cancelled reservation or cancelled order is skipped
    // ==========================================================
    test("d1) Cancelled order is skipped", async () => {
        const mockOrder = {
            _id: "order_cancelled",
            orderStatus: "Cancelled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: "res_any"
        };

        let updateCalled = false;
        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async () => {
                updateCalled = true;
                return null;
            }
        };

        const count = await processScheduledOrders({
            Order: MockOrder,
            Reservation: { findById: async () => null },
            Table: { findById: async () => null }
        });

        assert.equal(count, 0, "Cancelled order must be skipped");
        assert.equal(updateCalled, false, "Order must not be updated");
    });

    test("d2) Cancelled reservation is skipped", async () => {
        const orderId = "order_with_cancelled_res";
        const resId = "res_cancelled";

        const mockOrder = {
            _id: orderId,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: resId
        };

        const mockReservation = {
            _id: resId,
            status: "Cancelled", // Cancelled!
            table: "table_1",
            reservationDate: new Date("2026-10-15T00:00:00.000Z"),
            startTime: "19:00",
            endTime: "21:00"
        };

        let updateCalled = false;
        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async () => {
                updateCalled = true;
                return null;
            }
        };

        const MockReservation = {
            findById: async (id) => (id === resId ? mockReservation : null)
        };

        const testDate = new Date("2026-10-15T14:00:00.000Z"); // 19:30 IST

        const count = await processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: { findById: async () => null }
        });

        assert.equal(count, 0, "Order with cancelled reservation must be skipped");
        assert.equal(updateCalled, false, "Order must not be updated");
    });

    // ==========================================================
    // e) Table marked Occupied by current active reservation is not falsely rejected
    // ==========================================================
    test("e) Table marked Occupied by current active reservation is not falsely rejected", async () => {
        const orderId = "order_occupied_legitimate";
        const resId = "res_active_legit";
        const tableId = "table_occupied_legit";

        const mockOrder = {
            _id: orderId,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: resId
        };

        const mockReservation = {
            _id: resId,
            status: "Confirmed",
            table: tableId,
            reservationDate: new Date("2026-10-15T00:00:00.000Z"),
            startTime: "20:00",
            endTime: "22:00"
        };

        const mockTable = {
            _id: tableId,
            tableNumber: 7,
            status: "Occupied", // Already marked Occupied by syncTableStatus
            save: async () => {}
        };

        let orderActivated = false;
        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async (filter, update) => {
                if (filter._id === orderId && filter.orderStatus === "Scheduled") {
                    orderActivated = true;
                    return { ...mockOrder, orderStatus: update.$set.orderStatus, table: update.$set.table };
                }
                return null;
            }
        };

        const MockReservation = {
            findById: async (id) => (id === resId ? mockReservation : null),
            // No conflicting reservation exists
            findOne: async () => null
        };

        const MockTable = {
            findById: async (id) => (id === tableId ? mockTable : null),
            findOneAndUpdate: async () => mockTable
        };

        // 20:30 IST on 2026-10-15 => UTC is 15:00 on 2026-10-15
        const testDate = new Date("2026-10-15T15:00:00.000Z");

        const count = await processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        assert.equal(count, 1, "Order must activate even if table is Occupied, when no conflict exists");
        assert.equal(orderActivated, true, "Order must transition to Pending");
    });

    // ==========================================================
    // f) Table marked Occupied by another/conflicting reservation is skipped
    // ==========================================================
    test("f) Table marked Occupied by another/conflicting reservation is skipped", async () => {
        const orderId = "order_occupied_conflict";
        const resId = "res_for_order";
        const conflictingResId = "res_conflicting";
        const tableId = "table_occupied_conflict";

        const mockOrder = {
            _id: orderId,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: resId
        };

        const mockReservation = {
            _id: resId,
            status: "Confirmed",
            table: tableId,
            reservationDate: new Date("2026-10-15T00:00:00.000Z"),
            startTime: "18:00",
            endTime: "20:00"
        };

        const mockConflictingReservation = {
            _id: conflictingResId,
            status: "Confirmed",
            table: tableId,
            reservationDate: new Date("2026-10-15T00:00:00.000Z"),
            startTime: "18:00",
            endTime: "20:00"
        };

        const mockTable = {
            _id: tableId,
            tableNumber: 8,
            status: "Occupied",
            save: async () => {}
        };

        let updateCalled = false;
        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async () => {
                updateCalled = true;
                return null;
            }
        };

        const MockReservation = {
            findById: async (id) => (id === resId ? mockReservation : null),
            // Conflicting reservation is returned!
            findOne: async () => mockConflictingReservation
        };

        const MockTable = {
            findById: async (id) => (id === tableId ? mockTable : null)
        };

        const testDate = new Date("2026-10-15T13:00:00.000Z"); // 18:30 IST

        const count = await processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        assert.equal(count, 0, "Order must be skipped if table is occupied by conflicting reservation");
        assert.equal(updateCalled, false, "Order must not be updated");
    });

    // ==========================================================
    // g) Concurrent scheduler runs do not double-activate the same order
    // ==========================================================
    test("g1) In-process concurrency lock prevents overlapping executions", async () => {
        let resolveFirstCall;
        const firstCallWaitPromise = new Promise((resolve) => {
            resolveFirstCall = resolve;
        });

        const mockOrder = {
            _id: "order_concurrent_1",
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: "res_concurrent"
        };

        const MockOrder = {
            find: async () => {
                await firstCallWaitPromise;
                return [mockOrder];
            },
            findOneAndUpdate: async () => mockOrder
        };

        const MockReservation = {
            findById: async () => ({
                _id: "res_concurrent",
                status: "Confirmed",
                table: "table_c",
                reservationDate: new Date("2026-10-15T00:00:00.000Z"),
                startTime: "19:00",
                endTime: "21:00"
            }),
            findOne: async () => null
        };

        const MockTable = {
            findById: async () => ({
                _id: "table_c",
                status: "Available"
            }),
            findOneAndUpdate: async () => ({
                _id: "table_c",
                status: "Occupied"
            })
        };

        const testDate = new Date("2026-10-15T14:00:00.000Z");

        // Start first call (will block inside Order.find)
        const firstPromise = processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        // Immediately start second call while first is in progress
        const secondPromise = processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        // The second call must immediately return 0 because isProcessing is true
        const secondResult = await secondPromise;
        assert.equal(secondResult, 0, "Overlapping execution must immediately return 0");

        // Now let first call proceed and complete
        resolveFirstCall();
        const firstResult = await firstPromise;
        assert.equal(firstResult, 1, "First execution must complete normally");
    });

    test("g2) Atomic state transition prevents double activation across instances", async () => {
        const mockOrder = {
            _id: "order_concurrent_2",
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: "res_concurrent_2"
        };

        const MockOrder = {
            find: async () => [mockOrder],
            // Simulate another instance winning the atomic race: findOneAndUpdate returns null
            findOneAndUpdate: async () => null
        };

        const MockReservation = {
            findById: async () => ({
                _id: "res_concurrent_2",
                status: "Confirmed",
                table: "table_c2",
                reservationDate: new Date("2026-10-15T00:00:00.000Z"),
                startTime: "19:00",
                endTime: "21:00"
            }),
            findOne: async () => null
        };

        let tableSaved = false;
        const MockTable = {
            findById: async () => ({
                _id: "table_c2",
                status: "Reserved",
                save: async () => {
                    tableSaved = true;
                }
            })
        };

        const testDate = new Date("2026-10-15T14:00:00.000Z");

        const count = await processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        assert.equal(count, 0, "Order must not activate if atomic update returns null");
        assert.equal(tableSaved, false, "Table must not be modified if order update failed");
    });

    // ==========================================================
    // h) Timezone edge cases: UTC vs Asia/Kolkata date/time comparison
    // ==========================================================
    test("h1) Timezone: UTC 14:00 corresponds to 19:30 IST and activates a 19:00-21:00 IST reservation", async () => {
        const testDateUTC = new Date("2026-10-15T14:00:00.000Z"); // 14:00 UTC

        // In UTC, hours is 14. In IST, hours is 19:30.
        assert.equal(getISTTimeString(testDateUTC), "19:30");
        assert.equal(getISTDateString(testDateUTC), "2026-10-15");

        const mockOrder = {
            _id: "order_tz_1",
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: "res_tz_1"
        };

        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async () => mockOrder
        };

        const MockReservation = {
            findById: async () => ({
                _id: "res_tz_1",
                status: "Confirmed",
                table: "table_tz_1",
                reservationDate: "2026-10-15",
                startTime: "19:00",
                endTime: "21:00"
            }),
            findOne: async () => null
        };

        const MockTable = {
            findById: async () => ({
                _id: "table_tz_1",
                status: "Reserved"
            }),
            findOneAndUpdate: async () => ({
                _id: "table_tz_1",
                status: "Occupied"
            })
        };

        const count = await processScheduledOrders({
            nowDate: testDateUTC,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        assert.equal(count, 1, "Must activate order using IST time even when server clock is UTC");
    });

    test("h2) Timezone: UTC 19:00 Oct 15 corresponds to 00:30 IST Oct 16 and activates midnight reservation", async () => {
        const testDateUTC = new Date("2026-10-15T19:00:00.000Z"); // 19:00 UTC Oct 15

        // In IST, date is 2026-10-16 and time is 00:30
        assert.equal(getISTDateString(testDateUTC), "2026-10-16");
        assert.equal(getISTTimeString(testDateUTC), "00:30");

        const mockOrder = {
            _id: "order_tz_2",
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: "res_tz_2"
        };

        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async () => mockOrder
        };

        const MockReservation = {
            findById: async () => ({
                _id: "res_tz_2",
                status: "Confirmed",
                table: "table_tz_2",
                reservationDate: new Date("2026-10-16T00:00:00.000Z"),
                startTime: "00:00",
                endTime: "02:00"
            }),
            findOne: async () => null
        };

        const MockTable = {
            findById: async () => ({
                _id: "table_tz_2",
                status: "Available"
            }),
            findOneAndUpdate: async () => ({
                _id: "table_tz_2",
                status: "Occupied"
            })
        };

        const count = await processScheduledOrders({
            nowDate: testDateUTC,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        assert.equal(count, 1, "Must activate reservation across midnight IST boundary");
    });

    test("h3) getReservationDateString helper formats correctly for Date objects, strings, and nulls", () => {
        assert.equal(getReservationDateString("2026-10-15"), "2026-10-15");
        assert.equal(getReservationDateString(new Date("2026-10-15T00:00:00.000Z")), "2026-10-15");
        assert.equal(getReservationDateString(null), "");
        assert.equal(getReservationDateString(undefined), "");
        assert.equal(getReservationDateString("invalid-date"), "");
    });

    // ==========================================================
    // i) Table update failure triggers safe handling/rollback
    // ==========================================================
    test("i) Table update failure triggers safe handling/rollback", async () => {
        const orderId = "order_rollback";
        const resId = "res_rollback";
        const tableId = "table_rollback";

        const mockOrder = {
            _id: orderId,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: resId
        };

        const mockReservation = {
            _id: resId,
            status: "Confirmed",
            table: tableId,
            reservationDate: "2026-10-15",
            startTime: "19:00",
            endTime: "21:00"
        };

        const mockTable = {
            _id: tableId,
            tableNumber: 15,
            status: "Reserved"
        };

        let rollbackCalled = false;
        let rollbackFilter = null;
        let rollbackData = null;

        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async (filter, update) => {
                // Initial activation update
                if (filter.orderStatus === "Scheduled") {
                    return { ...mockOrder, orderStatus: update.$set.orderStatus, table: update.$set.table };
                }
                // Rollback update
                if (filter.orderStatus === "Pending") {
                    rollbackCalled = true;
                    rollbackFilter = filter;
                    rollbackData = update;
                    return { ...mockOrder, orderStatus: update.$set.orderStatus, table: update.$set.table };
                }
                return null;
            }
        };

        const MockReservation = {
            findById: async () => mockReservation,
            findOne: async () => null
        };

        const MockTable = {
            findById: async () => mockTable,
            findOneAndUpdate: async () => {
                throw new Error("Simulated database failure during Table.findOneAndUpdate()");
            }
        };

        const testDate = new Date("2026-10-15T14:00:00.000Z"); // 19:30 IST

        const count = await processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: MockReservation,
            Table: MockTable
        });

        assert.equal(count, 0, "Failed table update must not count as activated");
        assert.equal(rollbackCalled, true, "Rollback findOneAndUpdate must be called");
        assert.deepEqual(
            rollbackFilter,
            { _id: orderId, orderStatus: "Pending" },
            "Rollback filter must require orderStatus: Pending"
        );
        assert.deepEqual(
            rollbackData,
            { $set: { orderStatus: "Scheduled", table: null } },
            "Rollback must restore orderStatus to Scheduled and clear table"
        );
    });

    test("i2) Table update failure rollback does not overwrite concurrent status change", async () => {
        const orderId = "order_rollback_concurrent";
        const resId = "res_rollback_concurrent";
        const tableId = "table_rollback_concurrent";

        const mockOrder = {
            _id: orderId,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: resId
        };

        const mockReservation = {
            _id: resId,
            status: "Confirmed",
            table: tableId,
            reservationDate: "2026-10-15",
            startTime: "19:00",
            endTime: "21:00"
        };

        const mockTable = {
            _id: tableId,
            tableNumber: 16,
            status: "Reserved"
        };

        let rollbackAttempted = false;

        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async (filter, update) => {
                // Initial activation update succeeds
                if (filter.orderStatus === "Scheduled") {
                    return { ...mockOrder, orderStatus: update.$set.orderStatus, table: update.$set.table };
                }
                // Simulate order was changed concurrently (e.g. to Cancelled) -> findOneAndUpdate with orderStatus: Pending returns null
                if (filter.orderStatus === "Pending") {
                    rollbackAttempted = true;
                    return null; // Condition not met!
                }
                return null;
            }
        };

        const MockTable = {
            findById: async () => mockTable,
            findOneAndUpdate: async () => {
                throw new Error("Simulated database failure during Table.findOneAndUpdate()");
            }
        };

        const testDate = new Date("2026-10-15T14:00:00.000Z");

        const count = await processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: { findById: async () => mockReservation, findOne: async () => null },
            Table: MockTable
        });

        assert.equal(count, 0, "Failed table update must not count as activated");
        assert.equal(rollbackAttempted, true, "Rollback attempt must be made");
    });

    test("i3) Atomic Table.findOneAndUpdate returning null triggers safe order rollback", async () => {
        const orderId = "order_table_race";
        const resId = "res_table_race";
        const tableId = "table_race";

        const mockOrder = {
            _id: orderId,
            orderStatus: "Scheduled",
            paymentStatus: "Paid",
            paymentPolicy: "PayNow",
            orderType: "Dine-In",
            reservation: resId
        };

        const mockReservation = {
            _id: resId,
            status: "Confirmed",
            table: tableId,
            reservationDate: "2026-10-15",
            startTime: "19:00",
            endTime: "21:00"
        };

        const mockTable = {
            _id: tableId,
            tableNumber: 17,
            status: "Reserved"
        };

        let rollbackCalled = false;
        let rollbackFilter = null;
        let rollbackData = null;

        const MockOrder = {
            find: async () => [mockOrder],
            findOneAndUpdate: async (filter, update) => {
                if (filter.orderStatus === "Scheduled") {
                    return { ...mockOrder, orderStatus: update.$set.orderStatus, table: update.$set.table };
                }
                if (filter.orderStatus === "Pending") {
                    rollbackCalled = true;
                    rollbackFilter = filter;
                    rollbackData = update;
                    return { ...mockOrder, orderStatus: update.$set.orderStatus, table: update.$set.table };
                }
                return null;
            }
        };

        // Table.findOneAndUpdate returns null, simulating table state changed concurrently to an invalid status
        const MockTable = {
            findById: async () => mockTable,
            findOneAndUpdate: async () => null
        };

        const testDate = new Date("2026-10-15T14:00:00.000Z");

        const count = await processScheduledOrders({
            nowDate: testDate,
            Order: MockOrder,
            Reservation: { findById: async () => mockReservation, findOne: async () => null },
            Table: MockTable
        });

        assert.equal(count, 0, "Failed conditional table update must not count as activated");
        assert.equal(rollbackCalled, true, "Rollback findOneAndUpdate must be called");
        assert.deepEqual(
            rollbackFilter,
            { _id: orderId, orderStatus: "Pending" },
            "Rollback filter must require orderStatus: Pending"
        );
        assert.deepEqual(
            rollbackData,
            { $set: { orderStatus: "Scheduled", table: null } },
            "Rollback must restore orderStatus to Scheduled and clear table"
        );
    });
});
