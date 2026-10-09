import test from "node:test";
import assert from "node:assert/strict";
import { collectRankingLeaves, rankingKind } from "./ranking.js";
import type { SearchDocument } from "./phrases.js";

test("classifies social and app store hosts", () => {
  assert.deepEqual(rankingKind("https://www.reddit.com/r/recording/foo"), {
    kind: "social",
    network: "reddit",
  });
  assert.deepEqual(rankingKind("https://www.facebook.com/groups/x"), {
    kind: "social",
    network: "facebook",
  });
  assert.deepEqual(rankingKind("https://play.google.com/store/apps/details?id=a"), {
    kind: "apps",
    network: "play",
  });
  assert.deepEqual(rankingKind("https://apps.microsoft.com/detail/x"), {
    kind: "apps",
    network: "microsoft",
  });
  assert.equal(rankingKind("https://weloty.com/best-voice-recorder/"), null);
});

test("collects unique social and app leaves from organics", () => {
  const doc = {
    phrases: [
      {
        phrase: "best voice recorder",
        sources: ["seed"],
        seeds: ["voice recorder"],
        scores: {
          niche: 40,
          wordCount: 3,
          isQuestion: false,
          relevance: null,
          sourceCount: 1,
        },
        addedAt: "",
        serp: {
          engine: "google",
          searchId: "1",
          organics: [
            {
              position: 2,
              title: "Looking for a recorder",
              link: "https://www.reddit.com/r/recording/comments/1",
              snippet: "Zoom H1n",
              source: "Reddit",
              date: "2 days ago",
            },
            {
              position: 3,
              title: "Voice Recorder",
              link: "https://play.google.com/store/apps/details?id=x",
              source: "Google Play",
            },
            {
              position: 1,
              title: "Wirecutter",
              link: "https://www.nytimes.com/wirecutter/reviews/the-best-voice-recorder/",
            },
          ],
        },
      },
    ],
    landscape: [],
  } as unknown as SearchDocument;
  const leaves = collectRankingLeaves(doc);
  assert.equal(leaves.social.length, 1);
  assert.equal(leaves.social[0].network, "reddit");
  assert.equal(leaves.social[0].host, "reddit.com");
  assert.equal(leaves.social[0].position, 2);
  assert.equal(leaves.social[0].date, "2 days ago");
  assert.deepEqual(leaves.social[0].phrases, ["best voice recorder"]);
  assert.equal(leaves.apps.length, 1);
  assert.equal(leaves.apps[0].network, "play");
});
