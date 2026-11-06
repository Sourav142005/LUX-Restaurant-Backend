const mongoose = require("mongoose");
const RegularOrder = require("../models/RegularOrder");
const Menu = require("../models/Menu");

// Helper: validate ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// ======================================================
// 1. Get All Collections for Authenticated Customer
// GET /api/regular-orders
// ======================================================
const getCollections = async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const collections = await RegularOrder.find({ user: req.user.id })
            .populate({
                path: "items.menu",
                populate: { path: "category", select: "name" }
            })
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: collections.length,
            collections
        });
    } catch (error) {
        console.error("❌ Failed to fetch regular orders:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to fetch collections"
        });
    }
};

// ======================================================
// 2. Get Single Collection by ID
// GET /api/regular-orders/:id
// ======================================================
const getCollectionById = async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid collection ID"
            });
        }

        const collection = await RegularOrder.findById(id);

        if (!collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found"
            });
        }

        // Ownership enforcement
        if (collection.user.toString() !== req.user.id.toString()) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You do not own this collection"
            });
        }

        if (typeof collection.populate === "function") {
            await collection.populate({
                path: "items.menu",
                populate: { path: "category", select: "name" }
            });
        }

        return res.status(200).json({
            success: true,
            collection
        });
    } catch (error) {
        console.error("❌ Failed to fetch collection:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to fetch collection"
        });
    }
};

// ======================================================
// 3. Create Collection
// POST /api/regular-orders
// ======================================================
const createCollection = async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const { name, items } = req.body;

        // Name validation
        if (!name || typeof name !== "string" || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Collection name is required"
            });
        }

        const trimmedName = name.trim();
        if (trimmedName.length > 60) {
            return res.status(400).json({
                success: false,
                message: "Collection name cannot exceed 60 characters"
            });
        }

        const nameLower = trimmedName.toLowerCase();

        // Check for duplicate name for this customer
        const existing = await RegularOrder.findOne({
            user: req.user.id,
            nameLower
        });

        if (existing) {
            return res.status(400).json({
                success: false,
                message: "A collection with this name already exists"
            });
        }

        // Optional items validation if provided at creation
        const validatedItems = [];
        if (Array.isArray(items) && items.length > 0) {
            const seenMenuIds = new Set();
            for (const it of items) {
                const menuId = it.menuId || it.menu || (it._id && !it.name ? it._id : null);
                if (!menuId || !isValidObjectId(menuId)) {
                    return res.status(400).json({
                        success: false,
                        message: "Invalid menu item ID in collection"
                    });
                }
                const menuIdStr = menuId.toString();
                if (seenMenuIds.has(menuIdStr)) {
                    continue; // Skip duplicate within initial list
                }
                seenMenuIds.add(menuIdStr);

                const menuDoc = await Menu.findById(menuId);
                if (!menuDoc) {
                    return res.status(404).json({
                        success: false,
                        message: `Menu item not found: ${menuId}`
                    });
                }

                const qty = Number(it.quantity) || 1;
                if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
                    return res.status(400).json({
                        success: false,
                        message: "Quantity must be an integer between 1 and 99"
                    });
                }

                validatedItems.push({
                    menu: menuDoc._id,
                    quantity: qty
                });
            }
        }

        const collection = await RegularOrder.create({
            user: req.user.id,
            name: trimmedName,
            nameLower,
            items: validatedItems
        });

        await collection.populate({
            path: "items.menu",
            populate: { path: "category", select: "name" }
        });

        return res.status(201).json({
            success: true,
            message: "Collection created successfully",
            collection
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: "A collection with this name already exists"
            });
        }
        console.error("❌ Failed to create collection:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to create collection"
        });
    }
};

// ======================================================
// 4. Rename Collection
// PUT /api/regular-orders/:id
// ======================================================
const renameCollection = async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const { id } = req.params;
        const { name } = req.body;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid collection ID"
            });
        }

        if (!name || typeof name !== "string" || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Collection name is required"
            });
        }

        const trimmedName = name.trim();
        if (trimmedName.length > 60) {
            return res.status(400).json({
                success: false,
                message: "Collection name cannot exceed 60 characters"
            });
        }

        const collection = await RegularOrder.findById(id);
        if (!collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found"
            });
        }

        // Ownership enforcement
        if (collection.user.toString() !== req.user.id.toString()) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You do not own this collection"
            });
        }

        const nameLower = trimmedName.toLowerCase();

        // Check duplicate name on other collection
        const existing = await RegularOrder.findOne({
            _id: { $ne: id },
            user: req.user.id,
            nameLower
        });

        if (existing) {
            return res.status(400).json({
                success: false,
                message: "A collection with this name already exists"
            });
        }

        collection.name = trimmedName;
        collection.nameLower = nameLower;
        await collection.save();

        await collection.populate({
            path: "items.menu",
            populate: { path: "category", select: "name" }
        });

        return res.status(200).json({
            success: true,
            message: "Collection renamed successfully",
            collection
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: "A collection with this name already exists"
            });
        }
        console.error("❌ Failed to rename collection:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to rename collection"
        });
    }
};

// ======================================================
// 5. Delete Collection
// DELETE /api/regular-orders/:id
// ======================================================
const deleteCollection = async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid collection ID"
            });
        }

        const collection = await RegularOrder.findById(id);
        if (!collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found"
            });
        }

        // Ownership enforcement
        if (collection.user.toString() !== req.user.id.toString()) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You do not own this collection"
            });
        }

        await RegularOrder.findByIdAndDelete(id);

        return res.status(200).json({
            success: true,
            message: "Collection deleted successfully"
        });
    } catch (error) {
        console.error("❌ Failed to delete collection:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to delete collection"
        });
    }
};

// ======================================================
// 6. Add Dish to Collection
// POST /api/regular-orders/:id/items
// ======================================================
const addDishToCollection = async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const { id } = req.params;
        const { menuId, quantity } = req.body;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid collection ID"
            });
        }

        if (!menuId || !isValidObjectId(menuId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid menu ID"
            });
        }

        // Validate quantity (default 1)
        const qty = quantity !== undefined ? Number(quantity) : 1;
        if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
            return res.status(400).json({
                success: false,
                message: "Quantity must be an integer between 1 and 99"
            });
        }

        const collection = await RegularOrder.findById(id);
        if (!collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found"
            });
        }

        // Ownership enforcement
        if (collection.user.toString() !== req.user.id.toString()) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You do not own this collection"
            });
        }

        // Validate menu item exists
        const menuDoc = await Menu.findById(menuId);
        if (!menuDoc) {
            return res.status(404).json({
                success: false,
                message: "Menu item not found"
            });
        }

        // Prevent duplicate dishes inside collection
        const existingIndex = collection.items.findIndex(
            (it) => it.menu.toString() === menuId.toString()
        );

        if (existingIndex !== -1) {
            return res.status(400).json({
                success: false,
                message: "Dish already exists in this collection"
            });
        }

        collection.items.push({
            menu: menuDoc._id,
            quantity: qty
        });

        await collection.save();

        await collection.populate({
            path: "items.menu",
            populate: { path: "category", select: "name" }
        });

        return res.status(200).json({
            success: true,
            message: "Dish added to collection",
            collection
        });
    } catch (error) {
        console.error("❌ Failed to add dish to collection:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to add dish"
        });
    }
};

// ======================================================
// 7. Update Dish Quantity in Collection
// PUT /api/regular-orders/:id/items/:menuId
// ======================================================
const updateDishQuantity = async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const { id, menuId } = req.params;
        const { quantity } = req.body;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid collection ID"
            });
        }

        if (!menuId || !isValidObjectId(menuId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid menu ID"
            });
        }

        const qty = Number(quantity);
        if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
            return res.status(400).json({
                success: false,
                message: "Quantity must be an integer between 1 and 99"
            });
        }

        const collection = await RegularOrder.findById(id);
        if (!collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found"
            });
        }

        // Ownership enforcement
        if (collection.user.toString() !== req.user.id.toString()) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You do not own this collection"
            });
        }

        const item = collection.items.find(
            (it) => it.menu.toString() === menuId.toString()
        );

        if (!item) {
            return res.status(404).json({
                success: false,
                message: "Dish not found in this collection"
            });
        }

        item.quantity = qty;
        await collection.save();

        await collection.populate({
            path: "items.menu",
            populate: { path: "category", select: "name" }
        });

        return res.status(200).json({
            success: true,
            message: "Dish quantity updated",
            collection
        });
    } catch (error) {
        console.error("❌ Failed to update dish quantity:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to update quantity"
        });
    }
};

// ======================================================
// 8. Remove Dish from Collection
// DELETE /api/regular-orders/:id/items/:menuId
// ======================================================
const removeDishFromCollection = async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const { id, menuId } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid collection ID"
            });
        }

        if (!menuId || !isValidObjectId(menuId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid menu ID"
            });
        }

        const collection = await RegularOrder.findById(id);
        if (!collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found"
            });
        }

        // Ownership enforcement
        if (collection.user.toString() !== req.user.id.toString()) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You do not own this collection"
            });
        }

        const initialLength = collection.items.length;
        collection.items = collection.items.filter(
            (it) => it.menu.toString() !== menuId.toString()
        );

        if (collection.items.length === initialLength) {
            return res.status(404).json({
                success: false,
                message: "Dish not found in this collection"
            });
        }

        await collection.save();

        await collection.populate({
            path: "items.menu",
            populate: { path: "category", select: "name" }
        });

        return res.status(200).json({
            success: true,
            message: "Dish removed from collection",
            collection
        });
    } catch (error) {
        console.error("❌ Failed to remove dish from collection:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to remove dish"
        });
    }
};

// ======================================================
// 9. Validate Collection Dishes for Quick Reorder
// POST /api/regular-orders/:id/reorder
// Checks live database availability & authoritative prices.
// NEVER creates an order or initiates payment.
// ======================================================
const validateAndPrepareReorder = async (req, res) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });
        }

        const { id } = req.params;

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid collection ID"
            });
        }

        const collection = await RegularOrder.findById(id);
        if (!collection) {
            return res.status(404).json({
                success: false,
                message: "Collection not found"
            });
        }

        // Ownership enforcement
        if (collection.user.toString() !== req.user.id.toString()) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You do not own this collection"
            });
        }

        if (!collection.items || collection.items.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Collection is empty. Add dishes before reordering."
            });
        }

        const availableItems = [];
        const unavailableItems = [];

        // Check each dish against the live database
        for (const item of collection.items) {
            const liveDish = await Menu.findById(item.menu).populate("category", "name");

            if (!liveDish) {
                unavailableItems.push({
                    menuId: item.menu,
                    name: "Unknown Dish",
                    reason: "No longer on the menu",
                    quantity: item.quantity
                });
                continue;
            }

            if (!liveDish.isAvailable) {
                unavailableItems.push({
                    menuId: liveDish._id,
                    name: liveDish.name,
                    reason: "Currently unavailable",
                    quantity: item.quantity
                });
                continue;
            }

            // Available: authoritative live price and details
            availableItems.push({
                item: {
                    _id: liveDish._id,
                    name: liveDish.name,
                    price: liveDish.price,
                    image: liveDish.image,
                    category: liveDish.category,
                    isVeg: liveDish.isVeg,
                    isAvailable: true,
                    preparationTime: liveDish.preparationTime,
                    model3D: liveDish.model3D,
                    rating: liveDish.rating,
                    numReviews: liveDish.numReviews
                },
                quantity: item.quantity
            });
        }

        return res.status(200).json({
            success: true,
            collectionName: collection.name,
            availableItems,
            unavailableItems,
            summary: {
                totalDishesInCollection: collection.items.length,
                availableCount: availableItems.length,
                unavailableCount: unavailableItems.length
            }
        });
    } catch (error) {
        console.error("❌ Failed to validate reorder items:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to validate reorder items"
        });
    }
};

module.exports = {
    getCollections,
    getCollectionById,
    createCollection,
    renameCollection,
    deleteCollection,
    addDishToCollection,
    updateDishQuantity,
    removeDishFromCollection,
    validateAndPrepareReorder
};
