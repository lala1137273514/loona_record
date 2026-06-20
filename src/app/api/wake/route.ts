import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const WAKE_API_TIMEOUT_MS = 4500;

export async function GET() {
  const baseUrl = process.env.WAKE_API_URL;
  if (!baseUrl) {
    return NextResponse.json({ ok: false, error: "WAKE_API_URL is not configured" }, { status: 503 });
  }

  try {
    const upstream = await fetch(joinWakeUrl(baseUrl, "/health"), { cache: "no-store" });
    const payload = await readJson(upstream);
    return NextResponse.json(payload, { status: upstream.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const baseUrl = process.env.WAKE_API_URL;
  if (!baseUrl) {
    return NextResponse.json(
      { wake: false, error: "WAKE_API_URL is not configured" },
      { status: 503 },
    );
  }

  const sessionId = request.headers.get("x-loona-session-id") || "default";
  const body = await request.arrayBuffer();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WAKE_API_TIMEOUT_MS);

  try {
    const wakeApiToken = process.env.WAKE_API_TOKEN;
    const upstream = await fetch(joinWakeUrl(baseUrl, "/wake"), {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "x-loona-session-id": sessionId,
        ...(wakeApiToken ? { "x-loona-wake-token": wakeApiToken } : {}),
      },
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await readJson(upstream);
    return NextResponse.json(payload, { status: upstream.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json({ wake: false, error: errorMessage(error) }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

function joinWakeUrl(baseUrl: string, path: string) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  return url;
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "wake detector request failed";
}
