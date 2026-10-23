import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
test("QA launcher targets only Firefox Developer Edition and owns separate profile", () => {
  const qa = read("scripts/qa-firefox-developer.fish");
  assert(qa.includes("command -sq firefox-developer-edition"));
  assert(qa.includes('exec firefox-developer-edition --no-remote --profile "$profile"'));
  assert(qa.includes("jobflick-bridge-fde-qa"));
  assert(qa.includes('test -L "$profile"'));
  assert(!qa.includes("firefox-bin"));
  assert(!qa.includes("killall"));
  assert(!qa.includes("pkill"));
  assert(!qa.includes("about:config"));
  assert(!qa.includes("user.js"));
  assert(!qa.includes("install-native-host.fish"));
  assert(!qa.includes("allowed_extensions"));
});

test("documentation preserves QA/native-host distinction", () => {
  const qa = read("docs/QA.md");
  assert(qa.includes("per OS user"));
  assert(qa.includes("Load Temporary Add-on"));
});
