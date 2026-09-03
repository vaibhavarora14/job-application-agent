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

const stdinText = await readStdin();

main(process.argv.slice(2), { stdinText })
  .then((result) => {
    if (result !== undefined) {
      console.log(JSON.stringify(result, null, 2));
    }
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
