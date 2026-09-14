// Downscales + re-encodes a photo before it ever reaches Supabase Storage.
// Camera photos routinely come in at several MB; every display site (even a
// 64px log thumbnail) was loading that full file, which is expensive on both
// storage and egress. `imageOrientation: "from-image"` makes createImageBitmap
// bake in EXIF rotation, since drawing straight to canvas otherwise ignores it.
export async function resizeImage(file: File, maxDimension: number, quality = 0.8): Promise<File> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) return file;

  const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], name, { type: "image/jpeg" });
}
