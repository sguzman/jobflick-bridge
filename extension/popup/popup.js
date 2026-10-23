"use strict";

const jobsElement = document.getElementById("jobs");
const notice = document.getElementById("notice");
const scan = document.getElementById("scan");
const refresh = document.getElementById("refresh");
const FINISHED = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

function say(message) {
  notice.textContent = message;
}

async function ask(type, details = {}) {
  const result = await browser.runtime.sendMessage({ type, ...details });
  if (!result?.ok) throw new Error(result?.message || "No response from Jobflick Bridge");
  return result;
}

function element(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function exportReport(id, report) {
  const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "jobflick-" + id.replace(/[^a-zA-Z0-9_-]/g, "") + ".txt";
  document.body.append(a);
  a.click();
  a.remove();
  // Lifetime ends when the popup is closed; release after the action has had
  // a chance to start. Do not create a URL for reports until asked.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function renderItem(job) {
  const section = element("section", "job");
  if (/^#[0-9a-f]{6}$/i.test(job.color)) section.style.borderLeft = "4px solid " + job.color;
  const title = element("h2", "", job.name || job.id);
  section.append(title);
  const state = element("div", "meta state", job.state + (job.orphaned ? " · original tab unavailable" : ""));
  section.append(state);
  section.append(element("div", "meta", "Job " + job.id));
  const controls = element("div", "controls");
  if (FINISHED.has(job.state)) {
    const button = element("button", "", "Save report");
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      say("Retrieving report from Jobflick…");
      try {
        const result = await ask("jobflick:report", { id: job.id });
        exportReport(job.id, result.report);
        say("Report export requested.");
      } catch (error) {
        say(error.message);
      } finally {
        button.disabled = false;
      }
    });
    controls.append(button);

    const forget = element("button", "", "Forget bridge record");
    forget.type = "button";
    let armed = false;
    forget.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        forget.textContent = "Confirm forget";
        say("This only forgets the extension's routing record. Jobflick keeps its job and report.");
        return;
      }
      forget.disabled = true;
      try {
        await ask("jobflick:forget", { id: job.id });
        section.remove();
        say("Bridge record forgotten; Jobflick retains the durable job.");
        if (!jobsElement.children.length) {
          jobsElement.append(element("p", "", "No jobs tracked in the extension."));
        }
      } catch (error) {
        say(error.message);
        forget.disabled = false;
      }
    });
    controls.append(forget);
  }
  // Explicit user action to open a chat is not automatic report delivery.
  try {
    const destination = new URL(job.conversation);
    if (destination.protocol === "https:" &&
        ["chatgpt.com", "chat.openai.com"].includes(destination.hostname) &&
        destination.pathname.startsWith("/c/")) {
      const open = element("button", "", "Open chat");
      open.type = "button";
      open.addEventListener("click", () => {
        void browser.tabs.create({ url: destination.href }).catch(error => say(error.message));
      });
      controls.append(open);
    }
  } catch { /* Stored route not suitable for opening. */ }
  section.append(controls);
  return section;
}

async function load() {
  const response = await ask("jobflick:inbox");
  jobsElement.replaceChildren();
  if (!response.jobs.length) {
    jobsElement.append(element("p", "", "No jobs submitted from this Firefox extension yet."));
    return;
  }
  for (const job of response.jobs) {
    jobsElement.append(renderItem(job));
  }
}

scan.addEventListener("click", async () => {
  scan.disabled = true;
  try {
    await ask("jobflick:scan");
    say("Visible Execarium blocks scanned. Check the ChatGPT tab.");
  } catch (error) {
    say(error.message);
  } finally {
    scan.disabled = false;
  }
});

refresh.addEventListener("click", async () => {
  refresh.disabled = true;
  try {
    await ask("jobflick:refresh");
    await load();
    say("Job statuses refreshed.");
  } catch (error) {
    say(error.message);
  } finally {
    refresh.disabled = false;
  }
});

void load().catch(error => say(error.message));
