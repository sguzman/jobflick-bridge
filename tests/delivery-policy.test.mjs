import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extension/delivery-policy.js",import.meta.url),"utf8");
const ctx = { URL, Set, Object, Number };
vm.runInNewContext(source,ctx,{filename:"delivery-policy.js"});
const { propose } = ctx.__jobflickDeliveryPolicy;

const base = () => ({
  id: "job_12345678", recordVersion: 1, tabId: 11, origin: "tab-session-qa",
  submittedAt: 123, state: "succeeded",
  conversation: "https://chatgpt.com/c/testing-1234",
  deliveryState: "report_pending_manual_delivery"
});
const evidence = () => ({
  jobId: "job_12345678", tabId: 11, origin: "tab-session-qa",
  conversation: "https://chatgpt.com/c/testing-1234",
  currentConversation: "https://chatgpt.com/c/testing-1234",
  expectedEpoch: 5, currentEpoch: 5, originalTabVerified: true,
  siteIdentityVerified: true, composerIdentity: "composer-A",
  composerCount: 1, fileInputCount: 1, composerEmpty: true,
  existingAttachmentsAbsent: true, fileSelectionEmpty: true,
  noOtherAttachments: true, attachmentCount: 1,
  receipt: {
    jobId: "job_12345678",
    filename: "jobflick-job_12345678.txt",
    conversation: "https://chatgpt.com/c/testing-1234",
    composerIdentity: "composer-A", accepted: true,
    originalConversationVerified: true, siteAttachmentAcknowledged: true,
    siteSendAcknowledged: true
  }
});

test("no Send or upload side effects: policy only proposes persist-before-action states",()=>{
  const record=base(), proof=evidence();
  const denied=propose(record,"begin_send",{...proof,optIn:"send-this-job"});
  assert.equal(denied.ok,false);
  const p1=propose(record,"begin_attachment",{...proof,optIn:"attach-this-job"});
  assert.equal(p1.ok,true);
  assert.equal(p1.effect,"none");
  assert.equal(p1.mustPersistBeforeSideEffect,true);
  assert.equal(p1.next.deliveryState,"attachment_preparing");
  assert.equal(record.deliveryState,"report_pending_manual_delivery");
  const p2=propose(p1.next,"attachment_acknowledged",proof);
  assert.equal(p2.ok,true);
  assert.equal(p2.next.deliveryState,"attachment_confirmed");
  assert.equal(propose(p2.next,"begin_send",{...proof,optIn:"attach-this-job"}).ok,false);
  const p3=propose(p2.next,"begin_send",{...proof,optIn:"send-this-job"});
  assert.equal(p3.next.deliveryState,"send_requested");
  assert.equal(propose(p3.next,"begin_send",{...proof,optIn:"send-this-job"}).ok,false);
  const p4=propose(p3.next,"send_acknowledged",proof);
  assert.equal(p4.next.deliveryState,"delivery_verified");
  assert.equal(propose(p4.next,"begin_send",{...proof,optIn:"send-this-job"}).ok,false);
});

test("missing source acknowledgment or filename match never confirms an attachment",()=>{
  const record={...base(),deliveryState:"attachment_preparing"};
  const proof=evidence();
  for(const receipt of [
    null, { ...proof.receipt,filename:"user-draft.txt" },
    { ...proof.receipt,siteAttachmentAcknowledged:false },
    { ...proof.receipt,jobId:"job_different" },
    { ...proof.receipt,composerIdentity:"composer-B" },
    { ...proof.receipt,conversation:"https://chatgpt.com/c/other-1234" }
  ]) {
    assert.equal(propose(record,"attachment_acknowledged",{...proof,receipt}).ok,false);
  }
});

test("existing draft, files, ambiguous composers or lost authorization deny attachment",()=>{
  const proof=evidence();
  for(const variant of [
    {composerEmpty:false}, {existingAttachmentsAbsent:false},
    {fileSelectionEmpty:false}, {fileInputCount:2}, {composerCount:0},
    {siteIdentityVerified:false}, {originalTabVerified:false},
    {currentEpoch:6}, {tabId:12},
    {origin:"tab-forged"}, {currentConversation:"https://chatgpt.com/c/other-1234"},
    {optIn:"not-accepted"}
  ]) {
    const candidate={...proof,optIn:"attach-this-job",...variant};
    assert.equal(propose(base(),"begin_attachment",candidate).ok,false,
      "Denied: "+JSON.stringify(variant));
  }
});

test("Send requires separate consent, one exact file and empty draft",()=>{
  const proof=evidence();
  const record={...base(),deliveryState:"attachment_confirmed"};
  for(const variant of [
    {optIn:"attach-this-job"}, {optIn:undefined},
    {composerEmpty:false}, {attachmentCount:0}, {attachmentCount:2},
    {noOtherAttachments:false}, {currentEpoch:4}, {originalTabVerified:false},
    {receipt:{...proof.receipt,siteAttachmentAcknowledged:false}}
  ]) assert.equal(propose(record,"begin_send",{
    ...proof,optIn:"send-this-job",...variant
  }).ok,false,"Denied: "+JSON.stringify(variant));
});

test("ambiguous, restart and orphaned attempts cannot retry or report delivery success",()=>{
  const proof=evidence();
  const attempted={...base(),deliveryState:"send_requested"};
  const lost=propose(attempted,"origin_lost");
  assert.equal(lost.next.deliveryState,"delivery_uncertain");
  assert.equal(propose(lost.next,"begin_send",{...proof,optIn:"send-this-job"}).ok,false);
  assert.equal(propose(lost.next,"send_acknowledged",proof).ok,false);
  const restarting=propose(attempted,"reconcile_uncertain");
  assert.equal(restarting.next.deliveryState,"delivery_uncertain");
  const pending={...base(),deliveryState:"attachment_preparing"};
  assert.equal(propose(pending,"reconcile_uncertain").next.deliveryState,"delivery_uncertain");
  assert.equal(propose(base(),"origin_lost").next.deliveryState,"manual_only");
  assert.equal(propose({...base(),deliveryState:"attachment_confirmed"},"origin_lost")
    .next.deliveryState,"manual_only");
  assert.equal(propose({...base(),deliveryState:"manual_only"},"begin_attachment",proof).ok,false);
  assert.equal(propose({...base(),deliveryState:"delivery_verified"},"origin_lost").ok,false);
});

test("reject invalid, nonterminal, foreign or tampered native record identity",()=>{
  for(const variant of [
    {id:"__proto__"}, {id:"job_bad.id"}, {tabId:"11"},
    {origin:null}, {submittedAt:0},
    {state:"running"}, {state:"queued"},
    {conversation:"https://evil.invalid/c/testing-1234"},
    {conversation:"https://chatgpt.com/share/testing-1234"},
    {conversation:"https://chatgpt.com/c/testing-1234#fragment"},
    {deliveryState:"delivery_claimed"}
  ]) assert.equal(propose({...base(),...variant},
    "begin_attachment",{...evidence(),optIn:"attach-this-job"}).ok,false);
});

test("sixteen simultaneous origin keys cannot inherit the first conversation's grant",()=>{
  for(let i=0;i<16;i++){
    const id="job_"+String(i).padStart(8,"0");
    const record={...base(),id,tabId:11+i,
      origin:"tab-session-"+i,conversation:"https://chatgpt.com/c/convo-"+String(i).padStart(4,"0")};
    const own={...evidence(),jobId:id,tabId:11+i,origin:record.origin,
      conversation:record.conversation,currentConversation:record.conversation,
      optIn:"attach-this-job"};
    assert.equal(propose(record,"begin_attachment",own).ok,true);
    assert.equal(propose(record,"begin_attachment",{...own,jobId:"job_12345678"}).ok,false);
    assert.equal(propose(record,"begin_attachment",{...own,tabId:11+(i+1)%16}).ok,false);
  }
});
