import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

async function getAdminSession() {
  const reqHeaders = await headers();
  const session = await auth.api.getSession({ headers: reqHeaders });
  if (!session || session.user.role !== "admin") return null;
  return session;
}

async function getHeaders() {
  return await headers();
}

export async function GET() {
  if (!(await getAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const reqHeaders = await getHeaders();
  const users = await auth.api.listUsers({
    headers: reqHeaders,
    query: { limit: 100 },
  });

  return NextResponse.json(users);
}

export async function POST(request: NextRequest) {
  if (!(await getAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const reqHeaders = await getHeaders();
  const body = await request.json();

  // Action: update role
  if (body.action === "setRole") {
    await auth.api.setRole({
      headers: reqHeaders,
      body: { userId: body.userId, role: body.role },
    });
    return NextResponse.json({ success: true });
  }

  // Action: remove user
  if (body.action === "remove") {
    await auth.api.removeUser({
      headers: reqHeaders,
      body: { userId: body.userId },
    });
    return NextResponse.json({ success: true });
  }

  // Action: create user
  const user = await auth.api.signUpEmail({
    body: {
      email: body.email,
      password: body.password,
      name: body.name,
    },
  });

  if (body.role) {
    await auth.api.setRole({
      headers: reqHeaders,
      body: { userId: user.user.id, role: body.role },
    });
  }

  return NextResponse.json(user, { status: 201 });
}
