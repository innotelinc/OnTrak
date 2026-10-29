import assert from "node:assert/strict";
import test from "node:test";

/**
 * Images on a turn.
 *
 * An attachment is a file a browser hands us, so the tests are about what is
 * *refused*: a mime type that is not on the list, bytes that are not the type they
 * claim, a payload larger than the ceiling, and more than one turn's worth at
 * once. A picture that got through mislabelled would be sent to a provider as a
 * format it cannot decode and fail as a gateway error, which reads as an outage
 * rather than as a bad upload.
 */
const { AttachmentError, MAX_IMAGES, contentParts, dataUrl, describeImages, parseImages, sniffImageType } = await import(
  "../attachments.js"
);

/** A real 1x1 PNG, so the signature check is exercised rather than bypassed. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG, "base64");
/** A JPEG's first three bytes, enough for the signature and nothing else. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString("base64");

test("an ordinary PNG is accepted, with its size and a display name", () => {
  const images = parseImages([{ name: "/etc/passwd", mimeType: "image/png", data: PNG }]);
  assert.equal(images.length, 1);
  const image = images[0]!;
  // A path in the name is reduced to its basename: this is a label, never a path.
  assert.equal(image.name, "passwd");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.bytes, PNG_BYTES.length);
  assert.equal(image.data, PNG_BYTES.toString("base64"));
});

test("a data URL is accepted as it is written", () => {
  const images = parseImages([{ mimeType: "image/png", data: `data:image/png;base64,${PNG}` }]);
  assert.equal(images[0]?.mimeType, "image/png");
  assert.equal(images[0]?.data, PNG_BYTES.toString("base64"));
});

test("`image/jpg` is read as JPEG rather than refused", () => {
  const images = parseImages([{ mimeType: "image/jpg", data: JPEG }]);
  assert.equal(images[0]?.mimeType, "image/jpeg");
});

test("no images is the ordinary turn, not an error", () => {
  assert.deepEqual(parseImages(undefined), []);
  assert.deepEqual(parseImages(null), []);
  assert.deepEqual(parseImages([]), []);
});

test("what an attachment must not be", async (t) => {
  await t.test("a type off the list", () => {
    assert.throws(() => parseImages([{ mimeType: "image/tiff", data: PNG }]), AttachmentError);
    assert.throws(() => parseImages([{ mimeType: "text/html", data: PNG }]), AttachmentError);
  });

  await t.test("bytes that are not the type they claim", () => {
    assert.throws(
      () => parseImages([{ mimeType: "image/png", data: JPEG }]),
      /says it is image\/png but its contents are image\/jpeg/,
    );
    assert.throws(
      () => parseImages([{ mimeType: "image/png", data: Buffer.from("<svg/>").toString("base64") }]),
      /not a PNG, JPEG, WebP or GIF/,
    );
  });

  await t.test("something that is not an image at all — an SVG is a document", () => {
    assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  });

  await t.test("an empty or malformed payload", () => {
    assert.throws(() => parseImages([{ mimeType: "image/png", data: "" }]), /carried no data/);
    assert.throws(() => parseImages([{ mimeType: "image/png", data: "not base64!!" }]), /not valid base64/);
    assert.throws(() => parseImages([{ mimeType: "image/png", data: "====" }]), /not valid base64/);
  });

  await t.test("more than one turn's worth", () => {
    const many = Array.from({ length: MAX_IMAGES + 1 }, () => ({ mimeType: "image/png", data: PNG }));
    assert.throws(() => parseImages(many), new RegExp(`at most ${MAX_IMAGES}`));
  });

  await t.test("a payload past the size ceiling, refused before it is decoded", () => {
    // The header is a PNG's, the body is padding: the size check runs first, so
    // this costs a length comparison rather than an 8 MB decode.
    const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(2_000_000)]).toString("base64");
    assert.throws(() => parseImages([{ mimeType: "image/png", data: oversized }]), /larger than/);
  });

  await t.test("a shape that is not a list of images", () => {
    assert.throws(() => parseImages({ mimeType: "image/png", data: PNG }), /must be an array/);
    assert.throws(() => parseImages(["nope"]), /is not an object/);
  });
});

test("what the gateway receives", () => {
  const images = parseImages([{ name: "shot.png", mimeType: "image/png", data: PNG }]);
  const parts = contentParts("what is wrong with this?", images);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { type: "text", text: "what is wrong with this?" });
  assert.deepEqual(parts[1], {
    type: "image_url",
    image_url: { url: `data:image/png;base64,${PNG_BYTES.toString("base64")}` },
  });
  assert.equal(dataUrl(images[0]!), (parts[1] as { image_url: { url: string } }).image_url.url);

  // An image-only turn still has an empty text part: some providers reject a
  // message made only of images.
  assert.deepEqual(contentParts("", images)[0], { type: "text", text: "" });
  assert.deepEqual(contentParts("no pictures here", []), [{ type: "text", text: "no pictures here" }]);
});

test("the transcript's one-line description of the attachments", () => {
  const images = parseImages([
    { name: "a.png", mimeType: "image/png", data: PNG },
    { name: "b.png", mimeType: "image/png", data: PNG },
  ]);
  assert.match(describeImages(images), /attached 2 images: a\.png \(1 KB\), b\.png \(1 KB\)/);
  assert.match(describeImages([images[0]!]), /^attached a\.png/);
  assert.equal(describeImages([]), "");
});
