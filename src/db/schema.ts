import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Cars ────────────────────────────────────────────────────────────────────

export const cars = pgTable(
  "cars",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    stockId: text("stock_id").unique().notNull(),
    make: text("make").notNull(),
    model: text("model").notNull(),
    year: integer("year").notNull(),
    trim: text("trim"),
    color: text("color"),
    mileage: integer("mileage"),
    price: integer("price"),
    bodyType: text("body_type"),
    drivetrain: text("drivetrain"),
    engine: text("engine"),
    transmission: text("transmission"),
    vin: text("vin"),
    status: text("status").notNull().default("available"),
    description: text("description"),
    source: text("source").notNull().default("manual"),
    videos: jsonb("videos").notNull().default(sql`'[]'::jsonb`),
    vautoRaw: jsonb("vauto_raw"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_cars_status").on(table.status),
    index("idx_cars_make_model").on(table.make, table.model),
    index("idx_cars_year").on(table.year),
    index("idx_cars_source").on(table.source),
  ]
);

// ─── Instagram Sources ───────────────────────────────────────────────────────

export const instagramSources = pgTable("instagram_sources", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  accountHandle: text("account_handle").notNull().unique(),
  displayName: text("display_name"),
  pollingInterval: integer("polling_interval").notNull().default(1440),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastReelTimestamp: timestamp("last_reel_timestamp", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Events ──────────────────────────────────────────────────────────────────

export const events = pgTable(
  "events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: text("type").notNull(),
    status: text("status").notNull().default("running"),
    summary: jsonb("summary"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_events_type").on(table.type),
    index("idx_events_created").on(table.createdAt),
  ]
);

// ─── Types ───────────────────────────────────────────────────────────────────

export type Car = typeof cars.$inferSelect;
export type NewCar = typeof cars.$inferInsert;
export type InstagramSource = typeof instagramSources.$inferSelect;
export type Event = typeof events.$inferSelect;

export interface VideoObject {
  video_id: string;
  platform: string;
  caption: string;
  transcript: string;
  posted_at: string;
  permalink: string;
  thumbnail_url: string;
  fetched_at: string;
}
