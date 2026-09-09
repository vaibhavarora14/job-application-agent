export async function POST() {
  return Response.json({ error: "registration_closed" }, { status: 410, headers: { "cache-control": "no-store" } });
}
