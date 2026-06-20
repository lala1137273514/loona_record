export function isValidAdminToken(provided: string | null, expected = process.env.ADMIN_EXPORT_TOKEN) {
  return Boolean(provided && expected && provided === expected);
}

export function assertAdminRequest(request: Request) {
  const token = request.headers.get("x-admin-token");
  if (!isValidAdminToken(token)) {
    return new Response(JSON.stringify({ error: "Invalid admin token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  return null;
}
