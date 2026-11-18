// Runs the Forge CLI's client-side linters without `forge login` (scopes, handlers, manifest, endpoints).
// `forge lint` remains the authority before deploying. Needs @forge/cli installed: globally
// (npm i -g @forge/cli), locally, or at FORGE_CLI_DIR=<dir containing node_modules/@forge/cli>.
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

function findCli() {
  const candidates = [
    process.env.FORGE_CLI_DIR && path.join(process.env.FORGE_CLI_DIR, "node_modules/@forge/cli"),
    path.join(__dirname, "..", "node_modules/@forge/cli"),
  ];
  try { candidates.push(path.join(execSync("npm root -g").toString().trim(), "@forge/cli")); } catch { /* no npm */ }
  return candidates.find(c => c && fs.existsSync(path.join(c, "package.json")));
}

const cliDir = findCli();
if (!cliDir) { console.error("Install @forge/cli (npm i -g @forge/cli) or set FORGE_CLI_DIR."); process.exit(2); }
const req = m => require(require.resolve(m, { paths: [cliDir] }));
const { lint, reportLintResults, problemCount } = req("@forge/lint");
const YAML = req("yaml");

const appDir = path.resolve(__dirname, "..");
process.chdir(appDir);
const manifest = YAML.parse(fs.readFileSync("manifest.yml", "utf8"));
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (/\.(js|jsx|ts|tsx)$/.test(f.name)) files.push(p);
  }
})("src");

// Feature-flag service stub: no remote flags offline.
const statsig = new Proxy({}, { get: (_, k) => async () => (k === "getDeprecatedRuntimes" ? [] : false) });
const out = [];
const logger = { info: m => out.push(String(m)), warn: m => out.push(String(m)), error: m => out.push(String(m)),
  log: m => out.push(String(m)), debug: () => {}, trace: () => {} };

lint(files, manifest, "development", logger, statsig, { linter: { mode: "client-side" } })
  .then(results => {
    reportLintResults(logger, results, true);
    console.log(out.join("\n"));
    process.exit(problemCount(results).errors ? 1 : 0);
  })
  .catch(e => { console.error("lint crashed:", e); process.exit(2); });
