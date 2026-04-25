import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { cars } from "@/db/schema";
import { sql, and, eq, gte, lte, ilike } from "drizzle-orm";
import type { VideoObject } from "@/db/schema";

// ─── Request schema ──────────────────────────────────────────────────────────
//
// Numeric fields use `z.coerce.number()` so callers can send either JSON numbers
// or numeric strings ("5"). `has_video` accepts true booleans or the strings
// "true"/"false" for the same reason — voice-agent tool calls aren't always
// strict about JSON types.

const booleanish = z.union([
  z.boolean(),
  z
    .enum(["true", "false"])
    .transform((v) => v === "true"),
]);

const SearchCarsSchema = z
  .object({
    query: z.string().optional(),
    limit: z.coerce
      .number({ message: "limit must be a number" })
      .int("limit must be an integer")
      .min(1, "limit must be >= 1")
      .max(20, "limit must be <= 20")
      .optional()
      .default(5),
    status: z
      .enum(["available", "pending", "sold"], {
        message: "status must be one of: available, pending, sold",
      })
      .optional(),
    make: z.string().optional(),
    model: z.string().optional(),
    year_min: z.coerce
      .number({ message: "year_min must be a number" })
      .int("year_min must be an integer")
      .min(1900, "year_min must be >= 1900")
      .max(2100, "year_min must be <= 2100")
      .optional(),
    year_max: z.coerce
      .number({ message: "year_max must be a number" })
      .int("year_max must be an integer")
      .min(1900, "year_max must be >= 1900")
      .max(2100, "year_max must be <= 2100")
      .optional(),
    min_price: z.coerce
      .number({ message: "min_price must be a number" })
      .min(0, "min_price must be >= 0")
      .optional(),
    max_price: z.coerce
      .number({ message: "max_price must be a number" })
      .min(0, "max_price must be >= 0")
      .optional(),
    has_video: booleanish.optional(),
    video_posted_within_days: z.coerce
      .number({ message: "video_posted_within_days must be a number" })
      .int("video_posted_within_days must be an integer")
      .min(1, "video_posted_within_days must be >= 1")
      .max(3650, "video_posted_within_days must be <= 3650")
      .optional(),
  })
  .refine(
    (d) => d.year_min === undefined || d.year_max === undefined || d.year_min <= d.year_max,
    { message: "year_min must be <= year_max", path: ["year_min"] }
  )
  .refine(
    (d) => d.min_price === undefined || d.max_price === undefined || d.min_price <= d.max_price,
    { message: "min_price must be <= max_price", path: ["min_price"] }
  );

type SearchCarsInput = z.infer<typeof SearchCarsSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatZodError(error: z.ZodError) {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    code: issue.code,
    message: issue.message,
  }));
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // API key auth
  const authHeader = request.headers.get("authorization");
  const apiKey = process.env.TOOL_API_KEY;
  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse JSON
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON body",
        details: [
          {
            field: "(body)",
            code: "invalid_json",
            message: "Request body must be valid JSON",
          },
        ],
      },
      { status: 400 }
    );
  }

  // Validate
  const parsed = SearchCarsSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid parameters",
        details: formatZodError(parsed.error),
      },
      { status: 400 }
    );
  }

  const params: SearchCarsInput = parsed.data;
  const {
    query,
    limit,
    status,
    make,
    model,
    year_min,
    year_max,
    min_price,
    max_price,
    has_video,
    video_posted_within_days,
  } = params;

  // Build filters. Use `!== undefined` instead of truthy checks so 0 is allowed.
  const conditions: ReturnType<typeof eq>[] = [];
  conditions.push(eq(cars.status, status ?? "available"));

  if (make) conditions.push(ilike(cars.make, `%${make.replace(/%/g, "")}%`));
  if (model) conditions.push(ilike(cars.model, `%${model.replace(/%/g, "")}%`));
  if (year_min !== undefined) conditions.push(gte(cars.year, year_min));
  if (year_max !== undefined) conditions.push(lte(cars.year, year_max));
  if (min_price !== undefined) conditions.push(gte(cars.price, min_price));
  if (max_price !== undefined) conditions.push(lte(cars.price, max_price));

  let results;
  if (query && query.trim()) {
    // FTS query — strip Postgres tsquery operators to prevent injection
    const sanitized = query.replace(/[&|!<>():*\\'"]/g, " ").trim();

    if (!sanitized) {
      return NextResponse.json({ results: [], total_count: 0 });
    }

    const tsQuery = sanitized
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => w + ":*")
      .join(" & ");

    results = await db
      .select({
        id: cars.id,
        stockId: cars.stockId,
        make: cars.make,
        model: cars.model,
        year: cars.year,
        trim: cars.trim,
        color: cars.color,
        mileage: cars.mileage,
        price: cars.price,
        status: cars.status,
        bodyType: cars.bodyType,
        drivetrain: cars.drivetrain,
        engine: cars.engine,
        description: cars.description,
        videos: cars.videos,
        rank: sql<number>`ts_rank(search_vector, to_tsquery('english', ${tsQuery}))`.as(
          "rank"
        ),
      })
      .from(cars)
      .where(
        and(
          sql`search_vector @@ to_tsquery('english', ${tsQuery})`,
          ...conditions
        )
      )
      .orderBy(
        sql`ts_rank(search_vector, to_tsquery('english', ${tsQuery})) DESC`
      )
      .limit(limit);
  } else {
    results = await db
      .select({
        id: cars.id,
        stockId: cars.stockId,
        make: cars.make,
        model: cars.model,
        year: cars.year,
        trim: cars.trim,
        color: cars.color,
        mileage: cars.mileage,
        price: cars.price,
        status: cars.status,
        bodyType: cars.bodyType,
        drivetrain: cars.drivetrain,
        engine: cars.engine,
        description: cars.description,
        videos: cars.videos,
      })
      .from(cars)
      .where(and(...conditions))
      .orderBy(cars.updatedAt)
      .limit(limit);
  }

  // Shape response
  const shaped = results
    .map((r) => {
      const videos = (r.videos as VideoObject[]) || [];
      const latestVideo = videos.sort(
        (a, b) =>
          new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime()
      )[0];

      // Filter by video criteria if needed
      if (has_video && videos.length === 0) return null;
      if (video_posted_within_days !== undefined && latestVideo) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - video_posted_within_days);
        if (new Date(latestVideo.posted_at) < cutoff) return null;
      }

      return {
        stock_id: r.stockId,
        make: r.make,
        model: r.model,
        year: r.year,
        trim: r.trim,
        color: r.color,
        mileage: r.mileage,
        price: r.price,
        status: r.status,
        body_type: r.bodyType,
        drivetrain: r.drivetrain,
        engine: r.engine,
        description: r.description,
        video_count: videos.length,
        latest_video_date: latestVideo?.posted_at?.split("T")[0] || null,
        latest_video_permalink: latestVideo?.permalink || null,
      };
    })
    .filter(Boolean);

  return NextResponse.json({
    results: shaped,
    total_count: shaped.length,
  });
}
