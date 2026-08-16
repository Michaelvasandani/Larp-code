import { chmodSync, mkdirSync, readdirSync, lstatSync, unlinkSync, utimesSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");

function walk(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap((entry) => {
    const path = join(current, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`package tree contains symlink: ${relative(root, path)}`);
    if (stat.isDirectory()) return walk(root, path);
    if (!stat.isFile()) throw new Error(`package tree contains non-regular entry: ${relative(root, path)}`);
    return [path];
  });
}

export function createDeterministicZip(packageRoot, archivePath) {
  const root = resolve(packageRoot);
  const archive = resolve(archivePath);
  const files = walk(root);
  if (files.length === 0) throw new Error("cannot archive an empty package");
  mkdirSync(dirname(archive), { recursive: true });
  try { unlinkSync(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const file of files) {
    chmodSync(file, 0o644);
    utimesSync(file, ZIP_EPOCH, ZIP_EPOCH);
  }
  const relativeFiles = files.map((file) => relative(root, file).replaceAll("\\", "/")).sort();
  execFileSync("zip", ["-q", "-X", archive, ...relativeFiles], { cwd: root, stdio: "pipe" });
  return archive;
}
