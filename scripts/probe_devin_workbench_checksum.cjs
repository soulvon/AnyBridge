const fs = require("fs");
const crypto = require("crypto");
const path = "E:/Program/devin/resources/app/out/vs/code/electron-browser/workbench/workbench.html";
const backup = path + ".byok-origin";
const product = "E:/Program/devin/resources/app/product.json";
const expected = JSON.parse(fs.readFileSync(product, "utf8")).checksums["vs/code/electron-browser/workbench/workbench.html"];

function variants(buf) {
  const s = buf.toString("utf8");
  const list = {
    raw_buffer: crypto.createHash("sha256").update(buf).digest("base64").replace(/=+$/, ""),
    utf8_string: crypto.createHash("sha256").update(s, "utf8").digest("base64").replace(/=+$/, ""),
    no_crlf: crypto.createHash("sha256").update(s.replace(/\r\n/g, "\n"), "utf8").digest("base64").replace(/=+$/, ""),
    no_bom: crypto.createHash("sha256").update(s.replace(/^\uFEFF/, ""), "utf8").digest("base64").replace(/=+$/, ""),
  };
  // VS Code sometimes prefixes with a char strip? also full base64 with =
  list.raw_full = crypto.createHash("sha256").update(buf).digest("base64");
  list.hex = crypto.createHash("sha256").update(buf).digest("hex");
  return list;
}

for (const [label, p] of [["current", path], ["backup", backup]]) {
  if (!fs.existsSync(p)) { console.log(label, "missing"); continue; }
  const buf = fs.readFileSync(p);
  const v = variants(buf);
  console.log("====", label, "size", buf.length);
  for (const [k, val] of Object.entries(v)) {
    console.log(k, val, val === expected ? "MATCH" : "");
  }
  console.log("contains byok?", buf.toString("utf8").includes("byok-cards"));
}
console.log("expected", expected);
const html = fs.readFileSync(path, "utf8");
console.log("byok markers", {
  start: html.includes("byok-cards-start"),
  ver: html.includes("byok-cards-v1"),
  unsafe: html.includes("unsafe-inline"),
});
