import { copyFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg");
const dir = path.join(root, "ffmpeg-bin");
const target = path.join(dir, "ffmpeg");

await mkdir(dir, { recursive: true });
await copyFile(source, target);
await chmod(target, 0o755);
console.log("FFmpeg copied to", target);
