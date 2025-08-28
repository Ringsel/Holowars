
import React, { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

type Faction = { id: string; name: string; color: string };
 type Tile = {
   id: string;
   q: number;
   r: number;
   ownerFaction: string;
   control: number;
   isCapital: boolean;
publicTroops?: number; // from server: sum of all players' troops on this tile
 };
type World = { tiles: Record<string, Tile>; factions: Faction[]; capitalsByFaction: Record<string, string> };

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || "http://localhost:8787";

function bannerFor(fid?: string) {
  if (!fid || fid === "neutral") return "/banners/banner_neutral.png";
  return `/banners/banner_${fid}.png`; // fid is f1..f5
}

function axialToPixel(q: number, r: number, size = 16) {
  const x = size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const y = size * (1.5 * r);
  return { x, y };
}
function isNeighbor(a: Tile, b: Tile){
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
  return dirs.some(([dq,dr]) => a.q + dq === b.q && a.r + dr === b.r);
}
function byOwnerPriority(a: Tile, b: Tile){
  if (a.isCapital && !b.isCapital) return -1;
  if (!a.isCapital && b.isCapital) return 1;
  if (a.q!==b.q) return a.q-b.q;
  return a.r-b.r;
}
function hexPoints(cx:number, cy:number, size:number){
  const pts:[number,number][]=[];
  for(let i=0;i<6;i++){ const ang=Math.PI/180*(60*i+30); pts.push([cx+size*Math.cos(ang), cy+size*Math.sin(ang)]); }
  return pts;
}
function shade(hex:string, factor:number){
  const c=hex.replace('#',''); const r=parseInt(c.slice(0,2),16), g=parseInt(c.slice(2,4),16), b=parseInt(c.slice(4,6),16);
  return `rgb(${Math.floor(r*factor)}, ${Math.floor(g*factor)}, ${Math.floor(b*factor)})`;
}
const GOLD = "#facc15";

export default function App(){
  // Leaderboard state (INSIDE the component)
const [showLeaderboard, setShowLeaderboard] = useState(false);
const [playersOnline, setPlayersOnline] = useState<{id:string;name:string;factionId:string}[]>([]);

  const [socket, setSocket] = useState<Socket|null>(null);
  const [world, setWorld] = useState<World|null>(null);
  const [me, setMe] = useState<any>(null);

  const [name, setName] = useState(""); 
  const [nameCommitted, setNameCommitted] = useState(false);
  const [factionId, setFactionId] = useState<string>("");

  const [selectedTileId, setSelectedTileId] = useState<string|null>(null);
  const [mode, setMode] = useState<"idle"|"move"|"attack"|"deploy">("idle");
  const [amount, setAmount] = useState<number>(10);

  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{x:number,y:number}>({x:0,y:0});

  const [hoverTileId, setHoverTileId] = useState<string|null>(null);
  const [tooltipPos, setTooltipPos] = useState<{x:number,y:number}|null>(null);

  const svgRef = useRef<SVGSVGElement|null>(null);
  const containerRef = useRef<HTMLDivElement|null>(null);
  const panning = useRef(false);
  const lastPt = useRef<{x:number,y:number}|null>(null);
  const capitalsRef = useRef<Record<string,string>|null>(null);

  // Persistence
  useEffect(() => {
    try {
      const n = localStorage.getItem("fp_name") || "";
      const f = localStorage.getItem("fp_faction") || "";
      if (n) { setName(n); setNameCommitted(true); }
      if (f) { setFactionId(f); }
    } catch {}
  }, []);

  // Connection
  useEffect(() => {
    const s = io(SERVER_URL, { transports: ["websocket"] });
    setSocket(s); (window as any).socket = s;
    s.on("world", (w:World) => { setWorld(w); capitalsRef.current = w.capitalsByFaction;
    s.on("players_online", (list:any[]) => setPlayersOnline(list || []));

      try { const n = localStorage.getItem("fp_name"), f = localStorage.getItem("fp_faction"); if (n && f) s.emit("join", { name:n, factionId:f }); } catch {}
    });
    s.on("joined", (payload:any) => {
      setMe(payload.me);
      const fid = payload.me?.factionId;
      const cap = capitalsRef.current ? capitalsRef.current[fid] : null;
      if (cap) setSelectedTileId(cap);
    });
    s.on("me_update", (m:any) => { setMe((prev:any) => ({ ...prev, ...m })); });
    s.on("tile_update", ({ tile }:any) => setWorld(prev => prev ? { ...prev, tiles: { ...prev.tiles, [tile.id]: tile } } : prev));
    s.on("combat_result", ({ targetId }:any) => { setSelectedTileId(targetId); });
    s.on("session_error", ({ message }:any) => alert(message));
    s.on("error_msg", ({ message }:any) => alert(message));
    return () => { s.disconnect(); };
  }, []);

  const tiles = useMemo(() => world ? Object.values(world.tiles).sort(byOwnerPriority) : [], [world]);
  const factions = world?.factions || [];
  const selected = selectedTileId ? world?.tiles[selectedTileId] : null;

  function colorOf(fid:string){ return (world?.factions.find(f => f.id===fid)?.color) || (fid==="neutral" ? "#ffffff" : "#334155"); }
  function factionName(fid:string){ return (world?.factions.find(f => f.id===fid)?.name) || (fid==="neutral" ? "Neutral" : fid); }
  const myTroopsAt = (tileId:string) => (me?.troops?.[tileId] || 0);
  const defenders = (t:Tile) => t.control;
  const totalVisibleTroops = (t: Tile) => (defenders(t) + (t.publicTroops || 0));

  // Camera
  const baseBox = useMemo(() => {
    if (!tiles.length) return {cx:0,cy:0,w:1600,h:1600};
    const pts = tiles.map(t => axialToPixel(t.q, t.r));
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs) - 60, maxX = Math.max(...xs) + 60;
    const minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 60;
    return { cx:(minX+maxX)/2, cy:(minY+maxY)/2, w: (maxX-minX), h: (maxY-minY) };
  }, [tiles]);
  const viewBox = useMemo(() => {
    const w = baseBox.w / zoom, h = baseBox.h / zoom;
    return `${baseBox.cx - w/2 + pan.x} ${baseBox.cy - h/2 + pan.y} ${w} ${h}`;
  }, [baseBox, zoom, pan]);

  function onWheel(e: React.WheelEvent){
    e.preventDefault();
    const delta = -e.deltaY;
    const factor = delta > 0 ? 1.1 : 0.9;
    setZoom(z => Math.min(5, Math.max(0.3, z * factor)));
  }
  function clientPointToSvg(e: MouseEvent | React.MouseEvent) {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = (e as any).clientX; pt.y = (e as any).clientY;
    const m = svg.getScreenCTM();
    if (!m) return {x:0,y:0};
    const inv = m.inverse();
    const sp = pt.matrixTransform(inv);
    return { x: sp.x, y: sp.y };
  }
  function onMouseDown(e: React.MouseEvent){
    if (e.button === 1) { panning.current = true; lastPt.current = clientPointToSvg(e); }
  }
  function onMouseMove(e: React.MouseEvent){
    if (!panning.current) return;
    const curr = clientPointToSvg(e);
    const last = lastPt.current;
    if (last){
      const dx = last.x - curr.x;
      const dy = last.y - curr.y;
      setPan(p => ({ x: p.x + dx, y: p.y + dy }));
      lastPt.current = curr;
    }
  }
  function onMouseUp(){ panning.current = false; lastPt.current = null; }
  useEffect(() => {
    function onKey(e: KeyboardEvent){
      const step = 30 / zoom;
      if (e.key === "ArrowUp") setPan(p => ({...p, y: p.y - step}));
      if (e.key === "ArrowDown") setPan(p => ({...p, y: p.y + step}));
      if (e.key === "ArrowLeft") setPan(p => ({...p, x: p.x - step}));
      if (e.key === "ArrowRight") setPan(p => ({...p, x: p.x + step}));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  // Eligibility + paths
  const deployEligible = useMemo(() => {
    if (mode!=="deploy" || !me || !world) return new Set<string>();
    const owner = me.factionId;
    const capId = world.capitalsByFaction[owner];
    const eligible = new Set<string>(), seen = new Set<string>([capId]);
    const q = [capId];
    while (q.length){
      const id = q.shift()!;
      eligible.add(id);
      const t = world.tiles[id];
      for (const [dq,dr] of [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]] as [number,number][]){
        const nid = `${t.q+dq},${t.r+dr}`;
        const nt = world.tiles[nid];
        if (!nt || nt.ownerFaction !== owner) continue;
        if (!seen.has(nid)){ seen.add(nid); q.push(nid); }
      }
    }
    return eligible;
  }, [mode, me, world]);

  function findFriendlyPath(fromId: string, toId: string): string[] | null {
    if (!me || !world) return null;
    if (fromId === toId) return [fromId];
    const owner = me.factionId;
    const graph = new Map<string, string[]>();
    for (const t of Object.values(world.tiles)){
      if (t.ownerFaction !== owner) continue;
      const nbrs = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[ -1,1 ]]
        .map(([dq,dr]) => `${t.q+dq},${t.r+dr}`)
        .filter(id => world.tiles[id]?.ownerFaction === owner);
      graph.set(t.id, nbrs);
    }
    if (!graph.has(fromId) || !graph.has(toId)) return null;
    const q=[fromId]; const prev = new Map<string,string|null>(); prev.set(fromId, null);
    while(q.length){
      const cur = q.shift()!;
      if (cur === toId) break;
      for (const nb of (graph.get(cur)||[])){
        if (!prev.has(nb)){ prev.set(nb, cur); q.push(nb); }
      }
    }
    if (!prev.has(toId)) return null;
    const pathIds:string[]=[]; let cur=toId;
    while(cur){ pathIds.push(cur); cur = prev.get(cur)!; }
    pathIds.reverse();
    return pathIds;
  }
  function chainMove(pathIds: string[], amt: number){
    if (!socket || !me || !world) return;
    if (pathIds.length < 2) return;
    let fromId = pathIds[0];
    for (let i=1;i<pathIds.length;i++){
      const toId = pathIds[i];
      (window as any).socket?.emit("move", { fromId, toId, amount: amt });
      fromId = toId;
    }
  }

  // Tooltip placement
  function updateTooltipForTile(t: Tile, clientX?:number, clientY?:number){
    if (!svgRef.current || !containerRef.current) return;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const vb = viewBox.split(" ").map(Number);
    const [vx, vy, vw, vh] = vb;
    const { x, y } = axialToPixel(t.q, t.r, 16);
    const sx = (x - vx) * (rect.width / vw) + rect.left;
    const sy = (y - vy) * (rect.height / vh) + rect.top;
    const crect = containerRef.current.getBoundingClientRect();
    setTooltipPos({ x: (clientX ?? sx) - crect.left + 12, y: (clientY ?? sy) - crect.top - 8 });
  }
  useEffect(() => {
    if (!hoverTileId) return;
    const t = world?.tiles[hoverTileId]; if (!t) return;
    updateTooltipForTile(t);
  }, [hoverTileId, viewBox, world]);

  // Click handling
  function handleTileClick(t: Tile){
    const selected = selectedTileId ? world?.tiles[selectedTileId] : null;

    if (mode==="attack" && selected){
      if (!(isNeighbor(selected, t) && t.ownerFaction !== me.factionId && !t.isCapital)){
        alert("There is no adjacent enemy tile. Move your troops to the front line first.");
        return;
      }
      if (!me){ alert("Join a faction first."); return; }
      if (amount < 1){ alert("Set an amount to attack with."); return; }
      (window as any).socket?.emit("attack", { fromId: selected.id, targetId: t.id, amount });
      setMode("idle");
      return;
    }
    if (mode==="move" && selected){
      const path = findFriendlyPath(selected.id, t.id);
      if (!path || path.length < 2){
        alert("No friendly path to that tile. Choose another destination.");
        return;
      }
      chainMove(path, amount);
      setMode("idle");
      return;
    }
    if (mode==="deploy" && me){
      if (!deployEligible.has(t.id)){
        alert("Pick a tile connected to your capital.");
        return;
      }
      const useAmt = Math.min(amount, me.inventory||0);
      if (useAmt < 1){ alert("No inventory troops to deploy."); return; }
      (window as any).socket?.emit("deploy", { targetId: t.id, amount: useAmt });
      setMode("idle");
      return;
    }
    setSelectedTileId(t.id);
  }

  // Borders
  const borderSegments = useMemo(() => {
    const segments: { key:string; color:string; a:[number,number]; b:[number,number] }[] = [];
    const sz = 14;
    const tilesById = new Map(tiles.map(t => [t.id, t]));
    for (const t of tiles){
      const owner = t.ownerFaction;
      const { x, y } = axialToPixel(t.q, t.r, 16);
      const corners = hexPoints(x, y, sz);
      const nbrCoords = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
      for (let i=0;i<6;i++){
        const [dq,dr] = nbrCoords[i];
        const nb = tilesById.get(`${t.q+dq},${t.r+dr}`);
        if (!nb || nb.ownerFaction !== owner){
          const a = corners[i];
          const b = corners[(i+1)%6];
          segments.push({ key: `${t.id}:${i}`, color: colorOf(owner), a, b });
        }
      }
    }
    return segments;
  }, [tiles, factions]);

  function kFont(){ return 1 / Math.pow(zoom, 0.25); }

  // Render
  return (
    <div className="grid">
      <div className="col" style={{ padding: 12 }}>
        <div className="card">
          <div className="title">Ringsel Holo Wars</div>
          <div className="hint">Dominate the map for your Oshis</div>
        </div>
<div className="row" style={{ marginTop: 8, gap: 8 }}>
  <button className="btn" onClick={()=>setShowLeaderboard(true)}>Leaderboard</button>
</div>
        {!me && (
          <div className="card" style={{ marginTop: 12 }}>
            <div className="col" style={{ flex: 1 }}>
              <label>Name</label>
              <input value={name} onChange={e=>{ setName(e.target.value); setNameCommitted(!!e.target.value.trim()); }} placeholder="Your name" />
              <label>Faction</label>
              <select value={factionId} onChange={e => setFactionId(e.target.value)} disabled={!nameCommitted}>
                <option value="">Select Faction</option>
                {(world?.factions||[]).map(f => (<option key={f.id} value={f.id}>{f.name}</option>))}
              </select>
              {!nameCommitted && <div className="hint">Enter your name to unlock faction pick.</div>}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={()=>{
                if (!nameCommitted || !name.trim()) { alert("Please enter your name first."); return; }
                if (!factionId){ alert("Pick a faction."); return; }
                try { localStorage.setItem("fp_name", name.trim()); localStorage.setItem("fp_faction", factionId); } catch {}
                (window as any).socket?.emit("join", { name: name.trim(), factionId });
              }}>Join</button>
            </div>
          </div>
        )}

{/* Faction Banner (above Recruitment) */}
<div className="card" style={{ marginTop: 12, padding: 8 }}>
  {(() => {
    // Show banner for the currently selected tile's owner;
    // if nothing selected, fall back to your own faction (if joined); else neutral.
    const owner =
      (selected ? selected.ownerFaction : (me?.factionId || "neutral"));
    const src = bannerFor(owner);
    return (
      <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
        <img
          src={src}
          alt="Faction banner"
          style={{
            width: "100%",
            maxWidth: 800,        // caps width on large screens
            height: "auto",
            maxHeight: 96,        // keep it compact
            objectFit: "contain",
            imageRendering: "auto",
            borderRadius: 8
          }}
        />
      </div>
    );
  })()}
</div>

        {me && (
          <div className="card" style={{ marginTop: 12 }}>
            <div className="title">Recruitment</div>
            <div className="row" style={{ justifyContent:'space-between' }}>
              <div className="muted">Timer</div>
              {(() => { const remainingMs = me?.remainingMs ?? (me?.recruitDurationMs ?? 300000); const mm = String(Math.floor(remainingMs/60000)).padStart(2,'0'); const ss = String(Math.floor((remainingMs%60000)/1000)).padStart(2,'0'); return <div style={{ fontWeight: 700 }}>{mm}:{ss}</div>; })()}
            </div>
            <div className="row" style={{ justifyContent:'space-between' }}>
              <div className="muted">Recovering</div>
              <div style={{ fontWeight: 700 }}>{me?.produced ?? 0}/{me?.reserveCap ?? 1000}</div>
            </div>
            <progress max={me?.reserveCap ?? 1000} value={me?.produced ?? 0} />
            <div className="hint">{(((me?.reserveCap ?? 1000)/((me?.recruitDurationMs ?? 300000)/1000))).toFixed(1)} troops/sec</div>
            <div className="row" style={{ justifyContent:'space-between', marginTop: 8 }}>
              <div className="row" style={{ gap:6, alignItems:'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#e5e7eb" d="M3 7l9-4l9 4v10l-9 4l-9-4V7zm9 2l7-3l-7-3l-7 3l7 3zm-7 2v6l7 3v-6l-7-3zm9 9l7-3v-6l-7 3v6z"/></svg>
                <div className="muted">Inventory</div>
              </div>
              <div style={{ fontWeight: 700 }}>{me?.inventory ?? 0}</div>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap:'wrap' }}>
              <button className="btn" onClick={()=>{ (window as any).socket?.emit('recruit_collect'); }} disabled={(me?.produced ?? 0) < 1}>Send to Inventory</button>
              <button className="btn" onClick={()=>{ if ((me?.inventory ?? 0) < 1){ alert('No inventory to deploy.'); return; } setMode('deploy'); }} disabled={(me?.inventory ?? 0) < 1}>Deploy</button>
              {(mode==='deploy') && <button className="btn" onClick={()=>setMode('idle')}>Cancel</button>}
            </div>
            {mode==='deploy' && (
              <div className="col" style={{ gap: 4, marginTop: 8 }}>
                <div className="row" style={{ justifyContent:'space-between' }}>
                  <div className="muted">Amount</div>
                  <span>{Math.min(amount, me?.inventory || 0)}</span>
                </div>
                <input type="range" min={1} max={Math.max(1, me?.inventory || 1)} value={Math.min(amount, Math.max(1, me?.inventory || 1))} onChange={e => setAmount(+e.target.value)} />
                <div className="hint">Click a capital-connected tile to deploy. Blue path shows the route from your capital.</div>
              </div>
            )}
          </div>
        )}

        <div className="card" style={{ marginTop: 12 }}>
          <div className="title">Action</div>
          {!selected && <div className="hint">Click a tile to select. Scroll to zoom. Middle mouse / arrows to pan.</div>}
          {selected && (
            <div className="col" style={{ gap: 8 }}>
              <div className="row" style={{ justifyContent:'space-between' }}>
                <div className="muted">Tile</div><code>{selected.id}</code>
              </div>
              <div className="row" style={{ justifyContent:'space-between' }}>
                <div className="muted">Owner</div>
                <span className="badge" style={{ borderColor: colorOf(selected.ownerFaction), color: colorOf(selected.ownerFaction) }}>{factionName(selected.ownerFaction)}</span>
              </div>

              {!(selected && me && selected.ownerFaction === me.factionId) ? (
                <div className="row" style={{ justifyContent:'space-between' }}>
                  <div className="muted">Defender</div>
                  <span style={{ color: colorOf(selected.ownerFaction), fontWeight: 700 }}>{defenders(selected!)}</span>
                </div>
              ) : (
                <>
                  <div className="row" style={{ justifyContent:'space-between' }}>
                    <div className="muted">Defender</div>
                    <span style={{ color: colorOf(selected.ownerFaction), fontWeight: 700 }}>{defenders(selected)}</span>
                  </div>
                  <div className="row" style={{ justifyContent:'space-between' }}>
                    <div className="muted">Your Troops Here</div>
                    <span style={{ color: "#ffffff", fontWeight: 700 }}>{myTroopsAt(selected.id)}</span>
                  </div>
                  <div className="col" style={{ gap: 4, marginTop: 8 }}>
                    <div className="row" style={{ justifyContent:'space-between' }}>
                      <div className="muted">Amount</div>
                      <span>{amount}</span>
                    </div>
                    <input type="range" min={1} max={Math.max(1, myTroopsAt(selected.id))} value={Math.min(amount, Math.max(1, myTroopsAt(selected.id)))} onChange={e => setAmount(+e.target.value)} />
                    <div className="hint">Drag to choose how many troops to use.</div>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn" onClick={()=>{
                      if (!me){ alert("Join a faction first."); return; }
                      if (myTroopsAt(selected.id) < 1){ alert("No troops to move from this tile."); return; }
                      setMode("move");
                    }} disabled={myTroopsAt(selected.id) < 1}>Move</button>
                    <button className="btn" onClick={()=>{
                      if (!me){ alert("Join a faction first."); return; }
                      if (myTroopsAt(selected.id) < 1){ alert("No troops here to attack with."); return; }
                      const neighbors = tiles.filter(t => isNeighbor(selected, t));
                      const eligible = neighbors.filter(n => n.ownerFaction !== me.factionId && !n.isCapital);
                      if (eligible.length === 0){
                        alert("There is no adjacent enemy tile. Move your troops to the front line first.");
                        return;
                      }
                      setMode("attack");
                    }} disabled={myTroopsAt(selected.id) < 1}>Attack</button>
                    {(mode!=="idle") && <button className="btn" onClick={()=>setMode("idle")}>Cancel</button>}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: 12, position:'relative' }} ref={containerRef}>
        <div className="card" style={{ height: "100%" }}>
          <div className="banner">Scroll to zoom. Middle mouse or arrow keys to pan. Hover for tooltips. Deploy shows arrow path from capital.</div>
          <svg ref={svgRef} viewBox={viewBox} style={{ width: "100%", height: "calc(100vh - 140px)", background: "#0a0f1a", borderRadius: 12, border: "1px solid #1f2937" }}
               onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
            {tiles.map((t) => {
              const { x, y } = axialToPixel(t.q, t.r, 16);
              const sz = 14;
              const points = hexPoints(x, y, sz).map(p => p.join(",")).join(" ");
              const isSel = selectedTileId === t.id;
              const ownerColor = colorOf(t.ownerFaction);
              const baseFill = t.ownerFaction === "neutral" ? "#ffffff" : shade(ownerColor, 0.85);
              const fillColor = (me?.troops?.[t.id] > 0) ? shade(t.ownerFaction === "neutral" ? "#ffffff" : ownerColor, 1.3) : baseFill;
              const strokeColor = isSel ? "#fff" : shade(ownerColor, 0.5);
              const dimAttack = (mode==="attack" && selectedTileId!==t.id && !(selected && isNeighbor(selected, t) && t.ownerFaction !== me?.factionId && !t.isCapital));
              const dimMove = (mode==="move" && (! (me && t.ownerFaction === me.factionId)));
              const dimDeploy = (mode==="deploy" && (!deployEligible.has(t.id)));
              const dim = dimAttack || dimMove || dimDeploy;
              const k = 1 / Math.pow(zoom, 0.25);
              return (
                <g key={t.id} onMouseEnter={(e)=>{ setHoverTileId(t.id); updateTooltipForTile(t, e.clientX, e.clientY);} } onMouseLeave={()=>setHoverTileId(prev => prev===t.id?null:prev)}
                   onClick={() => handleTileClick(t)} style={{ cursor: "pointer", opacity: dim ? 0.25 : 1 }}>
                  <polygon points={points} fill={fillColor} stroke={strokeColor} strokeWidth={isSel ? 2.0 : 1.0} />
                  {t.isCapital && (<polygon points={starPoints(x, y, 8, 4)} fill={GOLD} stroke="#fff" strokeWidth={0.8} />)}
                  <text x={x} y={y - 2} textAnchor="middle" fontSize={9.5 * 0.8 * k} fill="#ffffff" style={{ fontWeight: 700 }}>{myTroopsAt(t.id) || ""}</text>
                  <text x={x} y={y + 7} textAnchor="middle" fontSize={9.5 * k} fill="#0b0f1a" style={{ fontWeight: 800 }}>{totalVisibleTroops(t)}</text>
                </g>
              );
            })}
            <g opacity={0.5}>
              {borderSegments.map((seg, idx) => {
                const sw = Math.max(0.6, 1.2 / Math.pow(zoom, 0.5));
                return <line key={seg.key + ":" + idx} x1={seg.a[0]} y1={seg.a[1]} x2={seg.b[0]} y2={seg.b[1]} stroke={seg.color} strokeWidth={sw} />;
              })}
            </g>
            {mode==="deploy" && me && (()=>{
              const capId = world?.capitalsByFaction[me.factionId];
              if (!capId || !hoverTileId) return null;
              if (!deployEligible.has(hoverTileId)) return null;
              const path = findFriendlyPath(capId, hoverTileId);
              if (!path || path.length < 2) return null;
              const pts = path.map(id => { const t = world!.tiles[id]; const p = axialToPixel(t.q, t.r, 16); return `${p.x},${p.y}`; }).join(" ");
              return <polyline points={pts} fill="none" stroke="#3b82f6" strokeWidth={2.0} markerEnd="url(#arrow2)"/>;
            })()}
            <defs>
              <marker id="arrow2" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill="#3b82f6" />
              </marker>
            </defs>
          </svg>

          {(hoverTileId && tooltipPos) && (()=>{
            const t = world!.tiles[hoverTileId!];
            return (
              <div className="tooltip" style={{ left: tooltipPos.x, top: tooltipPos.y }}>
                <div><strong>{t.id}</strong></div>
                <div>Owner: <span style={{ color: colorOf(t.ownerFaction) }}>{factionName(t.ownerFaction)}</span></div>
                <div>Defender: <strong style={{ color: colorOf(t.ownerFaction) }}>{defenders(t)}</strong></div>
                <div>Your troops: <strong>{myTroopsAt(t.id)}</strong></div>
                {t.isCapital && <div>Capital</div>}
              </div>
            );
          })()}
        </div>
      </div>
      {/* Leaderboard Modal */}
{showLeaderboard && (
  <div
    style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000
    }}
    onClick={()=>setShowLeaderboard(false)}
  >
    <div
      className="card"
      style={{
        width: "min(900px, 92vw)",
        maxHeight: "80vh",
        overflow: "auto",
        padding: 16,
        cursor: "default"
      }}
      onClick={e=>e.stopPropagation()}
    >
      <div className="row" style={{ justifyContent:"space-between", alignItems:"center" }}>
        <div className="title">Leaderboard</div>
        <button className="btn" onClick={()=>setShowLeaderboard(false)}>Close</button>
      </div>

      {(() => {
        // group players by factionId
        const byFaction: Record<string, {id:string;name:string;factionId:string}[]> = {};
        for (const p of playersOnline) {
          if (!byFaction[p.factionId]) byFaction[p.factionId] = [];
          byFaction[p.factionId].push(p);
        }

        // ensure consistent faction order (f1..f5, then any others)
        const order = (world?.factions || []).map(f => f.id);
        const allIds = Array.from(new Set([...order, ...Object.keys(byFaction)]));

        return (
          <div className="col" style={{ gap: 12, marginTop: 12 }}>
            {allIds.map(fid => {
              const list = byFaction[fid] || [];
              // Sort players by name
              list.sort((a,b) => a.name.localeCompare(b.name));
              const color = (world?.factions.find(f=>f.id===fid)?.color) || "#9ca3af";
              const label = factionName(fid);

              return (
                <div key={fid} className="col" style={{ gap: 8, padding: 8, border: "1px solid #1f2937", borderRadius: 8 }}>
                  <div className="row" style={{ gap: 8, alignItems:"center" }}>
                    <span className="badge" style={{ borderColor: color, color }}>{label}</span>
                    <span className="muted">({list.length} player{list.length===1?"":"s"})</span>
                  </div>
                  {list.length === 0 ? (
                    <div className="muted" style={{ marginLeft: 2 }}>No players yet.</div>
                  ) : (
                    <div className="row" style={{ flexWrap:"wrap", gap: 8 }}>
                      {list.map(p => (
                        <div key={p.id} className="badge" style={{ borderColor: color, color }}>
                          {p.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  </div>
)}

    </div>
  );
}

function starPoints(cx:number, cy:number, outer:number, inner:number){
  const pts: string[] = [];
  const spikes = 5;
  let rot = Math.PI / 2 * 3;
  for (let i = 0; i < spikes; i++) {
    let x = cx + Math.cos(rot) * outer;
    let y = cy + Math.sin(rot) * outer;
    pts.push(`${x},${y}`);
    rot += Math.PI / spikes;
    x = cx + Math.cos(rot) * inner;
    y = cy + Math.sin(rot) * inner;
    pts.push(`${x},${y}`);
    rot += Math.PI / spikes;
  }
  return pts.join(" ");
}
