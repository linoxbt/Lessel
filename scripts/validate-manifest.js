// Offline manifest check against the schema bundled in @forge/manifest.
// `forge lint` remains the authority; this catches structural mistakes without a login.
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const Ajv = require("ajv");
const schema = JSON.parse(fs.readFileSync(
  path.join(path.dirname(require.resolve("@forge/manifest")), "schema", "manifest-schema.json"), "utf8"));

const manifest = YAML.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.yml"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(schema);
if (validate(manifest)) {
  console.log("manifest.yml matches the @forge/manifest schema");
} else {
  // oneOf failures are noisy; show the deepest, most specific errors first
  const errs = validate.errors
    .filter(e => e.keyword !== "oneOf" && e.keyword !== "anyOf")
    .map(e => `${e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`);
  console.error([...new Set(errs)].join("\n"));
  process.exit(1);
}
