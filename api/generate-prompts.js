module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { businessName, industry, context } = req.body;
  if (!businessName || !industry) {
    return res.status(400).json({ error: "businessName and industry are required" });
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
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: `You are helping generate video testimonial prompts for a business.

Business: ${businessName}
Industry: ${industry}
Extra context: ${context || "None"}

Generate exactly 4 short, conversational video testimonial questions that will help customers share genuine, compelling stories. Each question should be easy to answer naturally on camera — not corporate or stiff.

Respond ONLY with a JSON array of 4 strings, no markdown, no explanation. Example format:
["Question 1?","Question 2?","Question 3?","Question 4?"]`,
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    return res.status(response.status).json({ error: err.error?.message || "Anthropic API error" });
  }

  const data = await response.json();
  const text = data.content.map((b) => b.text || "").join("");
  const prompts = JSON.parse(text.replace(/```json|```/g, "").trim());
  return res.status(200).json({ prompts });
}
