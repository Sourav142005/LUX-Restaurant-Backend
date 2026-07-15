const express = require("express");
const router = express.Router();

const {
    createCategory,
    getCategories
} = require("../controllers/categoryController");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

router.post("/", auth, admin, createCategory);

router.get("/", getCategories);
module.exports = router;