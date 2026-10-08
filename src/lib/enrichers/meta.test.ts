import test from "node:test";
import assert from "node:assert/strict";
import { parseSiteHtml } from "./meta.js";
import { collectSiteUrls, normalizeSiteUrl, siteFor } from "./urls.js";
import type { SearchDocument } from "../../shared/phrases.js";

const html = `
<!doctype html>
<html>
  <head>
    <title>  Voice Recorder App  </title>
    <meta name="description" content="Record voice memos on your phone.">
    <meta property="og:title" content="Voice Recorder">
    <meta property="og:description" content="OG desc">
    <meta property="og:site_name" content="Acme">
    <meta property="og:image" content="https://example.com/og.png">
    <meta name="keywords" content="voice, recorder, app">
    <link rel="canonical" href="https://example.com/voice-recorder">
  </head>
  <body><main><h1>Record a voice memo</h1><h2>Export options</h2><p>Use the recorder, review the result, and export the audio file.</p></main></body>
</html>
`;

test("parseSiteHtml reads title, description, OG", () => {
  const meta = parseSiteHtml(html, "https://example.com/page");
  assert.equal(meta.title, "Voice Recorder App");
  assert.equal(meta.description, "Record voice memos on your phone.");
  assert.equal(meta.canonical, "https://example.com/voice-recorder");
  assert.equal(meta.siteName, "Acme");
  assert.equal(meta.og?.title, "Voice Recorder");
  assert.deepEqual(meta.keywords, ["voice", "recorder", "app"]);
  assert.deepEqual(meta.headings, ["Record a voice memo", "Export options"]);
  assert.match(meta.excerpt ?? "", /export the audio file/);
});

test("collectSiteUrls dedupes organics and landscape", () => {
  const doc = {
    phrases: [
      {
        phrase: "a",
        scores: { niche: 80 },
        serp: {
          organics: [
            { link: "https://Example.com/app/" },
            { link: "https://example.com/app" },
          ],
          answer: { link: "https://example.com/app#faq" },
        },
      },
      {
        phrase: "b",
        scores: { niche: 10 },
        serp: { organics: [{ link: "https://other.com/x" }] },
      },
    ],
    landscape: [
      { organics: [{ link: "https://example.com/app" }, { link: "mailto:hi@x.com" }] },
    ],
  } as unknown as SearchDocument;

  assert.deepEqual(collectSiteUrls(doc), [
    "https://example.com/app",
    "https://other.com/x",
  ]);
  assert.equal(normalizeSiteUrl("https://Example.com/App/#hash"), "https://example.com/App");
  assert.equal(
    siteFor("https://example.com/app/", {
      "https://example.com/app": {
        url: "https://example.com/app",
        title: "T",
        enricher: "meta",
        fetchedAt: "",
        ms: 1,
      },
    })?.title,
    "T"
  );
});
