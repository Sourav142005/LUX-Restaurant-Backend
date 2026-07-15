const Menu = require("../models/Menu");
const Category = require("../models/Category");

const getMenu = async (req, res) => {

    try {

        const menus = await Menu.find().populate("category");

        res.status(200).json({
            success: true,
            count: menus.length,
            menus
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });
        

    }

};

const getMenuById = async (req, res) => {

    try {

        const { id } = req.params;

        const menu = await Menu.findById(id).populate("category");

        if (!menu) {
            return res.status(404).json({
                success: false,
                message: "Menu not found"
            });
        }

        res.status(200).json({
            success: true,
            menu
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};
const updateMenu = async (req, res) => {

    try {

        const { id } = req.params;

        const updatedMenu = await Menu.findByIdAndUpdate(
            id,
            req.body,
            {
                new: true
            }
        ).populate("category");

        if (!updatedMenu) {
            return res.status(404).json({
                success: false,
                message: "Menu not found"
            });
        }

        res.status(200).json({
            success: true,
            message: "Menu updated successfully",
            menu: updatedMenu
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

const deleteMenu = async (req, res) => {

    try {

        const { id } = req.params;

        const menu = await Menu.findByIdAndDelete(id);

        if (!menu) {
            return res.status(404).json({
                success: false,
                message: "Menu not found"
            });
        }

        res.status(200).json({
            success: true,
            message: "Menu deleted successfully"
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

const createMenu = async (req, res) => {

    try {

        const {
            name,
            description,
            price,
            category,
            isVeg,
            preparationTime
        } = req.body;

        // Step 1: Validation
        if (!name || !description || !price || !category) {
            return res.status(400).json({
                success: false,
                message: "Please fill all required fields"
            });
        }

        // Step 2: Check if menu already exists
        const existingMenu = await Menu.findOne({ name });

        if (existingMenu) {
            return res.status(400).json({
                success: false,
                message: "Menu already exists"
            });
        }

        // Step 3: Check if category exists
        const existingCategory = await Category.findById(category);

        if (!existingCategory) {
            return res.status(404).json({
                success: false,
                message: "Category not found"
            });
        }

        // Step 4: Create menu
        const menu = await Menu.create({
            name,
            description,
            price,
            category,
            isVeg,
            preparationTime
        });

        res.status(201).json({
            success: true,
            message: "Menu item created successfully",
            menu
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};


module.exports = {
    getMenu,
    getMenuById,
    createMenu,
    updateMenu,
    deleteMenu
};