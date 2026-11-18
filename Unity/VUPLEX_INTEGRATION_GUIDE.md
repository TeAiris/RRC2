# RRC + Vuplex Integration Guide (Unity)

This guide maps the current web bridge in `app.js` to a production-ready Unity setup using:

- `Unity/RRCVuplexBridge.cs` (single webview bridge)
- `Unity/RRCVuplexOrchestrator.cs` (multi-webview coordinator)
- `Unity/RRCVuplexWindowSpawner.cs` (prefab-based per-window webview spawning by key)

## 1. Prerequisites

- Vuplex installed in Unity project.
- One of:
  - `CanvasWebViewPrefab` (UI canvas flow)
  - `WebViewPrefab` (world-space / 3D flow)
- RRC web app reachable by URL (local or hosted).

## 2. Web Contract (already implemented in app)

The web app listens for:

- `window.postMessage({ type: "rrcExternalControl", requestId, command, payload }, "*")`

Supported `command` values:

- `toggleWindow`
- `showWindow`
- `hideWindow`
- `clickTopButton`
- `setRhythm`
- `playNotation`
- `stopNotation`
- `setWindowsAlpha`
- `setFullscreenMapAlpha`
- `setUiAlpha`
- `getState`

The web app emits JSON events via Vuplex:

- `bridge_ready`
- `top_button_clicked`
- `window_visibility_changed`
- `command_result`

## 3. Single-Webview Setup

1. Add your Vuplex prefab to scene (`CanvasWebViewPrefab` or `WebViewPrefab`).
2. Set URL to your app.
3. Add `RRCVuplexBridge` to a GameObject.
4. Assign one prefab reference in inspector.
5. Optional inspector config:
   - `queueCommandsUntilReady`: keep command calls safe before web init.
   - `waitForBridgeReadyBeforeSending`: wait for web bridge handshake.
   - `bridgeReadyFallbackSeconds`: fail-safe flush if handshake is delayed.
   - `commandTimeoutSeconds`: request timeout diagnostics.
6. Hook UnityEvents:
   - `onBridgeReady` -> enable UI controls.
   - `onCommandResult` -> command telemetry/UI feedback.
   - `onWindowVisibilityChanged` -> sync Unity UI indicators.

## 4. Automatic Control Discovery (No Manual IDs Required)

`RRCVuplexBridge` now auto-discovers:

- top buttons (`catalog.topButtons`)
- floating windows (`catalog.windows`)

on `bridge_ready` and via `getCatalog`.

This means you can call commands using friendly names / aliases like:

- `rhythms`, `notation`, `circular`, `media`, `context`, `title`, `session`, `user`, `views`, `stage`, `settings`, `map`

without wiring IDs first.

New helpers:

- `ToggleRhythms()`
- `ToggleNotation()`
- `ToggleCircular()`
- `ToggleMedia()`
- `ToggleContext()`
- `ToggleTitle()`
- `ToggleSession()`
- `ToggleUser()`
- `ToggleViews()`
- `ToggleStage()`
- `ToggleSettings()`
- `ToggleMap()`
- `RequestCatalog()`

Also, `SendCommand(command, payload)` accepts plain string payloads now.
If payload is not JSON, it is automatically wrapped as:

`{ "value": "your-string" }`

so your existing `SendCommand(type, value)` pattern works.

Compatibility helpers:

- `SendCommandValue(type, value)`
- `ExecuteJS(js)`
- `LoadURL(url)`

## 5. Optional Inspector Mapping (Still Supported)

`RRCVuplexBridge` supports:

- `mappedWindowIds` list
  - use with `ToggleMappedWindowByIndex(int)`, `ShowMappedWindowByIndex(int)`, `HideMappedWindowByIndex(int)`
- `mappedTopButtonIds` list
  - use with `ClickMappedTopButtonByIndex(int)`
- `startupCommands` list
  - auto-send commands when `bridge_ready` is received.

Recommended `mappedTopButtonIds` examples:

- `rhythm-toggle`
- `notation-toggle`
- `media-toggle`
- `history-toggle`
- `session-toggle`
- `trigger-pad-toggle`
- `circular-toggle`
- `debug-toggle`

## 6. Multi-Canvas / Multi-Webview Setup

Use `RRCVuplexOrchestrator` when you have multiple webviews:

1. Add `RRCVuplexOrchestrator` to scene manager object.
2. Populate `bridges` list:
   - `id` (friendly name)
   - `bridge` (reference to `RRCVuplexBridge`)
   - `isPrimary` (single true preferred)
   - `includeInBroadcast` (if it should receive broadcast commands)
3. Use orchestrator methods from Unity buttons / gameplay events:
   - `ToggleWindow`, `ShowWindow`, `HideWindow`
   - `ToggleWindowByAlias`, `ClickTopButtonByAlias`
   - `ToggleRhythms`, `ToggleNotation`, `ToggleCircular`, `ToggleMedia`, `ToggleContext`, `ToggleTitle`, `ToggleSession`, `ToggleUser`, `ToggleViews`, `ToggleStage`, `ToggleSettings`, `ToggleMap`
   - `ClickTopButton`
   - `SetRhythm`
   - `PlayNotation`, `StopNotation`
   - `SendCommandToPrimary`, `BroadcastCommand`

Pattern:

- Primary webview = authoritative interaction surface.
- Secondary webviews = mirrored/auxiliary displays.

## 7. Fast Prefab Window Spawning (Recommended for Vuplex panel workflows)

Use `RRCVuplexWindowSpawner` when you want to open RRC windows by simple key names and have Unity instantiate ready-to-use webview objects automatically.

### Inspector wiring

1. Add `RRCVuplexWindowSpawner` to a manager GameObject.
2. Assign:
   - `Main Bridge` (`RRCVuplexBridge`) for your always-on main webview.
   - `Web View Window Prefab` (generic instancing prefab, must include `RRCVuplexBridge`).
   - `Window Root` (optional parent transform for spawned windows).
   - `App URL` (your full web URL, local or hosted).
3. Configure `Scale Mapping`:
   - `Use Calculated Scale` enabled:
     - window pixel width/height are converted to Unity `localScale.x/y` using `Pixel To Unity Scale`.
   - Per-window `Use Manual Scale Values`:
     - overrides calculated scale with explicit `manualLocalScale` values.

### Open/close by simple key

- `OpenWindow("notation")`
- `OpenWindow("circular")`
- `OpenWindow("media")`
- `CloseWindow("notation")`
- `DestroyWindow("notation")`

Built-in convenience methods are included:

- `OpenNotation()`, `OpenCircular()`, `OpenRhythms()`, `OpenMedia()`, `OpenContext()`, `OpenTitle()`, `OpenPads()`, `OpenSession()`, `OpenUser()`, `OpenViews()`, `OpenSettings()`

### Window key catalog

Use the component context menu:

- `Populate Default Window Keys`

This fills a default set of keys + pixel dimensions + starting local positions.  
You can tune each entry directly in inspector for prototype or production.

## 8. Command Examples

- Toggle session panel:
  - `SendCommand("toggleWindow", "{\"windowId\":\"session-panel\"}")`
- Toggle session panel (alias, no ID):
  - `SendCommand("toggleWindow", "session")`
- Load rhythm:
  - `SendCommand("setRhythm", "{\"rhythmKey\":\"toro\"}")`
- Play transport:
  - `SendCommand("playNotation", "{}")`
- Dim all window backplates (keep content readable):
  - `SendCommand("setWindowsAlpha", "{\"alpha\":0.7}")`
- Make fullscreen map translucent for Unity overlay compositing:
  - `SendCommand("setFullscreenMapAlpha", "{\"alpha\":0.45}")`
- Set both together:
  - `SendCommand("setUiAlpha", "{\"windowsAlpha\":0.7,\"mapAlpha\":0.45}")`

## 9. Operational Notes

- Command queueing prevents lost calls during startup.
- Timeout events (`onCommandTimeout`) make wiring/debug robust.
- `onRawMessage` + `onBridgeEvent` provide full telemetry for logs.
- If you hot-swap prefabs at runtime, call `RefreshBindings()`.

## 10. Recommended Unity Wiring Pattern

- Use a dedicated `RRCControlPanel` MonoBehaviour for scene logic.
- Keep only string IDs in serialized fields (`windowId`, `buttonId`, `rhythmKey`).
- Route all web calls through bridge/orchestrator methods to centralize logic.
- Use UnityEvents for no-code wiring in prototypes; move to typed scripts for production.
