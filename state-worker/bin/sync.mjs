#!/usr/bin/env node
import { main } from "../src/cli.mjs";

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const argv = process.argv.slice(2);
const command = argv[0];
const needsStdin = command === "enable" && (!argv.includes("--url") || !argv.includes("--token"));
const stdinText = needsStdin ? await readStdin() : "";

main(argv, { stdinText })
  .then((result) => {
    if (result !== undefined) {
      console.log(JSON.stringify(result, null, 2));
    }
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
