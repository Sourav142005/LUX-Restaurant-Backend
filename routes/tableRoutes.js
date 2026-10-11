const express = require("express");

const router = express.Router();

const {
    getTables,
    createTable,
    updateTableStatus,
    deleteTable
} = require("../controllers/tableController");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");


// Customer + Admin
router.get("/", auth, getTables);


// Admin
router.post("/", auth, admin, createTable);

router.put(
    "/:id/status",
    auth,
    admin,
    updateTableStatus
);

router.delete(
    "/:id",
    auth,
    admin,
    deleteTable
);


module.exports = router;