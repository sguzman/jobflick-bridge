(() => {
  "use strict";

  // Inert until a future, separately authorized delivery feature calls it.
  // DOM handoff is NOT proof that ChatGPT accepted an upload.
  if (globalThis.__jobflickAttachmentAdapter) return;
  const MAX_REPORT_BYTES = 524288;
  const JOB_ID = /^[a-zA-Z0-9_-]{8,128}$/;

  function prepare(jobId, reportText) {
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) {
      throw new Error("Invalid Jobflick report ID");
    }
    if (typeof reportText !== "string" || reportText.length > MAX_REPORT_BYTES ||
        new TextEncoder().encode(reportText).byteLength > MAX_REPORT_BYTES) {
      throw new Error("Report exceeds 512 KiB; use Jobflick for full logs");
    }
    return new File([reportText], "jobflick-" + jobId + ".txt", {
      type: "text/plain"
    });
  }

  function handoff(input, file) {
    // Do not choose a ChatGPT selector here. A later, independently QA'd
    // composer adapter must identify one correct, connected file input.
    if (!input || input.tagName !== "INPUT" || input.type !== "file" ||
        !input.isConnected || input.disabled) {
      throw new Error("No verified usable file input");
    }
    if (!file || typeof file.name !== "string" ||
        !/^jobflick-[a-zA-Z0-9_-]{8,128}\.txt$/.test(file.name) ||
        file.type !== "text/plain" ||
        !Number.isFinite(file.size) || file.size > MAX_REPORT_BYTES) {
      throw new Error("Invalid bounded Jobflick report File");
    }
    if (input.files?.length) {
      throw new Error("Existing file selection must not be overwritten");
    }
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    if (input.files?.length !== 1 ||
        input.files[0]?.name !== file.name ||
        input.files[0]?.size !== file.size) {
      throw new Error("Firefox FileList handoff was not confirmed");
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // A page listener may synchronously clear the FileList, replace its
    // contents, disable the control or detach the input. Do not report even
    // DOM-level success after that has happened.
    if (!input.isConnected || input.disabled ||
        input.files?.length !== 1 ||
        input.files[0]?.name !== file.name ||
        input.files[0]?.size !== file.size ||
        input.files[0]?.type !== file.type) {
      throw new Error("File input changed during handoff; no attachment confirmed");
    }
    // A page can still reject asynchronously. This is never proof of upload.
    return { ok: true, domHandoffOnly: true, filename: file.name };
  }

  Object.defineProperty(globalThis, "__jobflickAttachmentAdapter", {
    value: Object.freeze({ prepare, handoff }),
    writable: false, configurable: false
  });
})();
