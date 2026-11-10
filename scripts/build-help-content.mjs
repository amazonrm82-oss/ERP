// UX-05 / UX-06: builds src/features/help/content.generated.ts from the Markdown files of docs/help/.
//
//   node scripts/build-help-content.mjs          write the file
//   node scripts/build-help-content.mjs --check  exit 1 when the file is not current (the unit test checks the same)
//
// Run it after every change under docs/help/ and commit both. The app never reads docs/ at run time: the help center, the
// "?" help and the tour are compiled into the bundle, so the public /help pages stay static and nothing on Vercel needs
// the docs folder. The parser is src/features/help/content.ts (Node runs it with type stripping).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const helpDir = join(root, "docs", "help");
const target = join(root, "src", "features", "help", "content.generated.ts");

const { buildHelpContent, renderGeneratedModule } = await import(pathToFileURL(join(root, "src", "features", "help", "content.ts")).href);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(helpDir)
  .filter((path) => path.endsWith(".md"))
  .map((path) => ({ path: relative(helpDir, path).split(sep).join("/"), source: readFileSync(path, "utf8") }));

const text = renderGeneratedModule(buildHelpContent(files));

if (process.argv.includes("--check")) {
  const current = readFileSync(target, "utf8");
  if (current !== text) {
    console.error("src/features/help/content.generated.ts is not current: run node scripts/build-help-content.mjs");
    process.exit(1);
  }
  console.log("help content is current");
} else {
  writeFileSync(target, text);
  console.log(`wrote ${relative(root, target)}`);
}
