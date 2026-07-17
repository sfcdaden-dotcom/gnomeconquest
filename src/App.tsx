/**
 * Whimsy Wars — app shell. Switches between the setup screen and a game
 * session; "play again" remounts the game with the same settings and a
 * fresh seed.
 */

import { useState } from 'react';
import type { CreateGameOptions } from './engine';
import { GameScreen } from './ui/GameScreen';
import { SetupScreen } from './ui/SetupScreen';
import { randomSeed } from './ui/meta';

interface Session {
  options: CreateGameOptions;
  seed: number;
  run: number;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  if (!session) {
    return <SetupScreen onStart={({ options, seed }) => setSession({ options, seed, run: 0 })} />;
  }

  return (
    <GameScreen
      key={`${session.run}-${session.seed}`}
      options={session.options}
      seed={session.seed}
      onPlayAgain={() =>
        setSession((s) => (s ? { ...s, seed: randomSeed(), run: s.run + 1 } : s))
      }
      onQuit={() => setSession(null)}
    />
  );
}
