using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.Events;
using Vuplex.WebView;

// Production-ready Unity <-> RRC bridge for Vuplex.
// Supports both CanvasWebViewPrefab and WebViewPrefab, inspector-mapped commands,
// structured UnityEvents, request queueing, and command timeout diagnostics.
[DisallowMultipleComponent]
public class RRCVuplexBridge : MonoBehaviour {

    [Serializable]
    public class StringEvent : UnityEvent<string> { }

    [Serializable]
    public class BridgeEventUnityEvent : UnityEvent<string, string> { } // eventName, rawJson

    [Serializable]
    public class TopButtonUnityEvent : UnityEvent<string, string> { } // buttonId, label

    [Serializable]
    public class WindowVisibilityUnityEvent : UnityEvent<string, bool> { } // windowId, visible

    [Serializable]
    public class CommandResultUnityEvent : UnityEvent<string, string, bool, string> { } // requestId, command, ok, error

    [Serializable]
    public class CatalogUpdatedUnityEvent : UnityEvent<int, int> { } // topButtons, windows

    [Serializable]
    public class StartupCommand {
        public bool enabled = true;
        public bool sendOnBridgeReady = true;
        public string command = "getState";
        [TextArea(1, 4)]
        public string payloadJson = "{}";
    }

    [Serializable]
    private class BridgePacket {
        public string source;
        public string @event;
        public BridgePayload payload;
        public long ts;
    }

    [Serializable]
    private class BridgePayload {
        public string requestId;
        public string command;
        public string buttonId;
        public string label;
        public string windowId;
        public bool visible;
        public string[] topButtons;
        public BridgeCatalog catalog;
        public BridgeResult result;
    }

    [Serializable]
    private class BridgeResult {
        public bool ok;
        public string error;
        public BridgeCatalog catalog;
        public BridgeState state;
    }

    [Serializable]
    private class BridgeState {
        public BridgeCatalog catalog;
    }

    [Serializable]
    private class BridgeCatalog {
        public BridgeCatalogButton[] topButtons;
        public BridgeCatalogWindow[] windows;
    }

    [Serializable]
    private class BridgeCatalogButton {
        public string id;
        public string label;
        public string key;
        public bool visible;
    }

    [Serializable]
    private class BridgeCatalogWindow {
        public string id;
        public string key;
        public string label;
        public bool visible;
        public string toggleButtonId;
    }

    private struct PendingCommand {
        public string command;
        public float sentAt;
    }

    private struct QueuedCommand {
        public string requestId;
        public string command;
        public string payloadJson;
    }

    [Header("Vuplex References")]
    [SerializeField] private CanvasWebViewPrefab canvasWebViewPrefab;
    [SerializeField] private WebViewPrefab webViewPrefab;

    [Header("Bridge Behavior")]
    [SerializeField] private bool queueCommandsUntilReady = true;
    [SerializeField] private bool waitForBridgeReadyBeforeSending = true;
    [SerializeField] private bool requestStateWhenBridgeReady = true;
    [SerializeField] private bool requestCatalogWhenBridgeReady = true;
    [SerializeField] private float bridgeReadyFallbackSeconds = 8f;
    [SerializeField] private float commandTimeoutSeconds = 12f;
    [SerializeField] private string requestIdPrefix = "unity";
    [SerializeField] private bool verboseLogs = true;

    [Header("Inspector Mappings")]
    [SerializeField] private List<string> mappedWindowIds = new List<string>();
    [SerializeField] private List<string> mappedTopButtonIds = new List<string>();
    [SerializeField] private List<StartupCommand> startupCommands = new List<StartupCommand>();

    [Header("Unity Events")]
    public UnityEvent onWebViewReady = new UnityEvent();
    public UnityEvent onBridgeReady = new UnityEvent();
    public StringEvent onRawMessage = new StringEvent();
    public BridgeEventUnityEvent onBridgeEvent = new BridgeEventUnityEvent();
    public TopButtonUnityEvent onTopButtonClicked = new TopButtonUnityEvent();
    public WindowVisibilityUnityEvent onWindowVisibilityChanged = new WindowVisibilityUnityEvent();
    public CommandResultUnityEvent onCommandResult = new CommandResultUnityEvent();
    public CommandResultUnityEvent onCommandTimeout = new CommandResultUnityEvent();
    public CatalogUpdatedUnityEvent onCatalogUpdated = new CatalogUpdatedUnityEvent();

    public bool IsWebViewReady => _webViewReady;
    public bool IsBridgeReady => _bridgeReady;
    public int PendingCommandCount => _pendingCommands.Count;
    public int QueuedCommandCount => _queuedCommands.Count;
    public IReadOnlyList<string> AutoTopButtonIds => _autoTopButtonIds;
    public IReadOnlyList<string> AutoWindowIds => _autoWindowIds;

    private IWebView _webView;
    private bool _webViewReady;
    private bool _bridgeReady;
    private bool _canvasSubscribed;
    private bool _webSubscribed;
    private int _requestCounter;
    private float _webViewReadyAt;

    private readonly Dictionary<string, PendingCommand> _pendingCommands = new Dictionary<string, PendingCommand>();
    private readonly Queue<QueuedCommand> _queuedCommands = new Queue<QueuedCommand>();
    private readonly List<string> _autoTopButtonIds = new List<string>();
    private readonly List<string> _autoWindowIds = new List<string>();
    private readonly Dictionary<string, string> _topButtonAliases = new Dictionary<string, string>();
    private readonly Dictionary<string, string> _windowAliases = new Dictionary<string, string>();

    private void Awake() {
        if (_topButtonAliases.Count == 0 && _windowAliases.Count == 0) {
            SeedDefaultAliases();
        }
        SubscribeToPrefabInitEvents();
        TryBindAlreadyInitializedWebView();
    }

    private void OnEnable() {
        SubscribeToPrefabInitEvents();
        TryBindAlreadyInitializedWebView();
    }

    private void Update() {
        ProcessBridgeReadyFallback();
        ProcessTimedOutCommands();
    }

    private void OnDestroy() {
        UnsubscribeFromPrefabInitEvents();
        UnbindWebView();
    }

    public void RefreshBindings() {
        SubscribeToPrefabInitEvents();
        TryBindAlreadyInitializedWebView();
    }

    public void SetCanvasWebViewPrefab(CanvasWebViewPrefab prefab) {
        if (canvasWebViewPrefab == prefab) return;
        if (_canvasSubscribed && canvasWebViewPrefab != null) {
            canvasWebViewPrefab.WebViewInitialized -= HandleAnyWebViewInitialized;
            _canvasSubscribed = false;
        }
        canvasWebViewPrefab = prefab;
        SubscribeToPrefabInitEvents();
        TryBindAlreadyInitializedWebView();
    }

    public void SetWebViewPrefab(WebViewPrefab prefab) {
        if (webViewPrefab == prefab) return;
        if (_webSubscribed && webViewPrefab != null) {
            webViewPrefab.WebViewInitialized -= HandleAnyWebViewInitialized;
            _webSubscribed = false;
        }
        webViewPrefab = prefab;
        SubscribeToPrefabInitEvents();
        TryBindAlreadyInitializedWebView();
    }

    public string SendCommand(string command, string payloadJson = "{}") {
        var normalizedPayload = NormalizePayloadJson(payloadJson);
        if (string.IsNullOrWhiteSpace(command)) {
            if (verboseLogs) Debug.LogWarning("RRCVuplexBridge: Command ignored (empty command).");
            return string.Empty;
        }

        var requestId = NextRequestId();
        var queued = new QueuedCommand {
            requestId = requestId,
            command = command.Trim(),
            payloadJson = normalizedPayload
        };

        if (ShouldQueueCommands()) {
            _queuedCommands.Enqueue(queued);
            if (verboseLogs) {
                Debug.Log($"RRCVuplexBridge: Queued command {queued.command} ({requestId}).");
            }
            return requestId;
        }

        DispatchCommand(queued);
        return requestId;
    }

    // Compatibility helper with the simple "type + value" calling style.
    public string SendCommandValue(string type, string value) {
        return SendCommand(type, value);
    }

    public void LoadURL(string url) {
        if (!_webViewReady || _webView == null) return;
        if (string.IsNullOrWhiteSpace(url)) return;
        _webView.LoadUrl(url.Trim());
    }

    public void ExecuteJS(string javascript) {
        if (!_webViewReady || _webView == null) return;
        if (string.IsNullOrWhiteSpace(javascript)) return;
        _webView.ExecuteJavaScript(javascript);
    }

    public void SendStartupCommandsNow() {
        if (startupCommands == null || startupCommands.Count == 0) return;
        for (int i = 0; i < startupCommands.Count; i++) {
            var entry = startupCommands[i];
            if (entry == null || !entry.enabled) continue;
            SendCommand(entry.command, entry.payloadJson);
        }
    }

    public void FlushQueuedCommands() {
        if (_queuedCommands.Count == 0) return;
        if (!_webViewReady || _webView == null) return;
        if (waitForBridgeReadyBeforeSending && !_bridgeReady) return;

        while (_queuedCommands.Count > 0) {
            var next = _queuedCommands.Dequeue();
            DispatchCommand(next);
        }
    }

    public void ToggleWindow(string windowIdOrAlias) {
        var resolvedWindowId = ResolveWindowId(windowIdOrAlias);
        if (!string.IsNullOrEmpty(resolvedWindowId)) {
            SendCommand("toggleWindow", BuildStringPayload("windowId", resolvedWindowId));
            return;
        }
        var resolvedTopButtonId = ResolveTopButtonId(windowIdOrAlias);
        if (!string.IsNullOrEmpty(resolvedTopButtonId)) {
            ClickTopButton(resolvedTopButtonId);
            return;
        }
        SendCommand("toggleWindow", BuildStringPayload("value", windowIdOrAlias));
    }

    public void ShowWindow(string windowIdOrAlias) {
        var resolvedWindowId = ResolveWindowId(windowIdOrAlias);
        if (!string.IsNullOrEmpty(resolvedWindowId)) {
            SendCommand("showWindow", BuildStringPayload("windowId", resolvedWindowId));
            return;
        }
        var resolvedTopButtonId = ResolveTopButtonId(windowIdOrAlias);
        if (!string.IsNullOrEmpty(resolvedTopButtonId)) {
            ClickTopButton(resolvedTopButtonId);
            return;
        }
        SendCommand("showWindow", BuildStringPayload("value", windowIdOrAlias));
    }

    public void HideWindow(string windowIdOrAlias) {
        var resolvedWindowId = ResolveWindowId(windowIdOrAlias);
        if (!string.IsNullOrEmpty(resolvedWindowId)) {
            SendCommand("hideWindow", BuildStringPayload("windowId", resolvedWindowId));
            return;
        }
        SendCommand("hideWindow", BuildStringPayload("value", windowIdOrAlias));
    }

    public void ClickTopButton(string buttonIdOrAlias) {
        var resolvedTopButtonId = ResolveTopButtonId(buttonIdOrAlias);
        if (!string.IsNullOrEmpty(resolvedTopButtonId)) {
            SendCommand("clickTopButton", BuildStringPayload("buttonId", resolvedTopButtonId));
            return;
        }
        SendCommand("clickTopButton", BuildStringPayload("value", buttonIdOrAlias));
    }

    public void SetRhythm(string rhythmKey) {
        SendCommand("setRhythm", BuildStringPayload("rhythmKey", rhythmKey));
    }

    public void PlayNotation() {
        SendCommand("playNotation", "{}");
    }

    public void StopNotation() {
        SendCommand("stopNotation", "{}");
    }

    public void SetWindowsAlpha(float alpha) {
        SendCommand("setWindowsAlpha", BuildFloatPayload("alpha", Mathf.Clamp01(alpha)));
    }

    public void SetFullscreenMapAlpha(float alpha) {
        SendCommand("setFullscreenMapAlpha", BuildFloatPayload("alpha", Mathf.Clamp01(alpha)));
    }

    public void SetUiAlpha(float windowsAlpha, float fullscreenMapAlpha) {
        SendCommand("setUiAlpha", BuildFloatPairPayload(
            "windowsAlpha", Mathf.Clamp01(windowsAlpha),
            "mapAlpha", Mathf.Clamp01(fullscreenMapAlpha)
        ));
    }

    public void RequestState() {
        SendCommand("getState", "{}");
    }

    public void RequestCatalog() {
        SendCommand("getCatalog", "{}");
    }

    // No-ID convenience methods for Inspector and external callers.
    public void ToggleRhythms() => ToggleWindow("rhythms");
    public void ToggleNotation() => ToggleWindow("notation");
    public void ToggleCircular() => ToggleWindow("circular");
    public void ToggleMedia() => ToggleWindow("media");
    public void ToggleContext() => ToggleWindow("context");
    public void ToggleTitle() => ToggleWindow("title");
    public void ToggleSession() => ToggleWindow("session");
    public void ToggleUser() => ToggleWindow("user");
    public void ToggleViews() => ToggleWindow("views");
    public void ToggleStage() => ToggleWindow("stage");
    public void ToggleSettings() => ToggleWindow("settings");
    public void ToggleMap() => ClickTopButton("map");

    public void ToggleMappedWindowByIndex(int index) {
        var id = GetMappedId(mappedWindowIds, index);
        if (string.IsNullOrEmpty(id)) return;
        ToggleWindow(id);
    }

    public void ShowMappedWindowByIndex(int index) {
        var id = GetMappedId(mappedWindowIds, index);
        if (string.IsNullOrEmpty(id)) return;
        ShowWindow(id);
    }

    public void HideMappedWindowByIndex(int index) {
        var id = GetMappedId(mappedWindowIds, index);
        if (string.IsNullOrEmpty(id)) return;
        HideWindow(id);
    }

    public void ClickMappedTopButtonByIndex(int index) {
        var id = GetMappedId(mappedTopButtonIds, index);
        if (string.IsNullOrEmpty(id)) return;
        ClickTopButton(id);
    }

    private void SubscribeToPrefabInitEvents() {
        if (!_canvasSubscribed && canvasWebViewPrefab != null) {
            canvasWebViewPrefab.WebViewInitialized += HandleAnyWebViewInitialized;
            _canvasSubscribed = true;
        }
        if (!_webSubscribed && webViewPrefab != null) {
            webViewPrefab.WebViewInitialized += HandleAnyWebViewInitialized;
            _webSubscribed = true;
        }
    }

    private void UnsubscribeFromPrefabInitEvents() {
        if (_canvasSubscribed && canvasWebViewPrefab != null) {
            canvasWebViewPrefab.WebViewInitialized -= HandleAnyWebViewInitialized;
            _canvasSubscribed = false;
        }
        if (_webSubscribed && webViewPrefab != null) {
            webViewPrefab.WebViewInitialized -= HandleAnyWebViewInitialized;
            _webSubscribed = false;
        }
    }

    private void TryBindAlreadyInitializedWebView() {
        var resolved = ResolveWebView();
        if (resolved != null) BindWebView(resolved);
    }

    private IWebView ResolveWebView() {
        if (canvasWebViewPrefab != null && canvasWebViewPrefab.WebView != null) {
            return canvasWebViewPrefab.WebView;
        }
        if (webViewPrefab != null && webViewPrefab.WebView != null) {
            return webViewPrefab.WebView;
        }
        return null;
    }

    private void HandleAnyWebViewInitialized(object sender, EventArgs e) {
        var resolved = ResolveWebView();
        if (resolved != null) BindWebView(resolved);
    }

    private void BindWebView(IWebView webView) {
        if (webView == null) return;
        if (_webView == webView && _webViewReady) return;

        if (_webView != null) {
            try {
                _webView.MessageEmitted -= HandleMessageEmitted;
            } catch { }
        }

        _webView = webView;
        _webView.MessageEmitted += HandleMessageEmitted;
        _webViewReady = true;
        _webViewReadyAt = Time.unscaledTime;

        if (verboseLogs) Debug.Log("RRCVuplexBridge: WebView bound and listening for messages.");
        onWebViewReady?.Invoke();

        if (!waitForBridgeReadyBeforeSending) {
            FlushQueuedCommands();
        }
    }

    private void UnbindWebView() {
        if (_webView != null) {
            try {
                _webView.MessageEmitted -= HandleMessageEmitted;
            } catch { }
        }
        _webView = null;
        _webViewReady = false;
    }

    private void HandleMessageEmitted(object sender, EventArgs<string> eventArgs) {
        var raw = eventArgs?.Value ?? string.Empty;
        if (string.IsNullOrWhiteSpace(raw)) return;

        onRawMessage?.Invoke(raw);

        BridgePacket packet = null;
        try {
            packet = JsonUtility.FromJson<BridgePacket>(raw);
        } catch {
            // Keep parsing resilient; raw message is still emitted.
        }

        var eventName = packet != null ? (packet.@event ?? string.Empty).Trim() : string.Empty;
        if (string.IsNullOrEmpty(eventName)) return;

        onBridgeEvent?.Invoke(eventName, raw);
        if (verboseLogs) Debug.Log($"RRCVuplexBridge: Event '{eventName}' received.");

        switch (eventName) {
            case "bridge_ready":
                _bridgeReady = true;
                if (packet?.payload != null) {
                    IngestCatalog(packet.payload.catalog, packet.payload.topButtons);
                }
                onBridgeReady?.Invoke();
                if (requestStateWhenBridgeReady) {
                    SendCommand("getState", "{}");
                }
                if (requestCatalogWhenBridgeReady) {
                    SendCommand("getCatalog", "{}");
                }
                DispatchBridgeReadyStartupCommands();
                FlushQueuedCommands();
                break;

            case "top_button_clicked":
                onTopButtonClicked?.Invoke(
                    packet?.payload?.buttonId ?? string.Empty,
                    packet?.payload?.label ?? string.Empty
                );
                break;

            case "window_visibility_changed":
                onWindowVisibilityChanged?.Invoke(
                    packet?.payload?.windowId ?? string.Empty,
                    packet != null && packet.payload != null && packet.payload.visible
                );
                break;

            case "command_result":
                HandleCommandResult(packet);
                break;
        }
    }

    private void HandleCommandResult(BridgePacket packet) {
        if (packet == null || packet.payload == null) {
            onCommandResult?.Invoke(string.Empty, string.Empty, false, "missing_payload");
            return;
        }

        var requestId = packet.payload.requestId ?? string.Empty;
        var command = packet.payload.command ?? string.Empty;
        var ok = packet.payload.result != null && packet.payload.result.ok;
        var error = packet.payload.result != null ? (packet.payload.result.error ?? string.Empty) : string.Empty;

        if (!string.IsNullOrEmpty(requestId)) {
            _pendingCommands.Remove(requestId);
        }

        if (packet.payload.result != null) {
            IngestCatalog(packet.payload.result.catalog, null);
            if (packet.payload.result.state != null) {
                IngestCatalog(packet.payload.result.state.catalog, null);
            }
        }

        onCommandResult?.Invoke(requestId, command, ok, error);
    }

    private void DispatchBridgeReadyStartupCommands() {
        if (startupCommands == null || startupCommands.Count == 0) return;
        for (int i = 0; i < startupCommands.Count; i++) {
            var entry = startupCommands[i];
            if (entry == null || !entry.enabled || !entry.sendOnBridgeReady) continue;
            SendCommand(entry.command, entry.payloadJson);
        }
    }

    private void ProcessBridgeReadyFallback() {
        if (!_webViewReady) return;
        if (_bridgeReady) return;
        if (!waitForBridgeReadyBeforeSending) return;
        if (bridgeReadyFallbackSeconds <= 0f) return;

        var elapsed = Time.unscaledTime - _webViewReadyAt;
        if (elapsed < bridgeReadyFallbackSeconds) return;

        _bridgeReady = true;
        if (verboseLogs) {
            Debug.LogWarning("RRCVuplexBridge: bridge_ready timeout reached, releasing queued commands.");
        }
        FlushQueuedCommands();
    }

    private void ProcessTimedOutCommands() {
        if (_pendingCommands.Count == 0) return;
        if (commandTimeoutSeconds <= 0f) return;

        var now = Time.unscaledTime;
        var expiredIds = ListPool<string>.Get();
        foreach (var pair in _pendingCommands) {
            if (now - pair.Value.sentAt >= commandTimeoutSeconds) {
                expiredIds.Add(pair.Key);
            }
        }

        for (int i = 0; i < expiredIds.Count; i++) {
            var id = expiredIds[i];
            if (_pendingCommands.TryGetValue(id, out var pending)) {
                _pendingCommands.Remove(id);
                onCommandTimeout?.Invoke(id, pending.command, false, "timeout");
                if (verboseLogs) {
                    Debug.LogWarning($"RRCVuplexBridge: Command timeout ({pending.command}, {id}).");
                }
            }
        }
        ListPool<string>.Release(expiredIds);
    }

    private bool ShouldQueueCommands() {
        if (!queueCommandsUntilReady) return false;
        if (!_webViewReady || _webView == null) return true;
        if (waitForBridgeReadyBeforeSending && !_bridgeReady) return true;
        return false;
    }

    private static string NormalizeAlias(string value) {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        var s = value.Trim().ToLowerInvariant();
        if (s.Length == 0) return string.Empty;
        var chars = new List<char>(s.Length);
        for (int i = 0; i < s.Length; i++) {
            var c = s[i];
            if (char.IsLetterOrDigit(c) || c == '-') chars.Add(c);
        }
        return new string(chars.ToArray());
    }

    private void RegisterTopButtonAlias(string alias, string buttonId) {
        var key = NormalizeAlias(alias);
        var value = (buttonId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(value)) return;
        _topButtonAliases[key] = value;
    }

    private void RegisterWindowAlias(string alias, string windowId) {
        var key = NormalizeAlias(alias);
        var value = (windowId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(value)) return;
        _windowAliases[key] = value;
    }

    private void SeedDefaultAliases() {
        RegisterWindowAlias("rhythm", "rhythm-panel");
        RegisterWindowAlias("rhythms", "rhythm-panel");
        RegisterWindowAlias("browser", "rhythm-panel");
        RegisterWindowAlias("notation", "notation-overlay");
        RegisterWindowAlias("compactnotation", "notation-overlay");
        RegisterWindowAlias("circular", "notation-circular-overlay");
        RegisterWindowAlias("title", "info-banner");
        RegisterWindowAlias("info", "info-banner");
        RegisterWindowAlias("context", "history-box");
        RegisterWindowAlias("history", "history-box");
        RegisterWindowAlias("media", "image-window");
        RegisterWindowAlias("user", "auth-panel");
        RegisterWindowAlias("auth", "auth-panel");
        RegisterWindowAlias("session", "session-panel");
        RegisterWindowAlias("views", "views-panel");
        RegisterWindowAlias("stage", "stage-panel");
        RegisterWindowAlias("settings", "debug-controls");
        RegisterWindowAlias("debug", "debug-controls");
        RegisterWindowAlias("map", "cesiumContainer");
        RegisterWindowAlias("nav", "nav-toolbar");

        RegisterTopButtonAlias("rhythm", "rhythm-toggle");
        RegisterTopButtonAlias("rhythms", "rhythm-toggle");
        RegisterTopButtonAlias("notation", "notation-toggle");
        RegisterTopButtonAlias("circular", "circular-toggle");
        RegisterTopButtonAlias("title", "info-toggle");
        RegisterTopButtonAlias("info", "info-toggle");
        RegisterTopButtonAlias("context", "history-toggle");
        RegisterTopButtonAlias("history", "history-toggle");
        RegisterTopButtonAlias("media", "media-toggle");
        RegisterTopButtonAlias("user", "auth-toggle");
        RegisterTopButtonAlias("auth", "auth-toggle");
        RegisterTopButtonAlias("session", "session-toggle");
        RegisterTopButtonAlias("views", "views-toggle");
        RegisterTopButtonAlias("stage", "stage-toggle");
        RegisterTopButtonAlias("map", "map-toggle");
        RegisterTopButtonAlias("settings", "debug-toggle");
        RegisterTopButtonAlias("debug", "debug-toggle");
    }

    private void IngestCatalog(BridgeCatalog catalog, string[] legacyTopButtons) {
        var changed = false;

        if (_topButtonAliases.Count == 0 && _windowAliases.Count == 0) {
            SeedDefaultAliases();
            changed = true;
        }

        if (legacyTopButtons != null && legacyTopButtons.Length > 0) {
            for (int i = 0; i < legacyTopButtons.Length; i++) {
                var buttonId = (legacyTopButtons[i] ?? string.Empty).Trim();
                if (string.IsNullOrEmpty(buttonId)) continue;
                if (!_autoTopButtonIds.Contains(buttonId)) {
                    _autoTopButtonIds.Add(buttonId);
                    changed = true;
                }
                RegisterTopButtonAlias(buttonId, buttonId);
            }
        }

        if (catalog != null) {
            if (catalog.topButtons != null) {
                for (int i = 0; i < catalog.topButtons.Length; i++) {
                    var button = catalog.topButtons[i];
                    if (button == null) continue;
                    var buttonId = (button.id ?? string.Empty).Trim();
                    if (string.IsNullOrEmpty(buttonId)) continue;
                    if (!_autoTopButtonIds.Contains(buttonId)) {
                        _autoTopButtonIds.Add(buttonId);
                        changed = true;
                    }
                    RegisterTopButtonAlias(button.id, buttonId);
                    RegisterTopButtonAlias(button.key, buttonId);
                    RegisterTopButtonAlias(button.label, buttonId);
                }
            }

            if (catalog.windows != null) {
                for (int i = 0; i < catalog.windows.Length; i++) {
                    var window = catalog.windows[i];
                    if (window == null) continue;
                    var windowId = (window.id ?? string.Empty).Trim();
                    if (string.IsNullOrEmpty(windowId)) continue;
                    if (!_autoWindowIds.Contains(windowId)) {
                        _autoWindowIds.Add(windowId);
                        changed = true;
                    }
                    RegisterWindowAlias(window.id, windowId);
                    RegisterWindowAlias(window.key, windowId);
                    RegisterWindowAlias(window.label, windowId);
                    if (!string.IsNullOrEmpty(window.toggleButtonId)) {
                        RegisterTopButtonAlias(window.toggleButtonId, window.toggleButtonId);
                    }
                }
            }
        }

        if (changed) {
            onCatalogUpdated?.Invoke(_autoTopButtonIds.Count, _autoWindowIds.Count);
            if (verboseLogs) {
                Debug.Log($"RRCVuplexBridge: Catalog updated. Buttons={_autoTopButtonIds.Count}, Windows={_autoWindowIds.Count}");
            }
        }
    }

    private string ResolveWindowId(string idOrAlias) {
        var raw = (idOrAlias ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        if (_autoWindowIds.Contains(raw)) return raw;
        if (mappedWindowIds != null && mappedWindowIds.Contains(raw)) return raw;
        var key = NormalizeAlias(raw);
        if (_windowAliases.TryGetValue(key, out var resolved)) return resolved;
        if (_topButtonAliases.TryGetValue(key, out var topButton)) {
            if (topButton == "rhythm-toggle") return "rhythm-panel";
            if (topButton == "notation-toggle") return "notation-overlay";
            if (topButton == "circular-toggle") return "notation-circular-overlay";
            if (topButton == "info-toggle") return "info-banner";
            if (topButton == "history-toggle") return "history-box";
            if (topButton == "media-toggle") return "image-window";
            if (topButton == "auth-toggle") return "auth-panel";
            if (topButton == "session-toggle") return "session-panel";
            if (topButton == "views-toggle") return "views-panel";
            if (topButton == "stage-toggle") return "stage-panel";
            if (topButton == "debug-toggle") return "debug-controls";
            if (topButton == "map-toggle") return "cesiumContainer";
        }
        return raw; // Let web side attempt alias resolution too.
    }

    private string ResolveTopButtonId(string idOrAlias) {
        var raw = (idOrAlias ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        if (_autoTopButtonIds.Contains(raw)) return raw;
        if (mappedTopButtonIds != null && mappedTopButtonIds.Contains(raw)) return raw;
        var key = NormalizeAlias(raw);
        if (_topButtonAliases.TryGetValue(key, out var resolved)) return resolved;
        return raw; // Let web side attempt alias resolution too.
    }

    private void DispatchCommand(QueuedCommand cmd) {
        if (_webView == null) return;

        var requestId = EscapeForJs(cmd.requestId);
        var command = EscapeForJs(cmd.command);
        var payloadJson = NormalizePayloadJson(cmd.payloadJson);

        var script =
            "window.postMessage({" +
            "\"type\":\"rrcExternalControl\"," +
            "\"requestId\":\"" + requestId + "\"," +
            "\"command\":\"" + command + "\"," +
            "\"payload\":" + payloadJson +
            "}, \"*\");";

        _webView.ExecuteJavaScript(script);
        _pendingCommands[cmd.requestId] = new PendingCommand {
            command = cmd.command,
            sentAt = Time.unscaledTime
        };

        if (verboseLogs) {
            Debug.Log($"RRCVuplexBridge: Sent {cmd.command} ({cmd.requestId}).");
        }
    }

    private string NextRequestId() {
        _requestCounter += 1;
        var prefix = string.IsNullOrWhiteSpace(requestIdPrefix) ? "unity" : requestIdPrefix.Trim();
        return prefix + "-" + _requestCounter;
    }

    private static string GetMappedId(List<string> ids, int index) {
        if (ids == null) return string.Empty;
        if (index < 0 || index >= ids.Count) return string.Empty;
        return (ids[index] ?? string.Empty).Trim();
    }

    private static string BuildStringPayload(string key, string value) {
        var safeKey = EscapeForJs(key ?? string.Empty);
        var safeValue = EscapeForJs(value ?? string.Empty);
        return "{\"" + safeKey + "\":\"" + safeValue + "\"}";
    }

    private static string BuildFloatPayload(string key, float value) {
        var safeKey = EscapeForJs(key ?? string.Empty);
        var number = Mathf.Clamp01(value).ToString("0.###", CultureInfo.InvariantCulture);
        return "{\"" + safeKey + "\":" + number + "}";
    }

    private static string BuildFloatPairPayload(string keyA, float valueA, string keyB, float valueB) {
        var safeKeyA = EscapeForJs(keyA ?? string.Empty);
        var safeKeyB = EscapeForJs(keyB ?? string.Empty);
        var numA = Mathf.Clamp01(valueA).ToString("0.###", CultureInfo.InvariantCulture);
        var numB = Mathf.Clamp01(valueB).ToString("0.###", CultureInfo.InvariantCulture);
        return "{\"" + safeKeyA + "\":" + numA + ",\"" + safeKeyB + "\":" + numB + "}";
    }

    private static string NormalizePayloadJson(string payloadJson) {
        var value = payloadJson ?? string.Empty;
        value = value.Trim();
        if (string.IsNullOrEmpty(value)) return "{}";
        var first = value[0];
        // Compatibility: allow callers to pass a plain value string instead of JSON.
        if (first != '{' && first != '[') {
            return "{\"value\":\"" + EscapeForJs(value) + "\"}";
        }
        return value;
    }

    private static string EscapeForJs(string value) {
        return (value ?? string.Empty)
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"");
    }

    // Lightweight pooled list to avoid per-frame allocations in timeout checks.
    private static class ListPool<T> {
        private static readonly Stack<List<T>> Pool = new Stack<List<T>>();

        public static List<T> Get() {
            if (Pool.Count > 0) return Pool.Pop();
            return new List<T>(8);
        }

        public static void Release(List<T> list) {
            if (list == null) return;
            list.Clear();
            Pool.Push(list);
        }
    }
}
