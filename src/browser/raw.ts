import type { JsonObject, SessionId } from "../shared/types.js";

// Raw CDP escape hatch

export interface RawOptions {
  provider: { raw?(input: { sessionId: SessionId; method: string; params?: JsonObject }): Promise<unknown> };
  sessionId: SessionId;
  method: string;
  params?: JsonObject;
}

export type MouseButton = "left" | "middle" | "right" | "none";

export interface DispatchMouseEventOptions {
  provider: RawOptions["provider"]; sessionId: SessionId;
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel"; x: number; y: number;
  button?: MouseButton;
  buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number;
}

export interface ClickAtOptions {
  provider: RawOptions["provider"]; sessionId: SessionId; x: number; y: number;
  button?: Exclude<MouseButton, "none">; clickCount?: number; modifiers?: number;
}

/**
 * Send a raw CDP command to the browser session.
 *
 * This is the escape hatch for when the standard bridge affordances
 * (observe, exec) are insufficient. Throws if the provider does not
 * support raw access.
 */
export async function execRaw(options: RawOptions): Promise<unknown> {
  if (!options.provider.raw) {
    throw new Error("Provider does not support raw CDP access");
  }

  const input: { sessionId: SessionId; method: string; params?: JsonObject } = {
    sessionId: options.sessionId,
    method: options.method,
  };

  if (options.params) {
    input.params = options.params;
  }

  return options.provider.raw(input);
}

/**
 * Dispatch compositor-level mouse input at viewport coordinates.
 */
export async function dispatchMouseEvent(options: DispatchMouseEventOptions): Promise<unknown> {
  const params: JsonObject = { type: options.type, x: options.x, y: options.y };
  if (options.button) params.button = options.button;
  if (options.buttons !== undefined) params.buttons = options.buttons;
  if (options.clickCount !== undefined) params.clickCount = options.clickCount;
  if (options.deltaX !== undefined) params.deltaX = options.deltaX;
  if (options.deltaY !== undefined) params.deltaY = options.deltaY;
  if (options.modifiers !== undefined) params.modifiers = options.modifiers;

  return execRaw({ provider: options.provider, sessionId: options.sessionId, method: "Input.dispatchMouseEvent", params });
}

/**
 * Click at viewport coordinates through Chrome's compositor input path.
 */
export async function clickAt(options: ClickAtOptions): Promise<void> {
  const button = options.button ?? "left";
  const clickCount = options.clickCount ?? 1;
  const buttons = buttonToButtons(button);
  const base: Omit<DispatchMouseEventOptions, "type"> = {
    provider: options.provider, sessionId: options.sessionId, x: options.x, y: options.y,
  };
  if (options.modifiers !== undefined) base.modifiers = options.modifiers;

  await dispatchMouseEvent({ ...base, type: "mouseMoved", button: "none" });
  await dispatchMouseEvent({ ...base, type: "mousePressed", button, buttons, clickCount });
  await dispatchMouseEvent({ ...base, type: "mouseReleased", button, buttons: 0, clickCount });
}

function buttonToButtons(button: Exclude<MouseButton, "none">): number {
  if (button === "right") return 2;
  if (button === "middle") return 4;
  return 1;
}
