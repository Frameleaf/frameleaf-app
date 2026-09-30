import assert from "node:assert/strict";
import test from "node:test";
import * as sdk from "../build/index.js";

test("Live Photo commit transports only the explicit resource pair and retains both verified result hashes", async () => {
  const dto = {
    stillResourceId: "11111111-1111-4111-8111-111111111111",
    videoResourceId: "22222222-2222-4222-8222-222222222222",
  };
  const pair = {
    still: { id: "still-asset", status: "created", sha256: "a".repeat(64) },
    video: { id: "video-asset", status: "created", sha256: "b".repeat(64) },
  };
  const received = await sdk.commitLivePhotoUpload(
    { livePhotoUploadCommitDto: dto },
    {
      fetch: async (url, options) => {
        assert.equal(url, "/api/assets/uploads/live-photo/commit");
        assert.equal(options.method, "POST");
        assert.deepEqual(JSON.parse(options.body), dto);
        return new Response(JSON.stringify(pair), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.deepEqual(received, pair);
  assert.equal(
    await sdk.commitLivePhotoUpload(
      { livePhotoUploadCommitDto: dto },
      { fetch: async () => new Response(null, { status: 202 }) },
    ),
    "",
  );
});
