const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { askAstra } = require("../services/aiService");

// Rate limiting for AI endpoint: 30 requests per minute per IP
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: {
    success: false,
    message: "Too many AI requests. Please wait a moment before trying again."
  },
  standardHeaders: true,
  legacyHeaders: false
});

router.post("/chat", aiLimiter, async (req, res) => {
  try {
    const { message, context } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        success: false,
        message: "A valid text message is required"
      });
    }

    const trimmed = message.trim();
    if (trimmed.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Message cannot be empty"
      });
    }

    if (trimmed.length > 500) {
      return res.status(400).json({
        success: false,
        message: "Message exceeds maximum length of 500 characters"
      });
    }

    // Process message with live menu context and fallback safety
    const result = await askAstra(trimmed, context || {});

    // Always return a success response with rich assistant data
    return res.status(200).json({
      success: true,
      reply: result.reply,
      action: result.action || "NONE",
      proposedItems: result.proposedItems || [],
      itemsToCart: result.itemsToCart || [],
      recommendedDishes: result.recommendedDishes || [],
      provider: result.provider || "deterministic"
    });
  } catch (error) {
    console.error("LUX AI Route Error:", error.message);

    return res.status(500).json({
      success: false,
      message: "AI service temporarily unavailable. Please try again shortly."
    });
  }
});

module.exports = router;