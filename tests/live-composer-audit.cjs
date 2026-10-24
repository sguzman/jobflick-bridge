"use strict";

// Explicit, read-only LIVE discovery in the dedicated Firefox Developer Edition
// QA profile. Not CI and never a substitute for authenticated upload acceptance.
// No file assignments, clicks, transcript capture, native messages, or Send.
const fs = require("node:fs");
const path = require("node:path");

function abort(message) {
  throw new Error(message);
}

function canonicalConversation(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const valid = x => typeof x === "string" && /^[a-zA-Z0-9_-]{4,256}$/.test(x);
    const direct = parts.length === 2 && ["c","uc"].includes(parts[0]) && valid(parts[1]);
    const nested = parts.length === 4 && parts[0] === "g" &&
      valid(parts[1]) && parts[2] === "c" && valid(parts[3]);
    if (url.protocol !== "https:" ||
        !["chatgpt.com","chat.openai.com"].includes(url.hostname) ||
        url.port || url.username || url.password || url.search || url.hash ||
        !(direct || nested)) return null;
    return url.origin + "/" + parts.join("/");
  } catch {
    return null;
  }
}

function dedicatedProfile() {
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home) || home === "/")
    abort("Missing safe absolute HOME");
  const data = Object.prototype.hasOwnProperty.call(process.env,"XDG_DATA_HOME") ?
    process.env.XDG_DATA_HOME : path.join(home, ".local", "share");
  if (!data || !path.isAbsolute(data) || data === "/")
    abort("Unsafe XDG_DATA_HOME");
  // Never follow an XDG_DATA_HOME link into an unrelated browser tree.
  try {
    if (fs.lstatSync(data).isSymbolicLink())
      abort("Symlinked XDG_DATA_HOME is not a safe QA root");
  } catch { abort("Dedicated QA data directory missing"); }
  const root = path.join(data, "jobflick-bridge-fde-qa");
  const profile = path.join(root, "profile");
  for (const target of [root, profile]) {
    let entry;
    try { entry = fs.lstatSync(target); } catch { abort("Dedicated QA profile missing"); }
    if (!entry.isDirectory() || entry.isSymbolicLink())
      abort("QA profile path must be a real directory, not a link");
    if ((entry.mode & 0o077) !== 0)
      abort("Dedicated QA profile must be private to its owner");
  }
  // Refuse a running/unclean QA profile instead of competing for its lock.
  for (const marker of [".parentlock", "parent.lock", "lock"]) {
    if (fs.existsSync(path.join(profile, marker)))
      abort("QA profile is in use or has an unreconciled lock");
  }
  return profile;
}

function readOnlyObservation(doc = document) {
  const composers = [...doc.querySelectorAll(
    '#prompt-textarea[contenteditable="true"], ' +
    '[data-testid="composer-rich-text-input"][contenteditable="true"], ' +
    'textarea#prompt-textarea, textarea[data-testid="composer-textarea"]'
  )];
  const files = [...doc.querySelectorAll('input[type="file"]')];
  // Do not equate all file pickers with a general-document target:
  // ChatGPT can separately expose photo and camera inputs.
  const general = files.filter(input =>
    input.id === "upload-files" && input.type === "file");
  const addButtons = [...doc.querySelectorAll(
    'button[data-testid="composer-plus-btn"]'
  )];
  // Never return any draft, filename, element reference or page route.
  return {
    composerCandidates: composers.length,
    composerAmbiguous: composers.length !== 1,
    draftOccupied: composers.some(node =>
      !!String(node.value ?? node.textContent ?? "").trim()),
    fileInputCandidates: files.length,
    fileInputAmbiguous: files.length !== 1,
    fileAlreadySelected: files.some(input => (input.files?.length || 0) > 0),
    generalUploadInputCandidates: Math.min(2,general.length),
    generalUploadInputUsable: general.length === 1 &&
      general[0].isConnected === true && general[0].disabled !== true,
    composerAddButtonCandidates: Math.min(2,addButtons.length),
    composerAddButtonUsable: addButtons.length === 1 &&
      addButtons[0].isConnected === true && addButtons[0].disabled !== true
  };
}

// Multiple bounded read-only samples separate page load from SPA hydration.
// Never expose arbitrary page fields: allowlisted counts and booleans only.
async function observeStable(driver,expected,options={}) {
  const delay=options.delay||((ms)=>new Promise(ok=>setTimeout(ok,ms)));
  const clock=options.clock||(()=>Date.now());
  const timeout=options.timeoutMs??12000;
  const interval=options.intervalMs??400;
  const required=options.required??3;
  if(!Number.isInteger(timeout)||timeout<0||
     !Number.isInteger(interval)||interval<1||
     !Number.isInteger(required)||required<2) throw Error("Invalid audit limits");
  const start=clock();
  let last=null,key="",repeat=0,samples=0;
  while(true){
    if(canonicalConversation(await driver.getCurrentUrl())!==expected)
      throw Error("Conversation route changed");
    const read=await driver.executeScript(readOnlyObservation);
    if(canonicalConversation(await driver.getCurrentUrl())!==expected)
      throw Error("Conversation route changed during inspection");
    if(!read||!Number.isInteger(read.composerCandidates)||read.composerCandidates<0||
      !Number.isInteger(read.fileInputCandidates)||read.fileInputCandidates<0||
      ["composerAmbiguous","draftOccupied","fileInputAmbiguous","fileAlreadySelected",
        "generalUploadInputUsable","composerAddButtonUsable"]
        .some(k=>typeof read[k]!=="boolean") ||
      ["generalUploadInputCandidates","composerAddButtonCandidates"]
        .some(k=>!Number.isInteger(read[k])||read[k]<0||read[k]>2))
      throw Error("Invalid read-only observation");
    last={
      composerCandidates:read.composerCandidates,composerAmbiguous:read.composerAmbiguous,
      draftOccupied:read.draftOccupied,fileInputCandidates:read.fileInputCandidates,
      fileInputAmbiguous:read.fileInputAmbiguous,fileAlreadySelected:read.fileAlreadySelected,
      generalUploadInputCandidates:read.generalUploadInputCandidates,
      generalUploadInputUsable:read.generalUploadInputUsable,
      composerAddButtonCandidates:read.composerAddButtonCandidates,
      composerAddButtonUsable:read.composerAddButtonUsable
    };
    const fingerprint=JSON.stringify(last);
    repeat=fingerprint===key?repeat+1:1;
    key=fingerprint;
    samples++;
    if(last.composerCandidates>0&&repeat>=required)
      return {observation:last,stable:true,samples};
    if(clock()-start>=timeout) return {observation:last,stable:false,samples};
    await delay(interval);
  }
}

// A structurally incomplete read-only sample is *not* live upload
// discovery. This never implies authentication or attachment acceptance.
function structuralCandidatesUnique(result) {
  const o=result?.observation;
  return result?.stable===true && o?.composerCandidates===1 &&
    o.composerAmbiguous===false &&
    o.generalUploadInputCandidates===1 &&
    o.generalUploadInputUsable===true &&
    o.composerAddButtonCandidates===1 &&
    o.composerAddButtonUsable===true;
}

async function main() {
  if (process.env.JOBFLICK_LIVE_READONLY_QA !== "YES")
    abort("Explicit read-only live QA opt-in required");
  const expected = canonicalConversation(process.env.CHATGPT_QA_URL);
  if (!expected) abort("Use an exact canonical ChatGPT conversation URL");
  const profile = dedicatedProfile();
  const binary = process.env.FDE_BINARY;
  if (!binary || !path.isAbsolute(binary) || !fs.statSync(binary).isFile())
    abort("FDE_BINARY must identify the installed Firefox Developer Edition");
  // Import WebDriver only after every scope and consent preflight succeeds.
  const { Builder } = require("selenium-webdriver");
  const firefox = require("selenium-webdriver/firefox");
  const options = new firefox.Options().setBinary(binary)
    .addArguments("-headless", "-profile", profile);
  let driver = null;
  try {
    driver = await new Builder().forBrowser("firefox")
      .setFirefoxOptions(options).build();
    await driver.get(expected);
    await driver.wait(async () => await driver.executeScript(
      "return document.readyState==='complete' && Boolean(document.body)"
    ), 20000);
    const before = canonicalConversation(await driver.getCurrentUrl());
    if (before !== expected) abort("Not on the exact requested conversation route");
    // A complete document is not necessarily a hydrated React composer.
    const result=await observeStable(driver,expected);
    const observation=result.observation;
    // A hidden upload control might be created only after opening a menu.
    // A missing input is inconclusive, not evidence that uploads are absent.
    console.log(JSON.stringify({
      target: "exact Firefox QA conversation route",
      mode: "read-only",
      authenticatedSessionVerified: false,
      supportedSingleComposerObserved: result.stable && observation.composerCandidates === 1,
      hydrationStable: result.stable,
      structuralCandidatesUnique: structuralCandidatesUnique(result),
      observationSamples: result.samples,
      ...observation,
      fileInputAbsenceInconclusive: observation.generalUploadInputCandidates === 0,
      attachmentConfirmed: false,
      sendAttempted: false
    }));
    // A code-0 QA observation must not mean a missing or ambiguous editor
    // was successfully discovered. Code 2 is inconclusive, not a crash.
    if (!structuralCandidatesUnique(result)) process.exitCode = 2;
  } finally {
    if (driver) await driver.quit();
  }
}
if (require.main === module) {
  main().catch(() => {
    // Never print WebDriver errors which may contain the private conversation URL.
    console.error("Read-only live QA refused or failed. Verify the dedicated profile, opt-in, FDE/geckodriver and exact conversation.");
    process.exitCode = 1;
  });
}

// Imported by safety tests without launching Firefox or opening any URL.
module.exports = { canonicalConversation, dedicatedProfile, readOnlyObservation, observeStable, structuralCandidatesUnique };

