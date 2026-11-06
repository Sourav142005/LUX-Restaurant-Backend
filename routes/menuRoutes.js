const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

const {
    getMenu,
    getMenuById,
    getMostOrderedDishes,
    getSeasonalSpecials,
    updateSeasonalSpecial,
    createMenu,
    updateMenu,
    deleteMenu
} = require("../controllers/menuController");

// Optional (for debugging)
// console.log("Menu Routes Loaded");
// console.log({ getMenu, getMenuById, createMenu });

router.get("/", getMenu);
router.get("/most-ordered", getMostOrderedDishes);
router.get("/seasonal-specials", getSeasonalSpecials);
router.get("/:id", getMenuById);

router.post("/", auth, admin, createMenu);
router.put("/:id/seasonal-special", auth, admin, updateSeasonalSpecial);
router.put("/:id", auth, admin, updateMenu);
router.delete("/:id", auth, admin, deleteMenu);

module.exports = router;