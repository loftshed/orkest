import { afterEach, expect, it, vi } from "vitest";

import { createTerminalInput } from "../../../plugins/orchestrate/lib/tui-input.mjs";

const inputs = [];
afterEach(() => {
  for (const input of inputs.splice(0)) input.dispose();
  vi.useRealTimers();
});

function fixture() {
  const keys = [];
  const mouse = [];
  const input = createTerminalInput({
    onKey: (text, key) => {
      keys.push({ text, name: key.name, ctrl: key.ctrl });
    },
    onMouse: (event) => {
      mouse.push(event);
    },
  });
  inputs.push(input);
  return { input, keys, mouse };
}

it("separates clicks from combined keyboard input without activating releases twice", () => {
  const { input, keys, mouse } = fixture();
  input.write("q\u{1B}[<0;12;8M\u{1B}[<0;12;8m\u{1B}[A\u{3}");
  expect(mouse).toEqual([
    { x: 12, y: 8, button: 0, action: "press" },
    { x: 12, y: 8, button: 0, action: "release" },
  ]);
  expect(keys).toEqual([
    { text: "q", name: "q", ctrl: false },
    { text: undefined, name: "up", ctrl: false },
    { text: "\u{3}", name: "c", ctrl: true },
  ]);
});

it("accepts reports fragmented at every byte boundary", () => {
  const { input, keys, mouse } = fixture();
  for (const byte of Buffer.from("\u{1B}[<0;1200;800M")) input.write(Buffer.from([byte]));
  input.write("o");
  expect(mouse).toEqual([{ x: 1200, y: 800, button: 0, action: "press" }]);
  expect(keys).toEqual([{ text: "o", name: "o", ctrl: false }]);
});

it("decodes modifier clicks, drags and vertical wheel events", () => {
  const { input, mouse } = fixture();
  input.write("\u{1B}[<20;3;4M\u{1B}[<32;4;5M\u{1B}[<35;5;6M\u{1B}[<64;6;7M\u{1B}[<65;6;7M");
  expect(mouse).toEqual([
    { x: 3, y: 4, button: 0, action: "press" },
    { x: 4, y: 5, button: 0, action: "move" },
    { x: 5, y: 6, button: 3, action: "move" },
    { x: 6, y: 7, button: 4, action: "scroll-up" },
    { x: 6, y: 7, button: 5, action: "scroll-down" },
  ]);
});

it("keeps fragmented arrow sequences in the keyboard parser", () => {
  const { input, keys } = fixture();
  for (const byte of Buffer.from("\u{1B}[A\u{1B}[B")) input.write(Buffer.from([byte]));
  expect(keys).toEqual([
    { text: undefined, name: "up", ctrl: false },
    { text: undefined, name: "down", ctrl: false },
  ]);
});

it("suppresses fragmented bracketed paste including shortcuts and mouse-shaped text", () => {
  const { input, keys, mouse } = fixture();
  for (const chunk of ["\u{1B}[2", "00~q\u{3}\u{1B}[<0;2;3M", "o\n\u{1B}[20", "1~g"]) {
    input.write(chunk);
  }
  expect(keys).toEqual([{ text: "g", name: "g", ctrl: false }]);
  expect(mouse).toEqual([]);
});

it("does not interpret large pasted payloads as keyboard controls", () => {
  const { input, keys } = fixture();
  input.write("\u{1B}[200~");
  input.write("q".repeat(100_000));
  input.write("\u{1B}[201~p");
  expect(keys).toEqual([{ text: "p", name: "p", ctrl: false }]);
});

it("discards malformed, unsafe and overlong reports before accepting another key", () => {
  const { input, keys, mouse } = fixture();
  input.write("\u{1B}[<0;0;2M\u{1B}[<0;2;9007199254740992M\u{1B}[<0;2;3q");
  input.write(`\u{1B}[<${"9".repeat(1000)}`);
  input.write(";2;3Mq\u{1B}[<2;5;6M");
  expect(keys).toEqual([{ text: "q", name: "q", ctrl: false }]);
  expect(mouse).toEqual([{ x: 5, y: 6, button: 2, action: "press" }]);
});

it("preserves UTF-8 keyboard input split inside a multibyte character", () => {
  const { input, keys } = fixture();
  const bytes = Buffer.from("é");
  input.write(bytes.subarray(0, 1));
  input.write(bytes.subarray(1));
  expect(keys).toEqual([{ text: "é", name: undefined, ctrl: false }]);
});

it("recovers from an abandoned overlong mouse report after the framing timeout", async () => {
  vi.useFakeTimers();
  const { input, keys, mouse } = fixture();
  input.write(`\u{1B}[<${"9".repeat(1000)}`);
  await vi.advanceTimersByTimeAsync(500);
  input.write("q\u{1B}[<0;2;3M");
  expect(keys).toEqual([{ text: "q", name: "q", ctrl: false }]);
  expect(mouse).toEqual([{ x: 2, y: 3, button: 0, action: "press" }]);
});

it("lets a standalone Escape reach readline after the protocol-prefix timeout", async () => {
  const { input, keys } = fixture();
  input.write("\u{1B}");
  await vi.waitFor(() => {
    expect(keys).toEqual([{ text: undefined, name: "escape", ctrl: false }]);
  });
});

it("stops delivering input and clears incomplete framing on disposal", async () => {
  vi.useFakeTimers();
  const { input, keys, mouse } = fixture();
  input.write("o");
  input.write("\u{1B}[");
  input.dispose();
  input.write("q\u{1B}[<0;2;3M");
  await vi.advanceTimersByTimeAsync(1100);
  expect(keys).toEqual([{ text: "o", name: "o", ctrl: false }]);
  expect(mouse).toEqual([]);
});
