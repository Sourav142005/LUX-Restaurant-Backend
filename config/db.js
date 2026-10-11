const mongoose = require("mongoose");
const dns = require("node:dns");

const connectDB = async () => {
    try {
        // Temporary workaround for the local Node.js DNS issue
        dns.setServers(["8.8.8.8", "8.8.4.4"]);

        const uri = process.env.MONGO_URI;

        if (!uri) {
            throw new Error("MONGO_URI is missing from .env");
        }

        const conn = await mongoose.connect(uri);

        console.log(`MongoDB Connected: ${conn.connection.host}`);
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
    }
};

module.exports = connectDB;