import json
import os
import re
from datetime import datetime, timezone

import httpx
import trafilatura
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum
from openai import OpenAI, APIError
from pydantic import BaseModel
from supabase import create_client

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MOONSHOT_API_KEY = os.environ.get("MOONSHOT_API_KEY")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

SYSTEM_PROMPT = (
    "You are an epistemic analysis engine. You evaluate news articles strictly on "
    "the quality of their reasoning, sourcing, and logical structure — not on the "
    "political valence of their claims or conclusions. Your job is to score how well "
    "the article supports its claims, regardless of whether those claims are true or "
    "false. Return only valid JSON. No preamble, no markdown, no explanation."
)

USER_PROMPT_TEMPLATE = """Score the following article on these six epistemic dimensions. Return ONLY a JSON object matching the schema below — no markdown, no explanation.

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
"""


class ScoreRequest(BaseModel):
    input: str
    input_type: str  # "url" or "text"


def trim_article(text: str, max_words: int = 3000) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:2500]) + " [...] " + " ".join(words[-500:])


def extract_from_url(url: str) -> str:
    resp = httpx.get(url, follow_redirects=True, timeout=15.0, headers={
        "User-Agent": "Mozilla/5.0 (compatible; EpistemicLens/1.0)"
    })
    resp.raise_for_status()
    html = resp.text

    text = trafilatura.extract(html)
    if text and len(text.strip()) > 100:
        return text

    soup = BeautifulSoup(html, "html.parser")
    for tag in ["article", "main", "[role='main']"]:
        el = soup.select_one(tag)
        if el:
            return el.get_text(separator="\n", strip=True)

    body = soup.find("body")
    if body:
        return body.get_text(separator="\n", strip=True)

    raise ValueError("Could not extract article text from the provided URL.")


def call_llm(article_text: str) -> dict:
    client = OpenAI(
        api_key=MOONSHOT_API_KEY,
        base_url="https://api.moonshot.ai/v1",
    )
    user_prompt = USER_PROMPT_TEMPLATE + article_text

    response = client.chat.completions.create(
        model="kimi-k2.5",
        max_tokens=16384,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    )

    raw = response.choices[0].message.content.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)

    return json.loads(raw)


def save_to_supabase(url: str | None, extracted_text: str, score_json: dict):
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    sb.table("epistemic_scores").insert({
        "url": url,
        "extracted_text": extracted_text[:10000],
        "score_json": score_json,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }).execute()


@app.post("/api/score")
async def score_article(req: ScoreRequest):
    if req.input_type not in ("url", "text"):
        raise HTTPException(status_code=400, detail="input_type must be 'url' or 'text'")

    if not req.input or not req.input.strip():
        raise HTTPException(status_code=400, detail="input must not be empty")

    url = None
    try:
        if req.input_type == "url":
            url = req.input.strip()
            article_text = extract_from_url(url)
        else:
            article_text = req.input.strip()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to extract article: {e}")

    if len(article_text.strip()) < 50:
        raise HTTPException(status_code=400, detail="Extracted text is too short to analyze.")

    trimmed = trim_article(article_text)

    try:
        score_json = call_llm(trimmed)
    except json.JSONDecodeError:
        # Retry once on malformed JSON
        try:
            score_json = call_llm(trimmed)
        except json.JSONDecodeError:
            raise HTTPException(status_code=502, detail="AI returned malformed response after retry.")
    except APIError as e:
        raise HTTPException(status_code=502, detail=f"LLM API error: {e}")

    try:
        save_to_supabase(url, trimmed, score_json)
    except Exception:
        pass  # Don't fail the request if storage fails

    return score_json


handler = Mangum(app, lifespan="off")
