import test from "node:test";
import assert from "node:assert/strict";
import { classifyPhrase } from "./classify.js";

test("skips local, urls, and brand noise", () => {
  assert.equal(classifyPhrase("voice recorder near me").role, "skip");
  assert.equal(classifyPhrase("https://online-voice-recorder.com/").role, "skip");
  assert.equal(classifyPhrase("voice recorder apk").role, "skip");
});

test("blacklisted words skip", () => {
  assert.equal(classifyPhrase("voice recorder app", ["app"]).reason, "blacklisted word");
  assert.notEqual(
    classifyPhrase("apple voice recorder", ["app"]).reason,
    "blacklisted word"
  );
});

test("questions are write, legal is faq", () => {
  assert.equal(classifyPhrase("is there a voice recorder on my phone?").role, "write");
  assert.equal(classifyPhrase("can someone record your voice without you knowing?").role, "faq");
  assert.equal(classifyPhrase("voice recorder app android").role, "write");
});
