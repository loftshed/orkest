# Terminal UI

`plugins/orchestrate/lib/tui-theme.mjs` owns terminal styling. The swarm uses semantic roles:
`border`, `heading`, `selected`, `muted`, `running`, `success`, `warning`, and `error`.
Default roles use the terminal's ANSI palette and inverse selection, so the swarm does not impose
its own background colour. Palette-name aliases remain available for existing command renderers.

`tui-box.mjs` handles text width, ANSI styling, frames, tables, and glyph fallbacks.
`tui-components.mjs` composes section headings, status rows, and tree cards. These components
receive display data and width; lifecycle rules and keyboard selection belong to `HordeView`.

Override roles for one view without changing other views:

```js
new HordeView(room, {
  color: true,
  theme: { border: "90", selected: "7;1", success: "32" },
});
```

`runHordeTui(load, { theme })` accepts the same overrides. Values are ANSI SGR sequences;
invalid token names and sequences are rejected. Disabling colour retains text states and glyphs.

Herdr owns terminal hosting, pane placement, focus, and lifecycle. Its plugin API does not provide
native card widgets or a documented palette-export API. Keep presentation in Orkest; do not infer
automatic synchronization with Herdr's configured theme. See the official
[plugin contract](https://herdr.dev/tui/docs/plugins/) and
[theme configuration](https://herdr.dev/tui/docs/configuration/#theme).
