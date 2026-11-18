using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

// Spawns additional Vuplex webview window prefabs by logical RRC window key.
// Each spawned instance loads the full app URL and then opens the requested
// RRC window alias ("notation", "rhythms", "media", etc.) through the bridge.
[DisallowMultipleComponent]
public class RRCVuplexWindowSpawner : MonoBehaviour {

    [Serializable]
    public class WindowSpawnConfig {
        [Tooltip("Lookup key used by OpenWindow(key). Example: notation, circular, media.")]
        public string key = "notation";

        [Tooltip("Window alias sent to the web app. Leave empty to use key.")]
        public string windowAlias = "notation";

        [Tooltip("Target in-app window width in pixels (used for calculated Unity scale).")]
        public float targetWindowWidthPx = 900f;

        [Tooltip("Target in-app window height in pixels (used for calculated Unity scale).")]
        public float targetWindowHeightPx = 620f;

        [Tooltip("Use explicit Unity local scale values instead of calculated values.")]
        public bool useManualScaleValues = false;

        [Tooltip("Manual Unity local scale values if useManualScaleValues is enabled.")]
        public Vector3 manualLocalScale = new Vector3(1f, 1f, 1f);

        [Tooltip("Spawn local position relative to Window Root.")]
        public Vector3 localPosition = Vector3.zero;

        [Tooltip("Show this window alias automatically after the spawned bridge is ready.")]
        public bool autoShowOnOpen = true;
    }

    private class SpawnedWindow {
        public string key;
        public string alias;
        public GameObject root;
        public RRCVuplexBridge bridge;
        public WindowSpawnConfig config;
    }

    [Header("Main Bridge")]
    [SerializeField] private RRCVuplexBridge mainBridge;

    [Header("Spawn Prefab")]
    [Tooltip("Generic webview prefab wrapper to clone per spawned window. Must include RRCVuplexBridge.")]
    [SerializeField] private GameObject webViewWindowPrefab;
    [SerializeField] private Transform windowRoot;

    [Header("App URL")]
    [Tooltip("Full app URL loaded into each spawned window instance.")]
    [SerializeField] private string appUrl = "http://localhost:5500/index.html";

    [Header("Scale Mapping")]
    [Tooltip("When enabled, convert target pixel window dimensions to Unity localScale.")]
    [SerializeField] private bool useCalculatedScale = true;
    [Tooltip("Pixel-to-Unity scale multiplier for calculated mode.")]
    [SerializeField] private float pixelToUnityScale = 0.001f;
    [Tooltip("Wait timeout (seconds) for each spawned bridge to become ready.")]
    [SerializeField] private float bridgeReadyTimeoutSeconds = 12f;

    [Header("Windows")]
    [SerializeField] private List<WindowSpawnConfig> windows = new List<WindowSpawnConfig>();
    [SerializeField] private bool allowAdHocKeys = true;

    [Header("Debug")]
    [SerializeField] private bool verboseLogs = true;

    private readonly Dictionary<string, SpawnedWindow> _spawnedByKey = new Dictionary<string, SpawnedWindow>();

    public void OpenWindow(string key) {
        var normalized = NormalizeKey(key);
        if (string.IsNullOrEmpty(normalized)) return;

        if (_spawnedByKey.TryGetValue(normalized, out var existing) && existing != null && existing.root != null) {
            existing.root.SetActive(true);
            ApplyTransform(existing);
            if (existing.bridge != null && existing.config != null && existing.config.autoShowOnOpen) {
                existing.bridge.ShowWindow(existing.alias);
            }
            return;
        }

        var config = ResolveConfig(normalized);
        if (config == null) {
            Debug.LogWarning($"RRCVuplexWindowSpawner: No config found for key '{key}'.");
            return;
        }
        if (webViewWindowPrefab == null) {
            Debug.LogError("RRCVuplexWindowSpawner: webViewWindowPrefab is not assigned.");
            return;
        }

        var parent = windowRoot != null ? windowRoot : transform;
        var root = Instantiate(webViewWindowPrefab, parent);
        root.name = $"RRCWindow_{normalized}";
        root.SetActive(true);

        var bridge = root.GetComponentInChildren<RRCVuplexBridge>(true);
        if (bridge == null) {
            Debug.LogError($"RRCVuplexWindowSpawner: Spawned prefab for '{normalized}' has no RRCVuplexBridge.");
            Destroy(root);
            return;
        }
        bridge.RefreshBindings();

        var spawned = new SpawnedWindow {
            key = normalized,
            alias = ResolveAlias(config, normalized),
            root = root,
            bridge = bridge,
            config = config
        };
        _spawnedByKey[normalized] = spawned;
        ApplyTransform(spawned);
        StartCoroutine(InitSpawnedWindow(spawned));
    }

    public void CloseWindow(string key) {
        var normalized = NormalizeKey(key);
        if (string.IsNullOrEmpty(normalized)) return;
        if (!_spawnedByKey.TryGetValue(normalized, out var spawned) || spawned == null) return;
        if (spawned.bridge != null) {
            spawned.bridge.HideWindow(spawned.alias);
        }
        if (spawned.root != null) {
            spawned.root.SetActive(false);
        }
    }

    public void DestroyWindow(string key) {
        var normalized = NormalizeKey(key);
        if (string.IsNullOrEmpty(normalized)) return;
        if (!_spawnedByKey.TryGetValue(normalized, out var spawned) || spawned == null) return;
        _spawnedByKey.Remove(normalized);
        if (spawned.root != null) {
            Destroy(spawned.root);
        }
    }

    public void DestroyAllSpawnedWindows() {
        var keys = new List<string>(_spawnedByKey.Keys);
        for (int i = 0; i < keys.Count; i++) {
            DestroyWindow(keys[i]);
        }
    }

    public void ToggleWindowOnMain(string key) {
        if (mainBridge == null) return;
        mainBridge.ToggleWindow(key);
    }

    public void ShowWindowOnMain(string key) {
        if (mainBridge == null) return;
        mainBridge.ShowWindow(key);
    }

    public void HideWindowOnMain(string key) {
        if (mainBridge == null) return;
        mainBridge.HideWindow(key);
    }

    public void OpenNotation() => OpenWindow("notation");
    public void OpenCircular() => OpenWindow("circular");
    public void OpenRhythms() => OpenWindow("rhythms");
    public void OpenMedia() => OpenWindow("media");
    public void OpenContext() => OpenWindow("context");
    public void OpenTitle() => OpenWindow("title");
    public void OpenPads() => OpenWindow("pads");
    public void OpenSession() => OpenWindow("session");
    public void OpenUser() => OpenWindow("user");
    public void OpenViews() => OpenWindow("views");
    public void OpenSettings() => OpenWindow("settings");

    [ContextMenu("Populate Default Window Keys")]
    public void PopulateDefaultWindowKeys() {
        windows = new List<WindowSpawnConfig> {
            MakeDefault("notation", "notation", 1200f, 760f, new Vector3(-0.9f, 0.15f, 0f)),
            MakeDefault("circular", "circular", 620f, 620f, new Vector3(0.95f, 0.25f, 0f)),
            MakeDefault("rhythms", "rhythms", 420f, 760f, new Vector3(-1.55f, 0.05f, 0f)),
            MakeDefault("media", "media", 520f, 360f, new Vector3(0.95f, 0.95f, 0f)),
            MakeDefault("context", "context", 520f, 420f, new Vector3(0.95f, -0.15f, 0f)),
            MakeDefault("title", "title", 520f, 190f, new Vector3(0.95f, 1.42f, 0f)),
            MakeDefault("pads", "pads", 620f, 560f, new Vector3(-0.25f, -0.85f, 0f)),
            MakeDefault("session", "session", 380f, 340f, new Vector3(-0.8f, 1.25f, 0f)),
            MakeDefault("user", "user", 380f, 320f, new Vector3(-1.35f, 1.25f, 0f)),
            MakeDefault("views", "views", 420f, 300f, new Vector3(-0.2f, 1.25f, 0f)),
            MakeDefault("settings", "settings", 620f, 760f, new Vector3(1.55f, 0.05f, 0f))
        };
    }

    private static WindowSpawnConfig MakeDefault(string key, string alias, float widthPx, float heightPx, Vector3 position) {
        return new WindowSpawnConfig {
            key = key,
            windowAlias = alias,
            targetWindowWidthPx = widthPx,
            targetWindowHeightPx = heightPx,
            useManualScaleValues = false,
            manualLocalScale = new Vector3(1f, 1f, 1f),
            localPosition = position,
            autoShowOnOpen = true
        };
    }

    private IEnumerator InitSpawnedWindow(SpawnedWindow spawned) {
        if (spawned == null || spawned.bridge == null) yield break;

        var bridge = spawned.bridge;
        bridge.RefreshBindings();

        var timeoutAt = Time.realtimeSinceStartup + Mathf.Max(1f, bridgeReadyTimeoutSeconds);
        while (!bridge.IsWebViewReady && Time.realtimeSinceStartup < timeoutAt) {
            yield return null;
        }

        if (!string.IsNullOrWhiteSpace(appUrl)) {
            bridge.LoadURL(appUrl.Trim());
        }

        timeoutAt = Time.realtimeSinceStartup + Mathf.Max(1f, bridgeReadyTimeoutSeconds);
        while (!bridge.IsBridgeReady && Time.realtimeSinceStartup < timeoutAt) {
            yield return null;
        }

        if (spawned.config != null && spawned.config.autoShowOnOpen) {
            bridge.ShowWindow(spawned.alias);
        }

        if (verboseLogs) {
            Debug.Log($"RRCVuplexWindowSpawner: Opened '{spawned.key}' (alias '{spawned.alias}').");
        }
    }

    private void ApplyTransform(SpawnedWindow spawned) {
        if (spawned == null || spawned.root == null || spawned.config == null) return;
        spawned.root.transform.localPosition = spawned.config.localPosition;
        spawned.root.transform.localRotation = Quaternion.identity;
        spawned.root.transform.localScale = ResolveScale(spawned.config, spawned.root.transform.localScale);
    }

    private Vector3 ResolveScale(WindowSpawnConfig config, Vector3 fallback) {
        if (config == null) return fallback;
        if (config.useManualScaleValues || !useCalculatedScale) {
            return new Vector3(
                Mathf.Max(0.001f, config.manualLocalScale.x),
                Mathf.Max(0.001f, config.manualLocalScale.y),
                Mathf.Max(0.001f, config.manualLocalScale.z)
            );
        }
        var factor = Mathf.Max(0.00001f, pixelToUnityScale);
        var sx = Mathf.Max(0.001f, config.targetWindowWidthPx * factor);
        var sy = Mathf.Max(0.001f, config.targetWindowHeightPx * factor);
        var sz = Mathf.Max(0.001f, fallback.z <= 0f ? 1f : fallback.z);
        return new Vector3(sx, sy, sz);
    }

    private WindowSpawnConfig ResolveConfig(string normalizedKey) {
        if (windows != null) {
            for (int i = 0; i < windows.Count; i++) {
                var entry = windows[i];
                if (entry == null) continue;
                if (NormalizeKey(entry.key) == normalizedKey) return entry;
            }
        }
        if (!allowAdHocKeys) return null;
        return new WindowSpawnConfig {
            key = normalizedKey,
            windowAlias = normalizedKey,
            targetWindowWidthPx = 900f,
            targetWindowHeightPx = 620f,
            useManualScaleValues = false,
            manualLocalScale = new Vector3(1f, 1f, 1f),
            localPosition = Vector3.zero,
            autoShowOnOpen = true
        };
    }

    private static string ResolveAlias(WindowSpawnConfig config, string fallbackKey) {
        var alias = config != null ? NormalizeKey(config.windowAlias) : string.Empty;
        return string.IsNullOrEmpty(alias) ? fallbackKey : alias;
    }

    private static string NormalizeKey(string value) {
        return string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim().ToLowerInvariant();
    }
}
