const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.EXPLABS_API_KEY,
  baseURL: "https://api.experientiallabs.ai/v1",
});

async function askAstra(message) {
  const response = await client.chat.completions.create({
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