const FALLBACK_PROMPTS = [
  "What problem were you trying to solve before you found us, and how has that changed?",
  "Can you walk us through a specific moment where our product or service made a real difference for you?",
  "What would you tell a friend or colleague who's on the fence about working with us?",
  "How has working with us impacted your day-to-day — what does that actually look like in practice?",
];

async function callAnthropic(body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (response.status === 529) {
      console.log(`[generate-prompts] Anthropic overloaded (attempt ${attempt}/3)`);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      return null;
    }

    if (!response.ok) {
      const err = await response.json();
      console.log("[generate-prompts] Anthropic error:", JSON.stringify(err));
      return null;
    }

    return response.json();
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { businessName, industry, context } = req.body;
  console.log("[generate-prompts] request body:", { businessName, industry, context });

  if (!businessName || !industry) {
    console.log("[generate-prompts] missing required fields");
    return res.status(400).json({ error: "businessName and industry are required" });
  }

  console.log("[generate-prompts] ANTHROPIC_API_KEY present:", !!process.env.ANTHROPIC_API_KEY);

  const data = await callAnthropic({
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
  });

  if (!data) {
    console.log("[generate-prompts] all retries failed, returning fallback prompts");
    return res.status(200).json({ prompts: FALLBACK_PROMPTS });
  }

  console.log("[generate-prompts] Anthropic response body:", JSON.stringify(data));

  try {
    const text = data.content.map((b) => b.text || "").join("");
    const prompts = JSON.parse(text.replace(/```json|```/g, "").trim());
    console.log("[generate-prompts] parsed prompts:", prompts);
    return res.status(200).json({ prompts });
  } catch (e) {
    console.log("[generate-prompts] failed to parse response, returning fallback prompts");
    return res.status(200).json({ prompts: FALLBACK_PROMPTS });
  }
};
