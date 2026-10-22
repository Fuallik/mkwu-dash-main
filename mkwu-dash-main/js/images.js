import { LIMITS } from "./config.js";

export class ImageError extends Error {}

// Re-encode on the device: smaller upload, consistent JPEG, and EXIF/location metadata dropped.
export async function compressProof(file) {
  if (!(file instanceof Blob) || !file.size) throw new ImageError("File foto kosong.");
  if (file.size > LIMITS.proofSourceBytes) throw new ImageError(`Foto maksimal ${Math.round(LIMITS.proofSourceBytes / 1048576)} MB sebelum dikompres.`);
  if (file.type && !file.type.startsWith("image/")) throw new ImageError("File harus berupa foto (JPG, PNG, atau WEBP).");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ImageError("Foto tidak dapat dibaca browser. Gunakan JPG, PNG, atau WEBP.");
  }
  try {
    let scale = Math.min(1, LIMITS.proofMaxSide / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 7; attempt++) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff"; // Transparent PNG screenshots stay readable as JPEG.
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const quality = [0.86, 0.78, 0.7][Math.min(attempt, 2)];
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      canvas.width = 0;
      canvas.height = 0;
      if (blob?.type === "image/jpeg" && blob.size <= LIMITS.proofUploadBytes) return blob;
      if (attempt >= 2) scale *= 0.8;
    }
  } finally {
    bitmap.close?.();
  }
  throw new ImageError("Foto masih terlalu besar setelah dikompres. Coba potong (crop) foto terlebih dahulu.");
}

export const fileSize = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
