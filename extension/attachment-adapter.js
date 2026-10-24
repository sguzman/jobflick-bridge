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
        input.files[0] !== file) {
      throw new Error("Firefox FileList handoff was not confirmed");
    }
    // The File object identity, not just its reported name and byte size,
    // is necessary. A page may substitute different bytes with the same
    // metadata during its synchronous change handler.
    input.dispatchEvent(new Event("change", { bubbles: true }));
    // A page listener may synchronously clear the FileList, replace its
    // contents, disable the control or detach the input. Do not report even
    // DOM-level success after that has happened.
    if (!input.isConnected || input.disabled ||
        input.files?.length !== 1 ||
        input.files[0] !== file) {
      throw new Error("File input changed during handoff; no attachment confirmed");
    }
    // A page can still reject asynchronously. This is never proof of upload.
    return { ok: true, domHandoffOnly: true, filename: file.name };
  }


  // A defensive, site-neutral precursor to a future authenticated adapter.
  // The caller must establish the *one* current composer/input and prove that
  // existing UI attachments are absent. No ChatGPT selector or Send is here.
  // This is still only a DOM FileList handoff, never an upload acknowledgment.
  function handoffToEmptyComposer(options) {
    const {
      composer, input, file, composerCandidates, fileInputCandidates,
      currentComposerCandidates, currentFileInputCandidates,
      expectedRoute, currentRoute, expectedEpoch, currentEpoch,
      existingAttachmentsAbsent
    } = options || {};
    if (!Array.isArray(composerCandidates) || composerCandidates.length !== 1 ||
        composerCandidates[0] !== composer ||
        !Array.isArray(fileInputCandidates) || fileInputCandidates.length !== 1 ||
        fileInputCandidates[0] !== input) {
      throw new Error("Composer or file input is ambiguous");
    }
    if (!composer || !composer.isConnected ||
        !(composer.tagName === "TEXTAREA" || composer.isContentEditable === true) ||
        typeof currentRoute !== "function" ||
        typeof expectedRoute !== "string" || !expectedRoute ||
        typeof currentEpoch !== "function" ||
        !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0 ||
        typeof existingAttachmentsAbsent !== "function" ||
        typeof currentComposerCandidates !== "function" ||
        typeof currentFileInputCandidates !== "function") {
      throw new Error("Composer or conversation authorization is unavailable");
    }
    if (existingAttachmentsAbsent() !== true) {
      throw new Error("Existing attachments cannot be ruled out");
    }
    const checkOriginAndDraft = () => {
      // Checking an epoch as well as the route prevents a synchronous
      // A -> B -> A transition from reusing stale authorization.
      if (currentRoute() !== expectedRoute ||
          currentEpoch() !== expectedEpoch) {
        throw new Error("Original conversation changed during handoff");
      }
      if (!composer.isConnected ||
          String(composer.value ?? composer.textContent ?? "").trim()) {
        throw new Error("Existing draft must not be overwritten");
      }
      // An attachment handler may rerender the editor, detach its input, or
      // expose another upload control synchronously. The *original* arrays
      // are not enough: refresh the live candidates on both sides of change.
      // A FileList handoff is never a server upload acknowledgment.
      const composersNow = currentComposerCandidates();
      const inputsNow = currentFileInputCandidates();
      if (!Array.isArray(composersNow) || composersNow.length !== 1 ||
          composersNow[0] !== composer ||
          !Array.isArray(inputsNow) || inputsNow.length !== 1 ||
          inputsNow[0] !== input || !input.isConnected || input.disabled) {
        throw new Error("Composer or file input changed during handoff");
      }
    };
    checkOriginAndDraft();
    const receipt = handoff(input, file);
    try {
      checkOriginAndDraft();
    } catch (error) {
      // A synchronous page change handler may have navigated A->B->A or
      // modified the draft. Revoke *only our own* pending input selection.
      // Never clear a preexisting or page-replaced user File.
      if (input.isConnected && input.files?.length === 1 &&
          input.files[0] === file) {
        input.value = "";
      }
      throw error;
    }
    return receipt;
  }

  Object.defineProperty(globalThis, "__jobflickAttachmentAdapter", {
    value: Object.freeze({ prepare, handoff, handoffToEmptyComposer }),
    writable: false, configurable: false
  });
})();
