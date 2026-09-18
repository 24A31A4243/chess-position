import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chess } from 'chess.js';
import { io } from 'socket.io-client';
import './styles.css';

const FILES = ['a','b','c','d','e','f','g','h'];
const RANKS = [8,7,6,5,4,3,2,1];
const PIECES = ['K','Q','R','B','N','P','k','q','r','b','n','p'];
const GLYPHS = { K:'♔', Q:'♕', R:'♖', B:'♗', N:'♘', P:'♙', k:'♚', q:'♛', r:'♜', b:'♝', n:'♞', p:'♟' };
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function fenFromBoard(board, turn='w', castling='KQkq', ep='-', half='0', full='1') {
  const ranks = [];
  for (let r=7; r>=0; r--) {
    let row = '', empty = 0;
    for (let f=0; f<8; f++) {
      const p = board[r][f];
      if (!p) empty++;
      else { if (empty) row += empty; empty=0; row += p; }
    }
    if (empty) row += empty;
    ranks.push(row);
  }
  return `${ranks.join('/')} ${turn} ${castling || '-'} ${ep || '-'} ${half || 0} ${full || 1}`;
}

function boardFromFen(fen) {
  try {
    const parts = fen.trim().split(/\s+/);
    const rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('bad fen');
  const board = Array.from({length:8}, () => Array(8).fill(null));
  rows.forEach((row, rankIndex) => {
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) file += Number(char);
      else board[7-rankIndex][file++] = char;
    }
  });
    return { board, turn: parts[1] || 'w', castling: parts[2] || '-', ep: parts[3] || '-', half: parts[4] || '0', full: parts[5] || '1' };
  } catch {
    return boardFromFen(START_FEN);
  }
}

function ChessBoard({ fen, interactive=true, orientation='white', onMove, selected, setSelected, editMode=false, onEdit }) {
  const parsed = useMemo(() => boardFromFen(fen), [fen]);
  const [legal, setLegal] = useState([]);
  const chess = useMemo(() => { try { return new Chess(fen); } catch { return null; } }, [fen]);
  const squares = [];
  const files = orientation === 'white' ? FILES : [...FILES].reverse();
  const ranks = orientation === 'white' ? RANKS : [...RANKS].reverse();

  function handleSquare(square) {
    const [file, rank] = [square[0], Number(square[1])];
    const p = chess?.get(square);
    if (editMode) { onEdit?.(square); return; }
    if (!interactive || !chess) return;
    if (selected) {
      if (selected === square) { setSelected(null); setLegal([]); return; }
      try {
        const moves = chess.moves({ square: selected, verbose: true });
        if (moves.some(m => m.to === square)) {
          onMove?.(selected, square, p?.type === 'p' && (rank === 8 || rank === 1) ? 'q' : undefined);
          setSelected(null); setLegal([]); return;
        }
      } catch {}
    }
    if (p && p.color === chess.turn()) {
      setSelected(square);
      setLegal(chess.moves({ square, verbose:true }).map(m => m.to));
    } else {
      setSelected(null); setLegal([]);
    }
  }

  for (const rank of ranks) for (const file of files) {
    const square = `${file}${rank}`;
    const p = parsed.board[rank-1][FILES.indexOf(file)];
    const dark = (FILES.indexOf(file) + rank) % 2 === 1;
    const isSelected = selected === square;
    const isLegal = legal.includes(square);
    squares.push(
      <button key={square} className={`square ${dark ? 'dark':''} ${isSelected ? 'selected':''}`} onClick={() => handleSquare(square)} aria-label={square}>
        {p && <span className={`piece ${p === p.toUpperCase() ? 'white-piece':'black-piece'}`}>{GLYPHS[p]}</span>}
        {isLegal && <span className={`move-dot ${p ? 'capture':''}`} />}
        {file === files[0] && <span className="rank-label">{rank}</span>}
        {rank === ranks[ranks.length-1] && <span className="file-label">{file}</span>}
      </button>
    );
  }
  return <div className="board">{squares}</div>;
}

function App() {
  const [view, setView] = useState('home');
  const [fen, setFen] = useState(START_FEN);
  const [editorFen, setEditorFen] = useState(START_FEN);
  const [recognizing, setRecognizing] = useState(false);
  const [recognition, setRecognition] = useState(null);
  const [selected, setSelected] = useState(null);
  const [orientation, setOrientation] = useState('white');
  const [pieceTool, setPieceTool] = useState('P');
  const [roomCode, setRoomCode] = useState('');
  const [room, setRoom] = useState(null);
  const [color, setColor] = useState(null);
  const [socket, setSocket] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [notice, setNotice] = useState('');
  const [fenInput, setFenInput] = useState(START_FEN);
  const fileRef = useRef(null);

  useEffect(() => {
    const s = io();
    setSocket(s);
    s.on('room-state', state => setRoom(state));
    s.on('move-made', ({ state }) => setRoom(state));
    s.on('connect_error', () => setNotice('Could not connect to the multiplayer server.'));
    return () => s.disconnect();
  }, []);

  const editor = useMemo(() => boardFromFen(editorFen), [editorFen]);

  function updateEditor(changes) {
    const next = { ...editor, ...changes };
    setEditorFen(fenFromBoard(next.board, next.turn, next.castling, next.ep, next.half, next.full));
  }

  function editSquare(square) {
    const b = editor.board.map(row => [...row]);
    const f = FILES.indexOf(square[0]);
    const r = Number(square[1]) - 1;
    b[r][f] = b[r][f] === pieceTool ? null : pieceTool;
    updateEditor({ board:b });
  }

  async function recognizeImage(file) {
    if (!file) return;
    setRecognizing(true); setNotice('Analyzing the board…'); setRecognition(null);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
      });
      const response = await fetch('/api/recognize-position', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({image:dataUrl}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Recognition failed');
      setEditorFen(data.fen); setFen(data.fen); setRecognition(data); setView('editor'); setNotice('Position detected. Check and correct it before creating the room.');
    } catch (e) { setNotice(e.message); }
    finally { setRecognizing(false); }
  }

  function createRoom() {
    if (!socket) return;
    socket.emit('create-room', { fen: editorFen }, result => {
      if (!result?.ok) return setNotice(result?.error || 'Could not create room.');
      setColor(result.color); setRoomCode(result.code); setRoom(result.state); setView('game'); setNotice(`Room ${result.code} created. Share the code with your friend.`);
    });
  }

  function joinRoom() {
    if (!socket) return;
    socket.emit('join-room', { code: joinCode }, result => {
      if (!result?.ok) return setNotice(result?.error || 'Could not join room.');
      setColor(result.color); setRoomCode(result.code); setRoom(result.state); setView('game'); setNotice('Joined the room.');
    });
  }

  function makeMove(from, to, promotion) {
    socket?.emit('make-move', {from,to,promotion}, result => { if (!result?.ok) setNotice(result?.error || 'Illegal move.'); });
  }

  function loadFen() {
    try {
      const c = new Chess(fenInput.trim());
      setEditorFen(c.fen()); setFen(c.fen()); setRecognition(null); setNotice('FEN loaded into the editor.'); setView('editor');
    } catch (e) { setNotice('Invalid FEN.'); }
  }

  async function copyRoom() {
    const link = `${location.origin}?room=${roomCode}`;
    await navigator.clipboard?.writeText(link);
    setNotice('Room link copied.');
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get('room');
    if (code) { setJoinCode(code); setView('join'); }
  }, []);

  const gameFen = room?.fen || fen;
  const gameChess = useMemo(() => { try { return new Chess(gameFen); } catch { return null; } }, [gameFen]);
  const turnText = gameChess?.turn() === 'w' ? 'White to move' : 'Black to move';

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => setView('home')}><span className="brand-icon">♞</span><span>Position Play</span></button>
      <div className="top-actions"><button onClick={() => setView('editor')}>Editor</button><button onClick={() => setView('join')}>Join room</button></div>
    </header>

    {notice && <div className="notice" onClick={() => setNotice('')}>{notice}<span>×</span></div>}

    <main>
      {view === 'home' && <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">SCREENSHOT → PLAYABLE POSITION</div>
          <h1>Turn any chess screenshot into a game.</h1>
          <p>Upload a position, correct the pieces if needed, create a private room, and play your friend from that exact position.</p>
          <div className="hero-actions">
            <button className="primary" onClick={() => fileRef.current?.click()} disabled={recognizing}>{recognizing ? 'Analyzing…' : 'Upload screenshot'}</button>
            <button className="secondary" onClick={() => {setEditorFen(START_FEN); setView('editor')}}>Start from position</button>
          </div>
          <input ref={fileRef} hidden type="file" accept="image/*" onChange={e => recognizeImage(e.target.files?.[0])}/>
          <div className="feature-row"><span>♟ AI board detection</span><span>✎ Manual correction</span><span>⚡ Live multiplayer</span></div>
        </div>
        <div className="hero-board"><ChessBoard fen={START_FEN} interactive={false} orientation="white" selected={null} setSelected={()=>{}}/></div>
      </section>}

      {view === 'editor' && <section className="workspace">
        <div className="section-head"><div><div className="eyebrow">POSITION EDITOR</div><h2>Check the detected position</h2></div><button className="ghost" onClick={() => setView('home')}>Back</button></div>
        {recognition && <div className="confidence"><b>AI confidence: {Math.round(Math.max(0,Math.min(1,recognition.confidence))*100)}%</b><span>{recognition.notes}</span></div>}
        <div className="editor-grid">
          <div><ChessBoard fen={editorFen} interactive={false} editMode onEdit={editSquare} orientation={orientation} selected={null} setSelected={()=>{}}/></div>
          <aside className="panel">
            <h3>Piece tool</h3>
            <div className="piece-palette">{PIECES.map(p => <button key={p} className={pieceTool===p?'active':''} onClick={() => setPieceTool(p)}>{GLYPHS[p]}</button>)}</div>
            <p className="muted">Select a piece, then tap squares. Tap the same piece again to clear a square.</p>
            <label>Side to move<select value={editor.turn} onChange={e=>updateEditor({turn:e.target.value})}><option value="w">White</option><option value="b">Black</option></select></label>
            <label>Castling rights<input value={editor.castling} onChange={e=>updateEditor({castling:e.target.value})} placeholder="KQkq or -"/></label>
            <label>FEN<input value={editorFen} onChange={e=>setEditorFen(e.target.value)}/></label>
            <div className="row"><button className="secondary small" onClick={() => setEditorFen(START_FEN)}>Reset</button><button className="secondary small" onClick={() => setOrientation(o=>o==='white'?'black':'white')}>Flip board</button></div>
            <button className="primary full" onClick={createRoom}>Create friend room</button>
          </aside>
        </div>
        <div className="fen-box"><b>Import a FEN</b><div className="row"><input value={fenInput} onChange={e=>setFenInput(e.target.value)}/><button className="secondary" onClick={loadFen}>Load</button></div></div>
      </section>}

      {view === 'join' && <section className="center-card"><div className="eyebrow">MULTIPLAYER</div><h2>Join a friend's position</h2><p>Enter the six-character room code your friend shared.</p><input className="big-input" autoFocus value={joinCode} onChange={e=>setJoinCode(e.target.value.toUpperCase())} maxLength={6} placeholder="ABC123"/><button className="primary full" onClick={joinRoom}>Join room</button><button className="secondary full" onClick={()=>setView('home')}>Cancel</button></section>}

      {view === 'game' && room && <section className="game-layout">
        <div className="game-main">
          <div className="game-top"><div><div className="eyebrow">ROOM {room.code}</div><h2>{color === 'w' ? 'You are White' : 'You are Black'}</h2></div><div className={`turn-pill ${gameChess?.turn()===color?'your-turn':''}`}>{turnText}</div></div>
          <ChessBoard fen={room.fen} interactive orientation={color==='w'?'white':'black'} selected={selected} setSelected={setSelected} onMove={makeMove}/>
          <div className="game-actions"><button className="secondary" onClick={()=>setOrientation(o=>o==='white'?'black':'white')}>Flip</button><button className="secondary" onClick={copyRoom}>Copy room link</button><button className="danger" onClick={()=>socket?.emit('resign')}>Resign</button></div>
        </div>
        <aside className="game-panel"><div className="room-card"><span>Room code</span><strong>{room.code}</strong><button className="secondary full" onClick={copyRoom}>Copy invite link</button></div><div className="players"><h3>Players</h3><div><span className="dot white"></span> White {room.players.white ? '● Connected' : '○ Waiting'}</div><div><span className="dot black"></span> Black {room.players.black ? '● Connected' : '○ Waiting'}</div></div><div className="moves"><h3>Moves</h3>{room.history.length===0 ? <span className="muted">No moves yet</span> : room.history.map((m,i)=><span key={i}>{i%2===0 && <b>{Math.floor(i/2)+1}. </b>}{m.san}</span>)}</div>{room.status !== 'playing' && <div className="status-card">{room.status==='waiting'?'Waiting for your friend…':room.status==='finished'?'Game over':room.status.includes('white')?'White wins by resignation':'Black wins by resignation'}</div>}</aside>
      </section>}
    </main>
    <footer>Position Play · screenshot recognition + editable FEN + real-time rooms</footer>
  </div>
}

createRoot(document.getElementById('root')).render(<App />);
