import test from "node:test";
import assert from "node:assert/strict";
import { flattenAiOverview, parseQuestions } from "./serp-parse.js";
import { parseEnricherSpecs } from "./enrichers/pipeline.js";

test("flattenAiOverview joins text blocks and first reference", () => {
  const answer = flattenAiOverview({
    text_blocks: [
      { type: "paragraph", snippet: "Sony UX560 is a common pick." },
      {
        type: "list",
        list: [{ snippet: "Zoom H1n for portable audio." }],
      },
    ],
    references: [
      {
        title: "Wirecutter",
        link: "https://www.nytimes.com/wirecutter/reviews/the-best-voice-recorder/",
      },
    ],
  });
  assert.equal(answer?.type, "ai_overview");
  assert.match(answer?.snippet ?? "", /Sony UX560/);
  assert.match(answer?.snippet ?? "", /Zoom H1n/);
  assert.equal(answer?.title, "Wirecutter");
});

test("parseQuestions keeps AI page tokens without a snippet", () => {
  const rows = parseQuestions({
    related_questions: [
      {
        question: "Which voice recorder is best?",
        type: "ai_overview",
        page_token: "tok-1",
      },
    ],
  });
  assert.equal(rows[0]?.answer?.type, "ai_overview");
  assert.equal(rows[0]?.answer?.pageToken, "tok-1");
  assert.equal(rows[0]?.answer?.snippet, undefined);
});

test("parseEnricherSpecs defaults to meta and ai", () => {
  assert.deepEqual(parseEnricherSpecs(undefined), ["meta", "ai"]);
  assert.deepEqual(parseEnricherSpecs("ai_overview"), ["ai"]);
});
