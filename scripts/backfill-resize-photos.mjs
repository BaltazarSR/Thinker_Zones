// One-off maintenance script: re-encodes every capture photo / avatar already
// sitting in Supabase Storage down to the same size caps applied to new
// uploads (src/lib/image.ts) — 1600px for captures, 800px for avatars, JPEG
// quality 0.8. Overwrites each object in place (same storage key), so every
// `photo_url`/`avatar_url` already stored in the DB keeps working unchanged.
//
// Needs the service role key (Project Settings -> API -> service_role in the
// Supabase dashboard) since it must bypass Storage RLS to overwrite objects
// uploaded under other players' session-token folders. Never commit that key
// — pass it inline:
//
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-resize-photos.mjs

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const TARGETS = [
  { bucket: "captures", maxDimension: 1600 },
  { bucket: "avatars", maxDimension: 800 },
];

// Public URLs look like ".../storage/v1/object/public/<bucket>/<path>" —
// pull the path back out so we can download/re-upload by key.
function pathFromPublicUrl(url, bucket) {
  const marker = `/object/public/${bucket}/`;
  const i = url.indexOf(marker);
  return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length));
}

async function collectPaths(bucket) {
  const paths = new Set();
  if (bucket === "captures") {
    const { data, error } = await supabase.from("capture_events").select("photo_url").not("photo_url", "is", null);
    if (error) throw error;
    for (const row of data) {
      const path = pathFromPublicUrl(row.photo_url, bucket);
      if (path) paths.add(path);
    }
  } else {
    const { data, error } = await supabase.from("players").select("avatar_url").not("avatar_url", "is", null);
    if (error) throw error;
    for (const row of data) {
      const path = pathFromPublicUrl(row.avatar_url, bucket);
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

async function main() {
  let totalBefore = 0;
  let totalAfter = 0;

  for (const { bucket, maxDimension } of TARGETS) {
    const paths = await collectPaths(bucket);
    console.log(`\n${bucket}: ${paths.length} file(s) referenced in the DB`);

    for (const path of paths) {
      const { data: original, error: downloadError } = await supabase.storage.from(bucket).download(path);
      if (downloadError) {
        console.warn(`  skip ${path}: ${downloadError.message}`);
        continue;
      }
      const beforeBuffer = Buffer.from(await original.arrayBuffer());

      const afterBuffer = await sharp(beforeBuffer)
        .rotate() // bakes in EXIF orientation, then strips it
        .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(path, afterBuffer, { upsert: true, contentType: "image/jpeg" });
      if (uploadError) {
        console.warn(`  skip ${path}: ${uploadError.message}`);
        continue;
      }

      totalBefore += beforeBuffer.length;
      totalAfter += afterBuffer.length;
      console.log(`  ${path}: ${(beforeBuffer.length / 1024).toFixed(0)}KB -> ${(afterBuffer.length / 1024).toFixed(0)}KB`);
    }
  }

  console.log(
    `\nDone. ${(totalBefore / 1024 / 1024).toFixed(1)}MB -> ${(totalAfter / 1024 / 1024).toFixed(1)}MB` +
      ` (saved ${(((totalBefore - totalAfter) / totalBefore) * 100 || 0).toFixed(0)}%)`
  );
}

main().catch((error) => {
  console.error("Failed:", error?.message ?? error);
  if (error?.stack) console.error(error.stack);
  process.exit(1);
});
