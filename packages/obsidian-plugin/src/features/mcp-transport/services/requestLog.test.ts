import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import {
  REQUEST_EVENT,
  TOOL_CALL_EVENT,
  VERSION_REJECTED_EVENT,
  argumentKeys,
  describeRequest,
  refusalReason,
  requestLogLevel,
  toolCallOutcome,
} from "./requestLog";

const NO_HEADERS = {};

describe("event names", () => {
  test("the frozen event messages", () => {
    expect(REQUEST_EVENT).toBe("mcp request");
    expect(TOOL_CALL_EVENT).toBe("mcp tool call");
    expect(VERSION_REJECTED_EVENT).toBe("mcp protocol version rejected");
  });
});

describe("describeRequest — tools/call (R-07, R-05)", () => {
  test("gives the tool name and its argument key names in order, never a value", () => {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "read_note",
        arguments: { path: "private/diary.md", mode: "full", limit: 12 },
      },
    };
    const d = describeRequest(body, NO_HEADERS);
    expect(d.method).toBe("tools/call");
    expect(d.tool).toBe("read_note");
    expect(d.argKeys).toEqual(["path", "mode", "limit"]);
    const serialised = JSON.stringify(d);
    expect(serialised).not.toContain("private/diary.md");
    expect(serialised).not.toContain("full");
  });

  test("a tools/call without arguments has no key names", () => {
    const d = describeRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_server_info" },
      },
      NO_HEADERS,
    );
    expect(d.tool).toBe("get_server_info");
    expect(d.argKeys ?? []).toEqual([]);
  });

  test("a method that is not tools/call carries no tool or key names", () => {
    const d = describeRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      NO_HEADERS,
    );
    expect(d.method).toBe("tools/list");
    expect(d.tool).toBeUndefined();
    expect(d.argKeys).toBeUndefined();
  });
});

describe("describeRequest — requested protocol version (R-08)", () => {
  test("initialize takes requestedVersion from params.protocolVersion", () => {
    const d = describeRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {} },
      },
      NO_HEADERS,
    );
    expect(d.method).toBe("initialize");
    expect(d.requestedVersion).toBe("2025-11-25");
  });

  test("the header wins over the _meta claim, which wins over params.protocolVersion", () => {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" },
      },
    };
    expect(
      describeRequest(body, { "mcp-protocol-version": "2025-06-18" })
        .requestedVersion,
    ).toBe("2025-06-18");
    expect(describeRequest(body, NO_HEADERS).requestedVersion).toBe(
      "2026-07-28",
    );
    const withoutMeta = {
      ...body,
      params: { protocolVersion: "2024-11-05" },
    };
    expect(describeRequest(withoutMeta, NO_HEADERS).requestedVersion).toBe(
      "2024-11-05",
    );
  });

  test("a request that names no version has no requestedVersion", () => {
    const d = describeRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      NO_HEADERS,
    );
    expect(d.requestedVersion).toBeUndefined();
  });

  test("each source is truncated to 64 characters", () => {
    const long = "v".repeat(100);
    const fromHeader = describeRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { "mcp-protocol-version": long },
    );
    expect(fromHeader.requestedVersion).toBe("v".repeat(64));

    const fromMeta = describeRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { [PROTOCOL_VERSION_META_KEY]: long } },
      },
      NO_HEADERS,
    );
    expect(fromMeta.requestedVersion).toBe("v".repeat(64));

    const fromParams = describeRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: long },
      },
      NO_HEADERS,
    );
    expect(fromParams.requestedVersion).toBe("v".repeat(64));
  });
});

describe("describeRequest — bodies with no single method", () => {
  test("a batch gives a placeholder method and no tool", () => {
    const d = describeRequest(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_note", arguments: { path: "a.md" } },
        },
      ],
      NO_HEADERS,
    );
    expect(typeof d.method).toBe("string");
    expect(d.method.length).toBeGreaterThan(0);
    expect(d.method).not.toBe("tools/call");
    expect(d.tool).toBeUndefined();
  });

  test("an unparseable body (undefined) gives a placeholder method and no tool", () => {
    const d = describeRequest(undefined, NO_HEADERS);
    expect(typeof d.method).toBe("string");
    expect(d.method.length).toBeGreaterThan(0);
    expect(d.tool).toBeUndefined();
  });

  test("a body that is not a JSON-RPC object also gives a placeholder", () => {
    for (const body of [null, 42, "tools/call", {}]) {
      const d = describeRequest(body, NO_HEADERS);
      expect(typeof d.method).toBe("string");
      expect(d.method.length).toBeGreaterThan(0);
    }
  });
});

describe("argumentKeys (R-05)", () => {
  test("returns the own key names in order", () => {
    expect(argumentKeys({ b: 1, a: "value", c: { nested: true } })).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  test("absent or non-object arguments have no keys", () => {
    expect(argumentKeys(undefined)).toEqual([]);
    expect(argumentKeys(null)).toEqual([]);
    expect(argumentKeys("text")).toEqual([]);
    expect(argumentKeys(7)).toEqual([]);
  });
});

describe("toolCallOutcome (R-07)", () => {
  test("the full matrix", () => {
    expect(toolCallOutcome(false, { isError: false })).toBe("ok");
    expect(toolCallOutcome(false, {})).toBe("ok");
    expect(toolCallOutcome(false, { isError: true })).toBe("tool_error");
    expect(toolCallOutcome(true, { isError: true })).toBe("inactive_tool");
    expect(toolCallOutcome(true, {})).toBe("inactive_tool");
    expect(toolCallOutcome(false, undefined)).toBe("rejected");
    expect(toolCallOutcome(true, undefined)).toBe("rejected");
  });
});

describe("requestLogLevel (R-07)", () => {
  test("below 400 is DEBUG, 400 and above is INFO", () => {
    expect(requestLogLevel(200)).toBe("DEBUG");
    expect(requestLogLevel(399)).toBe("DEBUG");
    expect(requestLogLevel(400)).toBe("INFO");
    expect(requestLogLevel(401)).toBe("INFO");
    expect(requestLogLevel(500)).toBe("INFO");
  });
});

describe("refusalReason", () => {
  test("maps each refusal status to its reason", () => {
    expect(refusalReason(401)).toBe("auth");
    expect(refusalReason(403)).toBe("origin");
    expect(refusalReason(404)).toBe("method_path");
    expect(refusalReason(405)).toBe("method_path");
    expect(refusalReason(413)).toBe("too_large");
  });

  test("any other status is `other`", () => {
    expect(refusalReason(418)).toBe("other");
    expect(refusalReason(500)).toBe("other");
  });
});
