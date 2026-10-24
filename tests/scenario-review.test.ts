/**
 * Authoring review (2.1).
 *
 * What these tests defend: an approval cannot be inherited by checks nobody read,
 * and the gate never makes a solo deployment unable to publish. The second is the
 * `ONTRAK_SCENARIO_REVIEW_REQUIRED` switch; the first is `statusAfterEdit`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publishBlocker,
  reviewBlocker,
  reviewRequired,
  reviewStatusLabel,
  statusAfterEdit,
  submitBlocker,
} from "../src/lib/review-rules";

test("review is off unless the deployment asks for it", () => {
  assert.equal(reviewRequired(undefined), false);
  assert.equal(reviewRequired(""), false);
  assert.equal(reviewRequired("0"), false);
  for (const on of ["1", "true", "YES", "on"]) assert.equal(reviewRequired(on), true, on);
});

test("a solo deployment can publish a draft and an approved scenario", () => {
  assert.equal(publishBlocker("DRAFT", false), null);
  assert.equal(publishBlocker("IN_REVIEW", false), null);
  assert.equal(publishBlocker("APPROVED", false), null);
});

test("with review on, only an approved scenario publishes", () => {
  assert.equal(publishBlocker("APPROVED", true), null);
  assert.match(publishBlocker("DRAFT", true) ?? "", /Submit it for review/);
  assert.match(publishBlocker("IN_REVIEW", true) ?? "", /still in review/);
});

test("submitting is only possible from a draft", () => {
  assert.equal(submitBlocker("DRAFT"), null);
  assert.match(submitBlocker("IN_REVIEW") ?? "", /already waiting/);
  assert.match(submitBlocker("APPROVED") ?? "", /already approved/);
});

test("the author cannot approve their own scenario", () => {
  assert.match(reviewBlocker("IN_REVIEW", "author-1", "author-1") ?? "", /cannot be approved by the person who wrote it/);
  assert.equal(reviewBlocker("IN_REVIEW", "author-1", "reviewer-2"), null);
});

test("approval requires a submitted scenario", () => {
  assert.match(reviewBlocker("DRAFT", "a", "b") ?? "", /not been submitted/);
  assert.match(reviewBlocker("APPROVED", "a", "b") ?? "", /already approved/);
});

test("a grading change invalidates an approval; a copy edit does not", () => {
  assert.equal(statusAfterEdit("APPROVED", true), "DRAFT");
  assert.equal(statusAfterEdit("APPROVED", false), "APPROVED");
  assert.equal(statusAfterEdit("IN_REVIEW", true), "IN_REVIEW");
  assert.equal(statusAfterEdit("DRAFT", true), "DRAFT");
});

test("labels read as states, not column names", () => {
  assert.equal(reviewStatusLabel("DRAFT"), "Draft");
  assert.equal(reviewStatusLabel("IN_REVIEW"), "In review");
  assert.equal(reviewStatusLabel("APPROVED"), "Approved");
});
