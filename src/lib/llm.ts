import OpenAI from "openai";

let _llm: OpenAI | null = null;

function getLLM() {
  if (!_llm) {
    _llm = new OpenAI({
      baseURL: process.env.LLM_BASE_URL!,
      apiKey: process.env.LLM_API_KEY!,
      timeout: 30_000, // 30s timeout
      maxRetries: 2,
    });
  }
  return _llm;
}

const EXTRACTION_SYSTEM_PROMPT = `You extract car inventory data from a dealership's Instagram reel.
The dealership is J&S AutoHaus — luxury/exotic in Ewing, NJ.
The stock ID has already been extracted and provided.

Given the caption and transcript, extract structured fields.
Return ONLY valid JSON. Use null for fields you can't determine.

{
  "make": "string or null",
  "model": "string or null",
  "year": "number or null",
  "trim": "string or null",
  "color": "string or null",
  "mileage": "number or null",
  "price": "number or null",
  "body_type": "sedan | suv | coupe | convertible | truck | van | wagon | null",
  "drivetrain": "AWD | RWD | FWD | 4WD | null",
  "engine": "string or null",
  "transmission": "automatic | manual | null",
  "description": "1-2 sentence summary suitable for a voice agent to read to a caller"
}`;

export async function extractCarData(
  stockId: string,
  caption: string,
  transcript: string
): Promise<Record<string, unknown>> {
  const model = process.env.LLM_MODEL || "gpt-4o";

  try {
    const response = await getLLM().chat.completions.create({
      model,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Stock ID: ${stockId}\n\nCAPTION:\n${caption}\n\nTRANSCRIPT:\n${transcript}`,
        },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("LLM returned empty response");

    return JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM extraction failed for stock ${stockId}: ${message}`);
  }
}
