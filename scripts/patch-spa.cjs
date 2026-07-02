// scripts/patch-spa.cjs — replace SPA file-serving code with embedded WEB_ASSETS
const fs = require('fs')
let c = fs.readFileSync('dist/server-bundle.cjs', 'utf-8')

// Replace /assets/* handler
const assetsOld = c.match(/  app\.get\("\/assets\/\*", \(c\) => \{[\s\S]*?\n  \}\);/)?. [0]
if (assetsOld) {
  c = c.replace(assetsOld, [
    '  app.get("/assets/*", (c) => {',
    '    var assetPath = c.req.path.slice(1);',
    '    var embedded = serveWebAsset("/" + assetPath);',
    '    if (embedded) return c.body(embedded.body, 200, {"Content-Type": embedded.mime});',
    '    var filePath = (0, import_node_path.resolve)(distDir, assetPath);',
    '    if (!filePath.startsWith(distDir)) return c.notFound();',
    '    if (!(0, import_node_fs8.existsSync)(filePath)) return c.notFound();',
    '    var ext = filePath.split(".").pop();',
    '    var mime = { js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", woff2: "font/woff2" };',
    '    return c.body((0, import_node_fs8.readFileSync)(filePath), 200, {"Content-Type": mime[ext ?? ""] ?? "application/octet-stream"});',
    '  });',
  ].join('\n'))
  console.log('[patch-spa] /assets/* replaced')
} else {
  console.log('[patch-spa] WARNING: /assets/* pattern not found')
}

// Replace SPA fallback
const spaOld = c.match(/  app\.get\("\/\*", \(c\) => \{[\s\S]*?\n  \}\);/)?. [0]
if (spaOld) {
  c = c.replace(spaOld, [
    '  app.get("/*", (c) => {',
    '    if (c.req.path.startsWith("/api")) return c.notFound();',
    '    var embeddedIndex = serveWebAsset("/index.html");',
    '    if (embeddedIndex) return c.body(embeddedIndex.body, 200, {"Content-Type": embeddedIndex.mime});',
    '    if (!(0, import_node_fs8.existsSync)(distIndex))',
    '      return c.text("SPA not built. Run `pnpm build` first.", 500);',
    '    return c.html((0, import_node_fs8.readFileSync)(distIndex, "utf-8"));',
    '  });',
  ].join('\n'))
  console.log('[patch-spa] SPA fallback replaced')
} else {
  console.log('[patch-spa] WARNING: SPA pattern not found')
}

fs.writeFileSync('dist/server-bundle.cjs', c, 'utf-8')
console.log('[patch-spa] done')
