(() => {
  "use strict";

  // Inert policy primitive: no browser messaging, DOM selectors, native calls,
  // report text, API requests or Send. A future, independently accepted
  // controller must durably commit an allowed transition BEFORE side effects.
  if (globalThis.__jobflickDeliveryPolicy) return;

  const FINISHED = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
  const JOB_ID = /^[a-zA-Z0-9_-]{8,128}$/;
  const STATES = new Set([
    "report_pending_manual_delivery", "attachment_preparing",
    "attachment_confirmed", "send_requested", "delivery_verified",
    "delivery_uncertain", "manual_only"
  ]);

  function canonical(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== "https:" ||
          !["chatgpt.com", "chat.openai.com"].includes(u.hostname) ||
          u.port || u.username || u.password || u.search || u.hash) return null;
      const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      const part = x => /^[a-zA-Z0-9_-]{4,256}$/.test(x || "");
      const direct = parts.length === 2 &&
        (parts[0] === "c" || parts[0] === "uc") && part(parts[1]);
      const nested = parts.length === 4 && parts[0] === "g" &&
        part(parts[1]) && parts[2] === "c" && part(parts[3]);
      return direct || nested ? u.origin + "/" + parts.join("/") : null;
    } catch { return null; }
  }

  function valid(record) {
    return record && typeof record === "object" &&
      typeof record.id === "string" && JOB_ID.test(record.id) &&
      !["__proto__", "constructor", "prototype"].includes(record.id) &&
      typeof record.origin === "string" && record.origin.startsWith("tab-") &&
      Number.isInteger(record.tabId) && record.tabId >= 0 &&
      Number.isSafeInteger(record.submittedAt) && record.submittedAt > 0 &&
      canonical(record.conversation) === record.conversation &&
      FINISHED.has(record.state) && STATES.has(record.deliveryState);
  }

  function hasOriginal(record, proof) {
    return proof && proof.jobId === record.id &&
      proof.tabId === record.tabId &&
      proof.origin === record.origin &&
      proof.conversation === record.conversation &&
      proof.currentConversation === record.conversation &&
      Number.isSafeInteger(proof.expectedEpoch) && proof.expectedEpoch >= 0 &&
      proof.currentEpoch === proof.expectedEpoch &&
      proof.originalTabVerified === true &&
      proof.siteIdentityVerified === true;
  }

  function exactReceipt(record, proof) {
    const r = proof?.receipt;
    return r && r.accepted === true && r.originalConversationVerified === true &&
      r.jobId === record.id &&
      r.filename === "jobflick-" + record.id + ".txt" &&
      r.conversation === record.conversation &&
      typeof r.composerIdentity === "string" &&
      r.composerIdentity.length > 0 &&
      r.composerIdentity === proof.composerIdentity &&
      // A filename or input change alone MUST NEVER satisfy this condition.
      r.siteAttachmentAcknowledged === true;
  }

  const refuse = reason => ({ ok: false, reason, effect: "none" });
  const advance = (record, deliveryState) => ({
    ok: true, next: { ...record, deliveryState },
    mustPersistBeforeSideEffect: true, effect: "none"
  });

  // A proposal changes neither browser storage nor the DOM. The caller has
  // responsibility for durable serialized write and identity revalidation.
  function propose(record, action, proof = {}) {
    if (!valid(record)) return refuse("Invalid or nonterminal Jobflick record");
    if (record.deliveryState === "delivery_verified") {
      return refuse("Already verified delivered; no further dispatch");
    }
    if (record.deliveryState === "delivery_uncertain") {
      return refuse("Unknown prior outcome; no automatic retry");
    }
    if (action === "origin_lost") {
      return advance(record, record.deliveryState === "send_requested"
        ? "delivery_uncertain" : "manual_only");
    }
    if (action === "reconcile_uncertain") {
      if (record.deliveryState !== "send_requested" &&
          record.deliveryState !== "attachment_preparing")
        return refuse("No unresolved attempt to reconcile");
      return advance(record, "delivery_uncertain");
    }
    if (record.deliveryState === "manual_only")
      return refuse("Origin permanently unavailable; manual export only");
    if (action === "begin_attachment") {
      if (record.deliveryState !== "report_pending_manual_delivery")
        return refuse("Attachment already attempted or wrong stage");
      if (!hasOriginal(record, proof) ||
          proof.optIn !== "attach-this-job" ||
          proof.composerCount !== 1 || proof.fileInputCount !== 1 ||
          proof.composerEmpty !== true ||
          proof.existingAttachmentsAbsent !== true ||
          proof.fileSelectionEmpty !== true)
        return refuse("Attachment identity, draft or consent failed");
      return advance(record, "attachment_preparing");
    }
    if (action === "attachment_acknowledged") {
      if (record.deliveryState !== "attachment_preparing" ||
          !hasOriginal(record, proof) || !exactReceipt(record, proof))
        return refuse("No authoritative same-composer attachment receipt");
      return advance(record, "attachment_confirmed");
    }
    if (action === "begin_send") {
      if (record.deliveryState !== "attachment_confirmed" ||
          !hasOriginal(record, proof) || !exactReceipt(record, proof) ||
          proof.optIn !== "send-this-job" || proof.composerEmpty !== true ||
          proof.attachmentCount !== 1 ||
          proof.noOtherAttachments !== true)
        return refuse("Send lacks independent opt-in, identity or receipt");
      // Caller MUST persist send_requested before even touching Send.
      // The real extension currently has no caller and no Send action.
      return advance(record, "send_requested");
    }
    if (action === "send_acknowledged") {
      if (record.deliveryState !== "send_requested" ||
          !hasOriginal(record, proof) ||
          !exactReceipt(record, proof) ||
          proof.receipt.siteSendAcknowledged !== true)
        return refuse("No authoritative same-conversation Send acknowledgement");
      return advance(record, "delivery_verified");
    }
    return refuse("Unsupported delivery event");
  }

  Object.defineProperty(globalThis, "__jobflickDeliveryPolicy", {
    value: Object.freeze({ propose }),
    writable: false, configurable: false
  });
})();
