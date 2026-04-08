import OpenAI from "openai";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY;

const SYSTEM_PROMPT =
  "You are an epistemic analysis engine. You evaluate news articles strictly on " +
  "the quality of their reasoning, sourcing, and logical structure — not on the " +
  "political valence of their claims or conclusions. Your job is to score how well " +
  "the article supports its claims, regardless of whether those claims are true or " +
  "false. Return only valid JSON. No preamble, no markdown, no explanation.";

const USER_PROMPT_TEMPLATE = `Score the following article on these six epistemic dimensions. Return ONLY a JSON object matching the schema below — no markdown, no explanation.

DIMENSIONS (each scored 0-10):
1. source_quality (weight 25%): Are sources named and direct? Anonymous sources penalized. Are quotes from people with firsthand knowledge, or peripheral/adjacent figures? Is 'could not reach for comment' used as a sourcing substitute?
2. claim_grounding (weight 25%): Are factual claims supported by verifiable evidence or named attribution? Are assumptions presented as facts? Are contested claims labeled as contested?
3. logical_integrity (weight 20%): Does the article avoid non-sequiturs, false equivalences, or strawman characterizations? Is causation distinguished from correlation?
4. completeness_balance (weight 15%): Are affected parties and opposing viewpoints represented? Is relevant context omitted that would materially change interpretation?
5. language_precision (weight 10%): Are weasel words used ('some say', 'many believe', 'critics argue' with no named critics)? Is emotionally loaded language used in place of neutral descriptors?
6. author_transparency (weight 5%): Do not attempt to score this from article text. Set score to null and notes to 'requires external verification'.

COMPOSITE SCORE: Calculate as weighted average of the five scoreable dimensions, mapped to 0-100.
GRADE: A (80-100), B (65-79), C (50-64), D (35-49), F (0-34)

SCHEMA:
{
  "composite_score": integer 0-100,
  "grade": "A"|"B"|"C"|"D"|"F",
  "dimensions": {
    "source_quality": { "score": 0-10, "notes": "..." },
    "claim_grounding": { "score": 0-10, "notes": "..." },
    "logical_integrity": { "score": 0-10, "notes": "..." },
    "completeness_balance": { "score": 0-10, "notes": "..." },
    "language_precision": { "score": 0-10, "notes": "..." },
    "author_transparency": { "score": null, "notes": "requires external verification" }
  },
  "weak_sentences": [
    { "text": "exact sentence from article", "reason": "why epistemically weak", "category": "dimension name" }
  ],
  "summary": "2-3 sentence plain-English verdict on the article as a whole"
}

ARTICLE TEXT:
`;

function trimArticle(text, maxWords = 3000) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, 2500).join(" ") + " [...] " + words.slice(-500).join(" ");
}

async function extractFromUrl(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`Failed to fetch URL: ${resp.status} ${resp.statusText}`);

  const html = await resp.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (article && article.textContent && article.textContent.trim().length > 100) {
    return article.textContent.trim();
  }

  // Fallback: basic extraction from body
  const body = dom.window.document.body;
  if (body) {
    const text = body.textContent.replace(/\s+/g, " ").trim();
    if (text.length > 100) return text;
  }

  throw new Error("Could not extract meaningful article text from the URL.");
}

async function callLLM(articleText) {
  const client = new OpenAI({
    apiKey: MOONSHOT_API_KEY,
    baseURL: "https://api.moonshot.ai/v1",
  });

  const response = await client.chat.completions.create({
    model: "kimi-k2-turbo-preview",
    max_tokens: 4096,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: USER_PROMPT_TEMPLATE + articleText },
    ],
  });

  let raw = response.choices[0].message.content.trim();

  // Strip markdown code fences if present
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  return JSON.parse(raw);
}

function makeResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return makeResponse(200, {});
  }

  if (event.httpMethod !== "POST") {
    return makeResponse(405, { detail: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return makeResponse(400, { detail: "Invalid JSON body" });
  }

  const inputText = (body.input || "").trim();
  const inputType = body.input_type;

  if (inputType !== "url" && inputType !== "text") {
    return makeResponse(400, { detail: "input_type must be 'url' or 'text'" });
  }

  if (!inputText) {
    return makeResponse(400, { detail: "input must not be empty" });
  }

  let articleText;
  try {
    if (inputType === "url") {
      articleText = await extractFromUrl(inputText);
    } else {
      articleText = inputText;
    }
  } catch (e) {
    return makeResponse(400, { detail: `Failed to extract article: ${e.message}` });
  }

  if (articleText.trim().length < 50) {
    return makeResponse(400, { detail: "Extracted text is too short to analyze." });
  }

  const trimmed = trimArticle(articleText);

  try {
    const scoreJson = await callLLM(trimmed);
    return makeResponse(200, scoreJson);
  } catch (e) {
    // Retry once on parse failure
    if (e instanceof SyntaxError) {
      try {
        const scoreJson = await callLLM(trimmed);
        return makeResponse(200, scoreJson);
      } catch {
        return makeResponse(502, { detail: "AI returned malformed response after retry." });
      }
    }
    return makeResponse(502, { detail: `LLM API error: ${e.message}` });
  }
}
