const express = require("express");
const router = express.Router();

const { askAstra } = require("../services/aiService");

router.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "Message is required",
      });
    }

    const reply = await askAstra(message);

    res.json({
      success: true,
      reply,
    });
  } catch (error) {
    console.error("Astra API Error:", error);

    res.status(500).json({
      success: false,
      message: "AI service failed",
    });
  }
});

module.exports = router;