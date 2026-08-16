import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(siteRoot, "..");
const outputRoot = resolve(process.argv[2] ?? join(siteRoot, "dist"));
const supportUrl = "https://github.com/Michaelvasandani/Larp-code/issues";

const page = ({ title, body }) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root { color: #243027; background: #f4f0e7; font: 16px/1.55 system-ui, sans-serif; }
      body { max-width: 720px; margin: 0 auto; padding: 36px 22px 64px; }
      main { padding: 28px; border: 1px solid #d6d0c1; border-radius: 18px; background: #fffdf9; }
      h1, h2 { font-family: Georgia, serif; font-weight: 500; }
      h1 { margin-top: 0; }
      a { color: #2e5a3a; }
      nav { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 28px; }
    </style>
  </head>
  <body><main>${body}</main></body>
</html>
`;

for (const path of ["privacy", "legal", "support"]) {
  mkdirSync(join(outputRoot, path), { recursive: true });
}

copyFileSync(join(repositoryRoot, "src/privacy.html"), join(outputRoot, "privacy/index.html"));
copyFileSync(join(repositoryRoot, "src/legal.html"), join(outputRoot, "legal/index.html"));

writeFileSync(join(outputRoot, "index.html"), page({
  title: "larp-code",
  body: `<h1>larp-code</h1>
      <p>A two-person NeetCode 150 accountability companion for adults.</p>
      <p>larp-code is independent and is not affiliated with, endorsed by, or sponsored by NeetCode or LeetCode.</p>
      <nav aria-label="Public information">
        <a href="/privacy">Privacy policy</a>
        <a href="/legal">Legal and about</a>
        <a href="/support">Support</a>
      </nav>`,
}));

writeFileSync(join(outputRoot, "support/index.html"), page({
  title: "larp-code support",
  body: `<h1>larp-code support</h1>
      <p>For support, privacy questions, deletion requests, or security reports, use the public GitHub issue route.</p>
      <p><a href="${supportUrl}" rel="noreferrer">Open a support issue</a></p>
      <p>Never include a one-time code, session token, source code, private Challenge details, or another member’s information.</p>
      <nav aria-label="Public information"><a href="/privacy">Privacy policy</a><a href="/legal">Legal and about</a></nav>`,
}));

writeFileSync(join(outputRoot, "vercel.json"), `${JSON.stringify({ cleanUrls: true, trailingSlash: false }, null, 2)}\n`);
