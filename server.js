const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");

const connectDB = require("./config/db");

// ======================================================
// Routes
// ======================================================

const menuRoutes = require("./routes/menuRoutes");
const authRoutes = require("./routes/authRoutes");
const categoryRoutes = require("./routes/categoryRoutes");
const orderRoutes = require("./routes/orderRoutes");
const adminRoutes = require("./routes/adminRoutes");
const userRoutes = require("./routes/userRoutes");
const tableRoutes = require("./routes/tableRoutes");
const reservationRoutes = require("./routes/reservationRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const aiRoutes = require("./routes/aiRoutes");
const reviewRoutes = require("./routes/reviewRoutes");
const regularOrderRoutes = require("./routes/regularOrderRoutes");

const app = express();

// Trust the first proxy hop (Render reverse proxy/load balancer)
app.set("trust proxy", 1);

// ======================================================
// Start Scheduler
// ======================================================

require("./services/scheduler");

// ======================================================
// Database
// ======================================================

connectDB();

// ======================================================
// Port
// ======================================================

const PORT = process.env.PORT || 5000;

// ======================================================
// CORS
// ======================================================

const defaultAllowedOrigins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "http://10.47.73.115:5174",
    "https://4c1c10xt-5173.inc1.devtunnels.ms",
    "https://721xktdt-5173.inc1.devtunnels.ms",
    "https://lux-restaurant-frontend.vercel.app"
];

const isOriginAllowed = (origin) => {
    // Allow non-browser requests (Postman, server-to-server, health checks, etc.)
    if (!origin) return true;

    // Check direct matches
    if (defaultAllowedOrigins.includes(origin)) return true;

    // Check CLIENT_URL environment variable (supports comma-separated list)
    if (process.env.CLIENT_URL) {
        const clientUrls = process.env.CLIENT_URL.split(",").map(url => url.trim().replace(/\/$/, ""));
        if (clientUrls.includes(origin.replace(/\/$/, ""))) return true;
    }

    // Allow all Vercel deployment preview and production domains (*.vercel.app)
    try {
        const hostname = new URL(origin).hostname;
        if (hostname.endsWith(".vercel.app") || hostname === "vercel.app") {
            return true;
        }
    } catch (e) {
        // Fallback if URL constructor throws
    }

    return false;
};

const corsOptions = {
    origin: function (origin, callback) {
        if (isOriginAllowed(origin)) {
            return callback(null, true);
        }

        console.log("❌ CORS blocked:", origin);
        return callback(new Error(`Not allowed by CORS: ${origin}`));
    },

    credentials: true,

    methods: [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS"
    ],

    allowedHeaders: [
        "Content-Type",
        "Authorization"
    ]
};

app.use((req, res, next) => {
    console.log(
        `➡️ ${req.method} ${req.originalUrl} | Origin: ${req.headers.origin || "No Origin"}`
    );
    next();
});

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
// ======================================================
// Body Parser
// ======================================================

app.use(
    express.json({
        verify: (req, res, buf) => {
            req.rawBody = buf;
        }
    })
);
app.use(express.urlencoded({ extended: true }));

// ======================================================
// Home Route
// ======================================================

app.get("/", (req, res) => {
    res.status(200).json({
        message: "Restaurant Backend Running",
        status: "success"
    });
});

// ======================================================
// API Routes
// ======================================================

app.use("/api/menu", menuRoutes);

app.use("/api/auth", authRoutes);

app.use("/api/category", categoryRoutes);

app.use("/api/order", orderRoutes);

app.use("/api/admin", adminRoutes);

app.use("/api/user", userRoutes);

app.use("/api/table", tableRoutes);

app.use("/api/reservation", reservationRoutes);

app.use("/api/payment", paymentRoutes);

app.use("/api/ai", aiRoutes);

app.use("/api/review", reviewRoutes);

app.use("/api/regular-orders", regularOrderRoutes);
app.use("/api/regular-order", regularOrderRoutes);

// ======================================================
// 404 Handler
// ======================================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: `Route not found: ${req.method} ${req.originalUrl}`
    });
});

// ======================================================
// Global Error Handler
// ======================================================

app.use((err, req, res, next) => {
    console.error("❌ Server Error:", err.message);

    if (err.message === "Not allowed by CORS" || err.message.startsWith("Not allowed by CORS")) {
        return res.status(403).json({
            success: false,
            message: "CORS policy blocked this request",
            origin: req.headers.origin
        });
    }

    res.status(500).json({
        success: false,
        message: "Internal Server Error",
        error:
            process.env.NODE_ENV === "development"
                ? err.message
                : undefined
    });
});

// ======================================================
// Start Server
// ======================================================

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log("========================================");
    console.log("🚀 LUX Restaurant Backend");
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Local: http://localhost:${PORT}`);
    console.log(`🌐 API: http://localhost:${PORT}/api`);
    console.log("========================================");
});

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(`\n❌ Error: Port ${PORT} is already in use by another process.`);
        console.error("Please terminate the existing process or choose a different port.\n");
        process.exit(1);
    } else {
        console.error("\n❌ Server Error:", err.message);
    }
});