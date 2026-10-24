import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ACCEPTABLE_OPEN = new Set(["M7-07", "M7-08"]);
const VALID_STATUS = new Set(["verified", "implemented", "planned"]);

export function signingPrerequisites(progress, manifest, pkg) {
  if (!progress || !Array.isArray(progress.milestones) ||
      !progress.overall || !manifest || !pkg)
    return { ok: false, reason: "Invalid signing inputs" };

  const tasks = progress.milestones.flatMap(m => Array.isArray(m.tasks) ? m.tasks : []);
  const ids = tasks.map(t => t?.id);
  const totals = {
    verified: tasks.filter(t => t?.status === "verified").length,
    implemented: tasks.filter(t => t?.status === "implemented").length,
    planned: tasks.filter(t => t?.status === "planned").length
  };
  if (tasks.length !== 63 || progress.overall.total !== 63 ||
      ids.some(id => typeof id !== "string") ||
      new Set(ids).size !== 63 || ids.filter(id => ACCEPTABLE_OPEN.has(id)).length !== 2 ||
      tasks.some(t => !VALID_STATUS.has(t?.status)) ||
      Object.entries(totals).some(([key, n]) => progress.overall[key] !== n) ||
      progress.overall.percent !== Math.floor(100 * totals.verified / 63))
    return { ok: false, reason: "Inconsistent 63-task progress ledger" };

  if (tasks.some(t => t.status !== "verified" && !ACCEPTABLE_OPEN.has(t.id)))
    return { ok: false, reason: "Prerequisite acceptance tasks still unverified" };

  if (tasks.some(t => t.status === "verified" &&
      (!Array.isArray(t.evidence) || t.evidence.length === 0)))
    return { ok: false, reason: "Verified tasks missing acceptance evidence" };

  if (manifest.version !== pkg.version ||
      manifest.browser_specific_settings?.gecko?.id !== "jobflick-bridge@sguzman.github.io")
    return { ok: false, reason: "Firefox version or stable Gecko ID mismatch" };

  return { ok: true, reason: "All prerequisites verified; signing/release evidence may remain open" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const progress = JSON.parse(readFileSync("progress.json", "utf8"));
  const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const result = signingPrerequisites(progress, manifest, pkg);
  if (!result.ok) {
    console.error("Mozilla signing blocked: " + result.reason);
    process.exitCode = 1;
  } else {
    console.log(result.reason);
  }
}
