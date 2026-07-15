require("dotenv").config();

const express = require("express");
const connectDB = require("./config/db");

const menuRoutes = require("./routes/menuRoutes");
const authRoutes = require("./routes/authRoutes");
const categoryRoutes = require("./routes/categoryRoutes");


const app = express();

connectDB();

const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());

// Home Route
app.get("/", (req, res) => {
    res.json({
        message: "Restaurant Backend Running",
        status: "success"
    });
});

// Routes
app.use("/api/menu", menuRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/category", categoryRoutes);
// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});