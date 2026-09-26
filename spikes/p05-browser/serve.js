// Tiny static server for the P0.5 spike page. Node built-ins only.
const http = require("http");
const fs = require("fs");
const path = require("path");
const page = fs.readFileSync(path.join(__dirname, "index.html"));
const port = Number(process.argv[2] || 4173);
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(port, "127.0.0.1", () => console.log("serving on http://127.0.0.1:" + port + "/"));
