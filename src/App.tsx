// ...existing code...

function App() {
  // ...existing code...
  const [debugNameWidth, setDebugNameWidth] = useState<number>(100); // Debug slider state
  const [showDebugControls, setShowDebugControls] = useState<boolean>(true); // Toggle debug UI

  // ...existing code...

  return (
    <div className="app">
      {/* Debug Controls */}
      {showDebugControls && (
        <div className="debug-controls" style={{
          position: 'fixed',
          top: 10,
          right: 10,
          background: 'rgba(0,0,0,0.8)',
          padding: '10px',
          borderRadius: '8px',
          zIndex: 1000,
          color: 'white'
        }}>
          <label>
            Name Width: {debugNameWidth}px
            <input
              type="range"
              min="50"
              max="200"
              value={debugNameWidth}
              onChange={(e) => setDebugNameWidth(Number(e.target.value))}
              style={{ display: 'block', width: '150px' }}
            />
          </label>
          <button onClick={() => setShowDebugControls(false)} style={{ marginTop: '5px' }}>
            Hide Debug
          </button>
        </div>
      )}

      {/* ...existing code... */}

      {/* Pass debugNameWidth to InstrumentRow components */}
      {instruments.map((instrument) => (
        <InstrumentRow
          key={instrument.id}
          instrument={instrument}
          debugNameWidth={debugNameWidth}
          // ...existing props...
        />
      ))}

      {/* ...existing code... */}
    </div>
  );
}

// ...existing code...
