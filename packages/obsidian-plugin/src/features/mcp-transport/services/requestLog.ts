/**
 * What a transport log event is made of (ADR-0029 D5). Pure helpers: they
 * read a parsed body, headers and a status, and never touch a response.
 *
 * Frozen event fields:
 *   tool call (INFO):  method, tool, argKeys, outcome, durationMs, tokenId, era
 *   request:           method, era, requestedVersion, tokenId, status,
 *                      durationMs, reason (plus tool, argKeys and
 *                      outcome "rejected" for a refused tools/call)
 *   version rejection (WARN): requested, rung, era, tokenId
 *                      (era and tokenId are absent on rung "middleware")
 */

import { PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import type { LogLevel } from "$/shared/log/logLine";
import { getHeader, type RequestHeaders } from "./middleware";

export type RequestOutcome = "ok" | "tool_error" | "inactive_tool" | "rejected";

export type VersionRung = "middleware" | "deferred" | "sdk";

export type RefusalReason =
  | "method_path"
  | "origin"
  | "auth"
  | "too_large"
  | "other";

export type RequestDescription = {
  method: string;
  tool?: string;
  argKeys?: string[];
  requestedVersion?: string;
};

export const REQUEST_EVENT = "mcp request";
export const TOOL_CALL_EVENT = "mcp tool call";
export const VERSION_REJECTED_EVENT = "mcp protocol version rejected";

/** A client-supplied identifier is cut to this many characters. */
const MAX_IDENTIFIER_CHARS = 64;

const BATCH_METHOD = "(batch)";
const UNKNOWN_METHOD = "(unparsed)";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: unknown): string | undefined {
  if (Array.isArray(value)) return bounded(value[0]);
  return typeof value === "string" && value !== ""
    ? value.slice(0, MAX_IDENTIFIER_CHARS)
    : undefined;
}

/**
 * The method, the tool and its argument key names, and the requested
 * protocol version: the `mcp-protocol-version` header, else the `_meta`
 * envelope claim, else `initialize`'s `params.protocolVersion`. Never an
 * argument value.
 */
export function describeRequest(
  parsedBody: unknown,
  headers: RequestHeaders,
): RequestDescription {
  const header = bounded(getHeader(headers, "mcp-protocol-version"));
  if (Array.isArray(parsedBody)) {
    return header === undefined
      ? { method: BATCH_METHOD }
      : { method: BATCH_METHOD, requestedVersion: header };
  }
  const method = isRecord(parsedBody) ? bounded(parsedBody.method) : undefined;
  if (method === undefined) {
    return header === undefined
      ? { method: UNKNOWN_METHOD }
      : { method: UNKNOWN_METHOD, requestedVersion: header };
  }

  const params = isRecord(parsedBody) ? parsedBody.params : undefined;
  const meta = isRecord(params) ? params._meta : undefined;
  const requestedVersion =
    header ??
    (isRecord(meta) ? bounded(meta[PROTOCOL_VERSION_META_KEY]) : undefined) ??
    (isRecord(params) ? bounded(params.protocolVersion) : undefined);

  const description: RequestDescription = { method };
  if (method === "tools/call" && isRecord(params)) {
    const tool = bounded(params.name);
    if (tool !== undefined) description.tool = tool;
    description.argKeys = argumentKeys(params.arguments);
  }
  if (requestedVersion !== undefined) {
    description.requestedVersion = requestedVersion;
  }
  return description;
}

/** The own key names of a tool's arguments, in order. Never a value. */
export function argumentKeys(args: unknown): string[] {
  return isRecord(args) ? Object.keys(args) : [];
}

export function toolCallOutcome(
  isInactive: boolean,
  result: { isError?: boolean } | undefined,
): RequestOutcome {
  if (result === undefined) return "rejected";
  if (isInactive) return "inactive_tool";
  return result.isError === true ? "tool_error" : "ok";
}

/** DEBUG below 400, INFO from 400 up: every error is visible at the default. */
export function requestLogLevel(
  status: number,
): Extract<LogLevel, "DEBUG" | "INFO"> {
  return status >= 400 ? "INFO" : "DEBUG";
}

export function refusalReason(status: number): RefusalReason {
  switch (status) {
    case 401:
      return "auth";
    case 403:
      return "origin";
    case 404:
    case 405:
      return "method_path";
    case 413:
      return "too_large";
    default:
      return "other";
  }
}
