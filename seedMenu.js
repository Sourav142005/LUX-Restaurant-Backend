require("dotenv").config();

const mongoose = require("mongoose");
const dns = require("node:dns");

dns.setServers(["8.8.8.8", "8.8.4.4"]);
const Category = require("./models/Category");
const Menu = require("./models/Menu");

const categories = [
  { name: "Soups", description: "Freshly prepared soups" },
  { name: "Beverages", description: "Coffee and cold drinks" },
  { name: "Pizza", description: "Freshly baked pizzas" },
  { name: "Desserts", description: "Sweet treats and pastries" }
];

const dishes = [
  {
    name: "Tomato Soup",
    description: "Creamy tomato soup seasoned with herbs.",
    price: 129,
    category: "Soups",
    isVeg: true,
    preparationTime: 10,
    image: "/images/food/tomato-soup.jpg",
    model3D: ""
  },
  {
    name: "Cappuccino",
    description: "Espresso topped with steamed milk foam.",
    price: 119,
    category: "Beverages",
    isVeg: true,
    preparationTime: 5,
    image: "/images/food/cappuccino.jpg",
    model3D: "/models/coffee_cup.glb"
  },
  {
    name: "Classic Cheese & Tomato Pizza",
    description: "Classic pizza topped with tomato sauce and melted cheese.",
    price: 249,
    category: "Pizza",
    isVeg: true,
    preparationTime: 20,
    image: "/images/food/cheese-tomato-pizza.jpg",
    model3D: "/models/pizza_30cm.glb"
  },
  {
    name: "Chocolate Pastry",
    description: "Rich chocolate pastry with a smooth chocolate filling.",
    price: 99,
    category: "Desserts",
    isVeg: true,
    preparationTime: 10,
    image: "/images/food/chocolate-pastry.jpg",
    model3D: "/models/chocolate_ pastry_20cm.glb"
  },
  {
    name: "Pepsi",
    description: "Chilled Pepsi soft drink.",
    price: 49,
    category: "Beverages",
    isVeg: true,
    preparationTime: 2,
    image: "/images/food/pepsi.jpg",
    model3D: "/models/pepsi.glb"
  }
];

async function seedMenu() {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is missing from .env");
    }

    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 15000
    });

    console.log("Connected database:", mongoose.connection.name);

    for (const item of categories) {
      await Category.updateOne(
        { name: item.name },
        { $set: item },
        { upsert: true }
      );
    }

    const savedCategories = await Category.find({
      name: { $in: categories.map(c => c.name) }
    });

    const categoryIds = new Map(
      savedCategories.map(c => [c.name, c._id])
    );

    let updated = 0;

    for (const dish of dishes) {
      const { category, ...fields } = dish;

      await Menu.updateOne(
        { name: dish.name },
        {
          $set: {
            ...fields,
            category: categoryIds.get(category),
            isAvailable: true
          }
        },
        { upsert: true }
      );
      updated++;
    }

    console.log("Categories checked:", savedCategories.length);
    console.log("Dishes synced/updated with model3D:", updated);
  } catch (error) {
    console.error("Menu seed failed:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

seedMenu();
