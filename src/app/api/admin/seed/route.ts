import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { eq } from "drizzle-orm";

export async function POST() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    return NextResponse.json(
      { error: "ADMIN_EMAIL and ADMIN_PASSWORD must be set" },
      { status: 400 }
    );
  }

  try {
    // Create admin user via Better Auth
    const result = await auth.api.signUpEmail({
      body: { email, password, name: "Admin" },
    });

    // Set role to admin directly in DB (no auth session needed at seed time)
    if (result?.user?.id) {
      await db
        .update(user)
        .set({ role: "admin" })
        .where(eq(user.id, result.user.id));
    }

    return NextResponse.json({ success: true, email });
  } catch (err) {
    const message = (err as Error).message || String(err);
    if (message.includes("already exists") || message.includes("duplicate")) {
      return NextResponse.json({ message: "Admin already exists" });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
