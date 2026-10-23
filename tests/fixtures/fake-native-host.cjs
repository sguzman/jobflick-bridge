#!/usr/bin/env node
"use strict";

// CI-only Firefox native-messaging host. Not Jobflick and never a command
// interpreter. Record only request action, job ID and opaque tab token; never
// log submitted YAML or user-authored command content.
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.JOBFLICK_QA_STATE;
if (!root || !path.isAbsolute(root)) process.exit(41);
const inbox = path.join(root, "native-requests.jsonl");
const id = "job_qa000001";

const input = [];
process.stdin.on("data", chunk => input.push(chunk));
process.stdin.on("end", () => {
  try {
    const data = Buffer.concat(input);
    if (data.length < 4) throw Error("Missing length prefix");
    const size = data.readUInt32LE(0);
    if (!size || size > 262144 + 8192 || data.length !== size + 4) {
      throw Error("Invalid length-prefixed Native Messaging request");
    }
    const request = JSON.parse(data.subarray(4).toString("utf8"));
    const entry = {
      action: request.action,
      id: typeof request.id === "string" ? request.id : null,
      origin_tab_id: typeof request.origin_tab_id === "string" ? request.origin_tab_id : null
    };
    fs.appendFileSync(inbox, JSON.stringify(entry) + "\n", { mode: 0o600 });
    let response;
    switch (request.action) {
      case "validate_spec":
        response = {
          ok: typeof request.spec_yaml === "string" &&
            request.spec_yaml.includes("schema: 4") &&
            request.spec_yaml.includes("name: Firefox native QA"),
          message: "Fake native validator: only synthetic fixture is permitted"
        };
        break;
      case "submit_spec":
        response = entry.origin_tab_id && typeof request.spec_yaml === "string" &&
          request.spec_yaml.includes("name: Firefox native QA") ?
          { ok: true, message: "Fake job queued (never executed)", job: {
            id, state: "queued", name: "Firefox native QA", color: "#5588AA"
          }} : { ok: false, message: "Wrong QA fixture or missing origin" };
        break;
      case "inspect":
        response = { ok: request.id === id, message: "Fake finished (never executed)",
          job: { id, state: "succeeded", name: "Firefox native QA", color: "#5588AA" }};
        break;
      case "show":
        response = { ok: request.id === id,
          message: "Fake report", report: "Synthetic Firefox Native Messaging result.\nNo command was run.\n" };
        break;
      case "cancel":
        response = { ok: request.id === id, message: "Fake stop acknowledged" };
        break;
      default:
        response = { ok: false, message: "Unsupported fake native action" };
    }
    const payload = Buffer.from(JSON.stringify(response), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.byteLength, 0);
    process.stdout.write(Buffer.concat([header, payload]));
  } catch {
    process.exitCode = 42;
  }
});
