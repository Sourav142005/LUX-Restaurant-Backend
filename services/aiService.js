
const OpenAI = require("openai");

let client;

function getClient() {
  if (!process.env.EXPLABS_API_KEY) {
    throw new Error("AI service is not configured");
  }

  if (!client) {
    client = new OpenAI({
      apiKey: process.env.EXPLABS_API_KEY,
      baseURL: "https://api.experientiallabs.ai/v1",
    });
  }

  return client;
}

async function askAstra(message) {
  const aiClient = getClient();

  const response = await aiClient.chat.completions.create({
    model: "gpt-6-astra",
    messages: [
      {
        role: "user",
        content: message,
      },
    ],
  });

  return response.choices[0].message.content;
}

module.exports = { askAstra };
