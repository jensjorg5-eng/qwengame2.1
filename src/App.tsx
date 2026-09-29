import { useEffect, useRef } from 'react';
import { GameEngine } from './game/engine';

function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);

  useEffect(() => {
    if (containerRef.current && !engineRef.current) {
      engineRef.current = new GameEngine(containerRef.current);
    }
    return () => {
      if (engineRef.current) {
        engineRef.current.destroy();
        engineRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        margin: 0,
        padding: 0,
      }}
    />
  );
}

export default App;
