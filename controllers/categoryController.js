const Category = require("../models/Category");
const Menu = require("../models/Menu");

const createCategory = async (req, res) => {

    try {

        const { name, description } = req.body;

        // Validation
        if (!name || !description) {
            return res.status(400).json({
                success: false,
                message: "Please fill all fields"
            });
        }

        // Check if category already exists
        const existingCategory = await Category.findOne({ name });

        if (existingCategory) {
            return res.status(400).json({
                success: false,
                message: "Category already exists"
            });
        }

        // Create category
        const category = await Category.create({
            name,
            description
        });

        res.status(201).json({
            success: true,
            message: "Category created successfully",
            category
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};
const getCategories = async (req, res) => {

    try {

        const categories = await Category.find();

        res.status(200).json({
            success: true,
            count: categories.length,
            categories
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};
const updateCategory = async (req, res) => {

    try {

        const { name, description } = req.body;

        // Validation
        if (!name || !description) {
            return res.status(400).json({
                success: false,
                message: "Please fill all fields"
            });
        }

        // Check if another category has the same name
        const existingCategory = await Category.findOne({
            name,
            _id: { $ne: req.params.id }
        });

        if (existingCategory) {
            return res.status(400).json({
                success: false,
                message: "Category already exists"
            });
        }

        // Update category
        const category = await Category.findByIdAndUpdate(
            req.params.id,
            {
                name,
                description
            },
            {
                new: true,
                runValidators: true
            }
        );

        if (!category) {
            return res.status(404).json({
                success: false,
                message: "Category not found"
            });
        }

        res.status(200).json({
            success: true,
            message: "Category updated successfully",
            category
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

const deleteCategory = async (req, res) => {

    try {

        const categoryId = req.params.id;

        // Check if category exists
        const category = await Category.findById(categoryId);

        if (!category) {
            return res.status(404).json({
                success: false,
                message: "Category not found"
            });
        }

        // Check if any menu item is using this category
        const menuUsingCategory = await Menu.findOne({
            category: categoryId
        });

        if (menuUsingCategory) {
            return res.status(400).json({
                success: false,
                message:
                    `Cannot delete "${category.name}" because menu items are using this category`
            });
        }

        // Delete category
        await Category.findByIdAndDelete(categoryId);

        res.status(200).json({
            success: true,
            message: "Category deleted successfully"
        });

    } catch (error) {

        console.error("Delete Category Error:", error);

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

module.exports = {
    createCategory,
    getCategories,
    updateCategory,
    deleteCategory
};