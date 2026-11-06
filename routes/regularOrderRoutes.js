const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const {
    getCollections,
    getCollectionById,
    createCollection,
    renameCollection,
    deleteCollection,
    addDishToCollection,
    updateDishQuantity,
    removeDishFromCollection,
    validateAndPrepareReorder
} = require("../controllers/regularOrderController");

// All regular order collection operations require authenticated customer identity
router.use(auth);

router.get("/", getCollections);
router.post("/", createCollection);

router.get("/:id", getCollectionById);
router.put("/:id", renameCollection);
router.delete("/:id", deleteCollection);

router.post("/:id/items", addDishToCollection);
router.put("/:id/items/:menuId", updateDishQuantity);
router.delete("/:id/items/:menuId", removeDishFromCollection);

router.post("/:id/reorder", validateAndPrepareReorder);

module.exports = router;

