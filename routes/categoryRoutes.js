const express = require("express");

const router = express.Router();

const {
    createCategory,
    getCategories,
    updateCategory,
    deleteCategory
} = require("../controllers/categoryController");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");


// Public
router.get("/", getCategories);


// Admin
router.post(
    "/",
    auth,
    admin,
    createCategory
);

router.put(
    "/:id",
    auth,
    admin,
    updateCategory
);

router.delete(
    "/:id",
    auth,
    admin,
    deleteCategory
);


module.exports = router;