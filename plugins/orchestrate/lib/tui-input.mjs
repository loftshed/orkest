import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const MOUSE_ENABLE = "\u{1B}[?1003h\u{1B}[?1006h";
export const MOUSE_DISABLE = "\u{1B}[?1006l\u{1B}[?1003l";
export const TERMINAL_INPUT_ENABLE = `${MOUSE_ENABLE}\u{1B}[?2004h`;
export const TERMINAL_INPUT_DISABLE = `\u{1B}[?2004l${MOUSE_DISABLE}`;

const ESCAPE = "\u{1B}";
const MOUSE_PREFIX = `${ESCAPE}[<`;
const PASTE_START = `${ESCAPE}[200~`;
const PASTE_END = `${ESCAPE}[201~`;
const MAX_SEQUENCE_LENGTH = 64;
const ESCAPE_TIMEOUT = 500;

function mouseEvent(sequence) {
  const match = /^(\d+);(\d+);(\d+)([Mm])$/u.exec(sequence.slice(MOUSE_PREFIX.length));
  if (!match) return null;
  const [, encoded, column, row, final] = match;
  const code = Number(encoded);
  const x = Number(column);
  const y = Number(row);
  if (![code, x, y].every(Number.isSafeInteger) || code > 255 || x < 1 || y < 1) return null;
  const baseButton = code & 3;
  if (code & 64) {
    if (baseButton > 1 || final === "m") return null;
    return {
      x,
      y,
      button: 4 + baseButton,
      action: baseButton === 0 ? "scroll-up" : "scroll-down",
    };
  }
  let action = "press";
  if (final === "m") action = "release";
  else if (code & 32) action = "move";
  else if (baseButton === 3) return null;
  return { x, y, button: (code & 128 ? 8 : 0) + baseButton, action };
}

function suffixPrefix(text, marker) {
  for (let size = Math.min(text.length, marker.length - 1); size > 0; size--) {
    if (marker.startsWith(text.slice(-size))) return text.slice(-size);
  }
  return "";
}

/** Separate mouse and paste framing before readline sees ordinary keyboard bytes. */
export function createTerminalInput({ onKey, onMouse }) {
  const keyboard = new PassThrough();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let isPasting = false;
  let isDiscardingMouse = false;
  let timer;
  let isDisposed = false;
  // Our prefix timeout already resolves a standalone Escape. Avoid waiting twice.
  emitKeypressEvents(keyboard, { escapeCodeTimeout: 0 });
  keyboard.on("keypress", (text, key) => {
    if (!isDisposed) onKey(text, key);
  });

  function parse() {
    while (pending) {
      if (isPasting) {
        const end = pending.indexOf(PASTE_END);
        if (end === -1) {
          pending = suffixPrefix(pending, PASTE_END);
          return;
        }
        pending = pending.slice(end + PASTE_END.length);
        isPasting = false;
        continue;
      }
      if (isDiscardingMouse) {
        const end = pending.search(/[@-~]/u);
        if (end < 0) {
          pending = "";
          return;
        }
        pending = pending.slice(end + 1);
        isDiscardingMouse = false;
        continue;
      }
      const escape = pending.indexOf(ESCAPE);
      if (escape !== 0) {
        const size = escape === -1 ? pending.length : escape;
        keyboard.write(pending.slice(0, size));
        pending = pending.slice(size);
        continue;
      }
      if (pending.startsWith(PASTE_START)) {
        pending = pending.slice(PASTE_START.length);
        isPasting = true;
        continue;
      }
      if (pending.startsWith(PASTE_END)) {
        pending = pending.slice(PASTE_END.length);
        continue;
      }
      if (pending.startsWith(MOUSE_PREFIX)) {
        const end = pending.slice(MOUSE_PREFIX.length).search(/[@-~]/u);
        if (end < 0) {
          if (pending.length > MAX_SEQUENCE_LENGTH) {
            pending = "";
            isDiscardingMouse = true;
          }
          return;
        }
        const size = MOUSE_PREFIX.length + end + 1;
        const event = size <= MAX_SEQUENCE_LENGTH ? mouseEvent(pending.slice(0, size)) : null;
        pending = pending.slice(size);
        if (event) onMouse(event);
        continue;
      }
      if ([MOUSE_PREFIX, PASTE_START, PASTE_END].some((prefix) => prefix.startsWith(pending)))
        return;
      // Leave escape-key timing and keyboard protocols to Node's keyboard parser.
      keyboard.write(ESCAPE);
      pending = pending.slice(1);
    }
  }

  return {
    write(chunk) {
      if (isDisposed) return;
      clearTimeout(timer);
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      parse();
      if (isPasting || !(pending || isDiscardingMouse)) {
        return;
      }

      timer = setTimeout(() => {
        if (!isDiscardingMouse && !pending.startsWith(MOUSE_PREFIX)) keyboard.write(pending);
        pending = "";
        isDiscardingMouse = false;
      }, ESCAPE_TIMEOUT);
      timer.unref();
    },
    dispose() {
      isDisposed = true;
      clearTimeout(timer);
      pending = "";
      keyboard.removeAllListeners("keypress");
      keyboard.destroy();
    },
  };
}
