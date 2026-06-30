// ABOUTME: Tests for the NDJSON line splitter across chunk boundaries.

import { test, expect } from "bun:test";
import { LineSplitter } from "./line-splitter";

test("splits complete lines and keeps the partial remainder buffered", () => {
  const s = new LineSplitter();
  expect(s.push('{"a":1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
  expect(s.push(':3}\n')).toEqual(['{"c":3}']);
});

test("reassembles a JSON object split mid-token across chunks", () => {
  const s = new LineSplitter();
  expect(s.push('{"kind":"obs')).toEqual([]);
  expect(s.push('ervation"}\n')).toEqual(['{"kind":"observation"}']);
});

test("drops empty lines but flush returns a trailing unterminated line", () => {
  const s = new LineSplitter();
  expect(s.push("\n\n")).toEqual([]);
  s.push("tail-no-newline");
  expect(s.flush()).toEqual(["tail-no-newline"]);
  expect(s.flush()).toEqual([]);
});
