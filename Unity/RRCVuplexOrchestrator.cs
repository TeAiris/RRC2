using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;
using UnityEngine.Events;

// Multi-webview coordinator for Vuplex + RRC.
// Use this when you have multiple CanvasWebViewPrefab / WebViewPrefab instances
// and want one Unity control surface to drive them.
[DisallowMultipleComponent]
public class RRCVuplexOrchestrator : MonoBehaviour {

    [Serializable]
    public class BridgeBinding {
        public string id = "Main";
        public RRCVuplexBridge bridge;
        public bool isPrimary = true;
        public bool includeInBroadcast = true;
    }

    [Serializable]
    public class StringEvent : UnityEvent<string> { }

    [Header("Bridge Instances")]
    [SerializeField] private List<BridgeBinding> bridges = new List<BridgeBinding>();
    [SerializeField] private bool verboseLogs = true;

    [Header("Events")]
    public StringEvent onPrimaryBridgeChanged = new StringEvent();

    public RRCVuplexBridge PrimaryBridge => ResolvePrimaryBridge();

    public void RefreshPrimaryBridge() {
        var primary = ResolvePrimaryBridge();
        onPrimaryBridgeChanged?.Invoke(primary != null ? primary.name : string.Empty);
    }

    public void RequestStateFromPrimary() {
        var primary = ResolvePrimaryBridge();
        if (primary == null) return;
        primary.RequestState();
    }

    public void RequestCatalogFromPrimary() {
        var primary = ResolvePrimaryBridge();
        if (primary == null) return;
        primary.RequestCatalog();
    }

    public void RequestStateFromAll() {
        ForEachBridge((binding, bridge) => bridge.RequestState(), includeBroadcastOnly: false);
    }

    public void BroadcastCommand(string command, string payloadJson = "{}") {
        ForEachBridge((binding, bridge) => bridge.SendCommand(command, payloadJson), includeBroadcastOnly: true);
    }

    public void SendCommandToPrimary(string command, string payloadJson = "{}") {
        var primary = ResolvePrimaryBridge();
        if (primary == null) return;
        primary.SendCommand(command, payloadJson);
    }

    public void ToggleWindow(string windowId) {
        BroadcastCommand("toggleWindow", BuildStringPayload("windowId", windowId));
    }

    public void ToggleWindowByAlias(string alias) {
        BroadcastCommand("toggleWindow", BuildStringPayload("value", alias));
    }

    public void ShowWindow(string windowId) {
        BroadcastCommand("showWindow", BuildStringPayload("windowId", windowId));
    }

    public void HideWindow(string windowId) {
        BroadcastCommand("hideWindow", BuildStringPayload("windowId", windowId));
    }

    public void ClickTopButton(string buttonId) {
        SendCommandToPrimary("clickTopButton", BuildStringPayload("buttonId", buttonId));
    }

    public void ClickTopButtonByAlias(string alias) {
        SendCommandToPrimary("clickTopButton", BuildStringPayload("value", alias));
    }

    // No-ID convenience wrappers.
    public void ToggleRhythms() => ToggleWindowByAlias("rhythms");
    public void ToggleNotation() => ToggleWindowByAlias("notation");
    public void ToggleCircular() => ToggleWindowByAlias("circular");
    public void ToggleMedia() => ToggleWindowByAlias("media");
    public void ToggleContext() => ToggleWindowByAlias("context");
    public void ToggleTitle() => ToggleWindowByAlias("title");
    public void ToggleSession() => ToggleWindowByAlias("session");
    public void ToggleUser() => ToggleWindowByAlias("user");
    public void ToggleViews() => ToggleWindowByAlias("views");
    public void ToggleStage() => ToggleWindowByAlias("stage");
    public void ToggleSettings() => ToggleWindowByAlias("settings");
    public void ToggleMap() => ClickTopButtonByAlias("map");

    public void SetRhythm(string rhythmKey) {
        SendCommandToPrimary("setRhythm", BuildStringPayload("rhythmKey", rhythmKey));
    }

    public void PlayNotation() {
        SendCommandToPrimary("playNotation", "{}");
    }

    public void StopNotation() {
        SendCommandToPrimary("stopNotation", "{}");
    }

    public void SetWindowsAlpha(float alpha) {
        BroadcastCommand("setWindowsAlpha", BuildFloatPayload("alpha", Mathf.Clamp01(alpha)));
    }

    public void SetFullscreenMapAlpha(float alpha) {
        BroadcastCommand("setFullscreenMapAlpha", BuildFloatPayload("alpha", Mathf.Clamp01(alpha)));
    }

    public void SetUiAlpha(float windowsAlpha, float fullscreenMapAlpha) {
        BroadcastCommand("setUiAlpha", BuildFloatPairPayload(
            "windowsAlpha", Mathf.Clamp01(windowsAlpha),
            "mapAlpha", Mathf.Clamp01(fullscreenMapAlpha)
        ));
    }

    private RRCVuplexBridge ResolvePrimaryBridge() {
        RRCVuplexBridge fallback = null;
        for (int i = 0; i < bridges.Count; i++) {
            var entry = bridges[i];
            if (entry == null || entry.bridge == null) continue;
            if (fallback == null) fallback = entry.bridge;
            if (entry.isPrimary) return entry.bridge;
        }
        return fallback;
    }

    private void ForEachBridge(Action<BridgeBinding, RRCVuplexBridge> action, bool includeBroadcastOnly) {
        if (action == null) return;
        for (int i = 0; i < bridges.Count; i++) {
            var entry = bridges[i];
            if (entry == null || entry.bridge == null) continue;
            if (includeBroadcastOnly && !entry.includeInBroadcast) continue;
            action(entry, entry.bridge);
            if (verboseLogs) {
                Debug.Log($"RRCVuplexOrchestrator: Routed command to bridge '{entry.id}'.");
            }
        }
    }

    private static string BuildStringPayload(string key, string value) {
        return "{\"" + EscapeForJs(key) + "\":\"" + EscapeForJs(value) + "\"}";
    }

    private static string BuildFloatPayload(string key, float value) {
        return "{\"" + EscapeForJs(key) + "\":" + Mathf.Clamp01(value).ToString("0.###", CultureInfo.InvariantCulture) + "}";
    }

    private static string BuildFloatPairPayload(string keyA, float valueA, string keyB, float valueB) {
        return "{\"" + EscapeForJs(keyA) + "\":" + Mathf.Clamp01(valueA).ToString("0.###", CultureInfo.InvariantCulture) +
               ",\"" + EscapeForJs(keyB) + "\":" + Mathf.Clamp01(valueB).ToString("0.###", CultureInfo.InvariantCulture) + "}";
    }

    private static string EscapeForJs(string value) {
        return (value ?? string.Empty)
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"");
    }
}
