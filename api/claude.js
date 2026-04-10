export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, ...params } = req.body;

  const messages = buildMessages(action, params);
  if (!messages) {
    return res.status(400).json({ error: "Unknown action" });
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: messages.maxTokens,
      messages: [{ role: "user", content: messages.content }],
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    return res.status(response.status).json({ error: err.error?.message || "Anthropic API error" });
  }

  const data = await response.json();
  const text = data.content.map((b) => b.text || "").join("");
  return res.status(200).json({ text });
}

function buildMessages(action, params) {
  if (action === "generatePrompts") {
    const { businessName, industry, context } = params;
    return {
      maxTokens: 1000,
      content: `You are helping generate video testimonial prompts for a business.

Business: ${businessName}
Industry: ${industry}
Extra context: ${context || "None"}

Generate exactly 4 short, conversational video testimonial questions that will help customers share genuine, compelling stories. Each question should be easy to answer naturally on camera — not corporate or stiff.

Respond ONLY with a JSON array of 4 strings, no markdown, no explanation. Example format:
["Question 1?","Question 2?","Question 3?","Question 4?"]`,
    };
  }

  if (action === "analyzeTestimonial") {
    const { answers, prompts } = params;
    const combined = prompts.map((p, i) => `Q: ${p}\nA: ${answers[i] || "(no answer)"}`).join("\n\n");
    return {
      maxTokens: 400,
      content: `Based on these testimonial answers, write a single compelling 2-3 sentence testimonial quote in the customer's voice. Make it sound natural, genuine, and specific — not generic marketing speak.

${combined}

Respond with ONLY the quote text, no quotation marks, no explanation.`,
    };
  }

  if (action === "suggestClips") {
    const { quote, prompts } = params;
    return {
      maxTokens: 600,
      content: `You are a video editor assistant. Given this testimonial quote and the questions asked, suggest 3 short social media clip titles with a one-sentence description of what moment to highlight.

Quote: "${quote}"
Questions: ${prompts.join(" | ")}

Respond ONLY with a JSON array of exactly 3 objects like:
[{"title":"Clip title","desc":"What to highlight","emoji":"🎯"}]
Use relevant emojis. No markdown, no explanation.`,
    };
  }

  return null;
}
