"use strict";
// Committed tests for the backend pure helpers (no network, no database).
// Run with: npm test
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.MONGO_URI = "";
process.env.NODE_ENV = "test";
require("net").Server.prototype.listen = function () { return this; };
const h = require("../server.js");

describe("validatePipeline", () => {
  it("accepts a read-only aggregation", () => {
    const r = h.validatePipeline(
      '[{"$match":{"total":{"$gte":1}}},{"$group":{"_id":null,"n":{"$sum":1}}}]'
    );
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.pipeline.length, 2);
  });

  it("rejects write and introspection stages", () => {
    for (const bad of [
      '[{"$out":"x"}]',
      '[{"$merge":{"into":"x"}}]',
      '[{"$match":{"a":{"$where":"true"}}}]',
      '[{"$limit":5},{"$lookup":{"from":"x"}}]',
    ]) {
      assert.ok(h.validatePipeline(bad).error, bad);
    }
  });

  it("rejects non-arrays, empty, and oversized pipelines", () => {
    assert.ok(h.validatePipeline('{"$match":{}}').error);
    assert.ok(h.validatePipeline("[]").error);
    assert.ok(h.validatePipeline("not json").error);
    const big = "[" + new Array(10).fill('{"$limit":1}').join(",") + "]";
    assert.ok(h.validatePipeline(big).error);
  });

  it("revives $date wrappers so ranges match Date fields", () => {
    // The exact shape from the failing 2021 question.
    const args =
      '{"pipeline":"[{\\"$match\\":{\\"receiptDate\\":{\\"$gte\\":{\\"$date\\":\\"2021-01-01T00:00:00Z\\"},\\"$lte\\":{\\"$date\\":\\"2021-12-31T23:59:59Z\\"}}}},{\\"$group\\":{\\"_id\\":null,\\"totalSum\\":{\\"$sum\\":\\"$total\\"}}}]"}';
    const r = h.validatePipeline(args);
    assert.ok(!r.error, r.error);
    const gte = r.pipeline[0].$match.receiptDate.$gte;
    const lte = r.pipeline[0].$match.receiptDate.$lte;
    assert.ok(gte instanceof Date, "gte revived to Date");
    assert.ok(lte instanceof Date, "lte revived to Date");
    // The stored Lowe's receipt (2021-05-11) must fall inside the range.
    const doc = new Date("2021-05-11T07:00:00.000Z");
    assert.ok(doc >= gte && doc <= lte, "doc matches range");
  });

  it("unwraps object-wrapped and double-encoded pipelines", () => {
    const inner = '[{"$group":{"_id":null,"n":{"$sum":1}}}]';
    const wrapped = h.validatePipeline(JSON.stringify({ pipeline: inner }));
    assert.ok(!wrapped.error, wrapped.error);
    assert.strictEqual(wrapped.pipeline.length, 1);
    const direct = h.validatePipeline(JSON.stringify({ pipeline: JSON.parse(inner) }));
    assert.ok(!direct.error, direct.error);
    const fenced = h.validatePipeline("```json\n" + inner + "\n```");
    assert.ok(!fenced.error, fenced.error);
  });
});

describe("parseReceiptDate", () => {
  it("parses ISO dates and rejects garbage", () => {
    const d = h.parseReceiptDate("2026-05-12");
    assert.ok(d instanceof Date);
    assert.strictEqual(d.toISOString().slice(0, 10), "2026-05-12");
    assert.strictEqual(h.parseReceiptDate("not a date"), null);
    assert.strictEqual(h.parseReceiptDate(""), null);
    assert.strictEqual(h.parseReceiptDate(null), null);
  });
});

describe("coerceResult items", () => {
  it("keeps valid lines, drops bad prices, empties on invalid", () => {
    const r = h.coerceResult({
      is_receipt: true, merchant: "S", date: "d", total: 4.49, reason: "",
      items: [
        { label: "Milk", price: 2.99 },
        { label: "Bad", price: "x" },
        { label: "Neg", price: -1 },
        null,
      ],
    });
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].label, "Milk");
    const inv = h.coerceResult({ is_receipt: false, total: null, items: [{ label: "X", price: 1 }] });
    assert.deepStrictEqual(inv.items, []);
  });
});
