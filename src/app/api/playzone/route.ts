import { promises as fs } from "node:fs";
import path from "node:path";

const STYLE_PATH = path.join(process.cwd(), "public", "styles", "zone-wars.json");

function isValidRing(value: unknown): value is [number, number][] {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every(
      (pt) =>
        Array.isArray(pt) &&
        pt.length === 2 &&
        pt.every((n) => typeof n === "number" && Number.isFinite(n))
    )
  );
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return Response.json(
      { error: "Editing the playzone boundary is only available in development." },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const coordinates = body?.coordinates;

  if (!isValidRing(coordinates)) {
    return Response.json({ error: "Expected { coordinates: [[lng, lat], ...] } with at least 4 points." }, { status: 400 });
  }

  const raw = await fs.readFile(STYLE_PATH, "utf-8");
  const style = JSON.parse(raw);
  style.sources.playzone.data.geometry.coordinates = coordinates;

  await fs.writeFile(STYLE_PATH, JSON.stringify(style, null, 2) + "\n", "utf-8");

  return Response.json({ ok: true, points: coordinates.length });
}
