import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { cars } from "@/db/schema";
import { eq, and, ilike, gte, lte, desc, sql, asc } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

async function getSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const perPage = parseInt(searchParams.get("perPage") || "20");
  const search = searchParams.get("search");
  const status = searchParams.get("status");
  const make = searchParams.get("make");
  const yearMin = searchParams.get("yearMin");
  const yearMax = searchParams.get("yearMax");
  const sort = searchParams.get("sort") || "updatedAt";
  const order = searchParams.get("order") || "desc";

  const conditions: ReturnType<typeof eq>[] = [];
  if (status) conditions.push(eq(cars.status, status));
  if (make) conditions.push(ilike(cars.make, `%${make}%`));
  if (yearMin) conditions.push(gte(cars.year, parseInt(yearMin)));
  if (yearMax) conditions.push(lte(cars.year, parseInt(yearMax)));

  const offset = (page - 1) * perPage;

  let results;
  let total;

  if (search && search.trim()) {
    const sanitized = search
      .replace(/[&|!<>():*\\'"]/g, " ")
      .trim();

    const tsQuery = sanitized
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => w + ":*")
      .join(" & ");

    const whereClause = and(
      sql`search_vector @@ to_tsquery('english', ${tsQuery})`,
      ...conditions
    );

    [results, [{ count: total }]] = await Promise.all([
      db
        .select()
        .from(cars)
        .where(whereClause)
        .orderBy(
          sql`ts_rank(search_vector, to_tsquery('english', ${tsQuery})) DESC`
        )
        .limit(perPage)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(cars)
        .where(whereClause),
    ]);
  } else {
    const sortCol =
      sort === "year"
        ? cars.year
        : sort === "price"
          ? cars.price
          : sort === "make"
            ? cars.make
            : cars.updatedAt;
    const orderFn = order === "asc" ? asc : desc;
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    [results, [{ count: total }]] = await Promise.all([
      db
        .select()
        .from(cars)
        .where(whereClause)
        .orderBy(orderFn(sortCol))
        .limit(perPage)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(cars)
        .where(whereClause),
    ]);
  }

  return NextResponse.json({
    cars: results,
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const [car] = await db
    .insert(cars)
    .values({
      stockId: body.stockId,
      make: body.make,
      model: body.model,
      year: body.year,
      trim: body.trim,
      color: body.color,
      mileage: body.mileage,
      price: body.price,
      bodyType: body.bodyType,
      drivetrain: body.drivetrain,
      engine: body.engine,
      transmission: body.transmission,
      vin: body.vin,
      status: body.status || "available",
      description: body.description,
      source: "manual",
    })
    .returning();

  return NextResponse.json(car, { status: 201 });
}
