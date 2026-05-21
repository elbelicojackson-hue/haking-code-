/**
 * Haking Wiki — D3 force-directed graph + WebSocket client.
 *
 * State machine:
 *   1. Open WS, on 'snapshot' message build initial graph
 *   2. Apply each subsequent 'delta' to the in-memory model and update
 *      D3 simulation in-place (avoids full restart-on-every-change)
 *   3. On user actions: search / crawl / select / drag → fire WS or REST
 */

const COLORS = {
  page:    '#00fff7',
  cve:     '#ff2d95',
  tool:    '#ff6b35',
  concept: '#a855f7',
  host:    '#5769f7',
  note:    '#00ff88',
};

const KIND_LABEL = {
  page: 'Page', cve: 'CVE', tool: 'Tool',
  concept: 'Concept', host: 'Host', note: 'Note',
};

// ---------- DOM refs ----------
const svg          = d3.select('#graphSvg');
const statusEl     = document.getElementById('status');
const statusText   = document.getElementById('statusText');
const searchInput  = document.getElementById('searchInput');
const crawlUrlEl   = document.getElementById('crawlUrl');
const crawlBtn     = document.getElementById('crawlBtn');
const legendEl     = document.getElementById('legend');
const nodeCountEl  = document.getElementById('nodeCount');
const edgeCountEl  = document.getElementById('edgeCount');
const toastEl      = document.getElementById('toast');
const rightBall    = document.getElementById('rightBall');
const rightTitle   = document.getElementById('rightTitle');
const rightMeta    = document.getElementById('rightMeta');
const rightSource  = document.getElementById('rightSource');
const rightBody    = document.getElementById('rightBody');

// ---------- Legend (static; reflects COLORS) ----------
legendEl.innerHTML = Object.entries(KIND_LABEL).map(([k, label]) =>
  `<div class="row"><span class="ball" style="--c:${COLORS[k]}"></span>${label}</div>`
).join('');

// ---------- D3 graph state ----------
let nodesArr = [];
let edgesArr = [];
const nodeIndex = new Map();   // id -> node ref
const edgeIndex = new Map();   // id -> edge ref
let selectedId = null;
let searchHits = new Set();    // ids of search-matched nodes

const width  = () => document.querySelector('.canvas').clientWidth;
const height = () => document.querySelector('.canvas').clientHeight;

// Layered groups so edges always sit beneath nodes.
const gEdges = svg.append('g').attr('class', 'edges-layer');
const gNodes = svg.append('g').attr('class', 'nodes-layer');

const sim = d3.forceSimulation()
  .force('link', d3.forceLink().id(d => d.id).distance(80).strength(0.25))
  .force('charge', d3.forceManyBody().strength(-220))
  .force('center', d3.forceCenter().x(() => width() / 2).y(() => height() / 2))
  .force('collide', d3.forceCollide().radius(22))
  .on('tick', ticked);

window.addEventListener('resize', () => {
  sim.force('center').x(width() / 2).y(height() / 2);
  sim.alpha(0.3).restart();
});

// ---------- Render ----------

function ticked() {
  gEdges.selectAll('line.edge')
    .attr('x1', d => d.source.x)
    .attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x)
    .attr('y2', d => d.target.y);

  gNodes.selectAll('g.node')
    .attr('transform', d => `translate(${d.x},${d.y})`);
}

function drawAll() {
  // Edges
  const edgeSel = gEdges.selectAll('line.edge')
    .data(edgesArr, d => d.id);
  edgeSel.exit().remove();
  edgeSel.enter()
    .append('line')
    .attr('class', 'edge')
    .merge(edgeSel);

  // Nodes
  const nodeSel = gNodes.selectAll('g.node')
    .data(nodesArr, d => d.id);
  nodeSel.exit().remove();
  const nodeEnter = nodeSel.enter()
    .append('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', dragStart)
      .on('drag', dragged)
      .on('end', dragEnd))
    .on('click', (event, d) => { event.stopPropagation(); selectNode(d.id); })
    .on('dblclick', (event, d) => { event.stopPropagation(); injectToTerminal(d.id); });

  nodeEnter.append('circle')
    .attr('r', d => d.kind === 'page' ? 9 : 7)
    .attr('fill', d => COLORS[d.kind] || '#888')
    .style('filter', d => `drop-shadow(0 0 6px ${COLORS[d.kind] || '#888'}88)`);

  nodeEnter.append('text')
    .attr('dy', 22)
    .text(d => truncate(d.title, 20));

  nodeEnter.append('title')
    .text(d => `${d.title}\n${d.kind}\n${d.summary || ''}`);

  // Update existing classes (selection / search hits)
  gNodes.selectAll('g.node')
    .classed('selected', d => d.id === selectedId)
    .classed('search-hit', d => searchHits.has(d.id));

  sim.nodes(nodesArr);
  sim.force('link').links(edgesArr);
  sim.alpha(0.5).restart();

  nodeCountEl.textContent = nodesArr.length;
  edgeCountEl.textContent = edgesArr.length;
}

function truncate(s, n) {
  return (s || '').length <= n ? s : s.slice(0, n - 1) + '…';
}

// ---------- Drag handlers ----------

function dragStart(event, d) {
  if (!event.active) sim.alphaTarget(0.3).restart();
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
function dragEnd(event, d) {
  if (!event.active) sim.alphaTarget(0);
  d.fx = null; d.fy = null;
}

// ---------- Selection / right panel ----------

async function selectNode(id) {
  selectedId = id;
  drawAll();
  const n = nodeIndex.get(id);
  if (!n) return;
  rightBall.style.background = COLORS[n.kind] || '#888';
  rightBall.style.boxShadow = `0 0 8px ${COLORS[n.kind] || '#888'}`;
  rightTitle.textContent = n.title;
  rightMeta.textContent = `[${KIND_LABEL[n.kind] || n.kind}]`;
  if (n.url) {
    rightSource.style.display = '';
    rightSource.href = n.url;
  } else {
    rightSource.style.display = 'none';
  }

  rightBody.innerHTML = '<div class="empty">loading…</div>';
  try {
    const res = await fetch('/pages/' + encodeURIComponent(id));
    const md = await res.text();
    rightBody.innerHTML = marked.parse(md);
  } catch (err) {
    rightBody.innerHTML = '<div class="empty">failed to load body</div>';
  }
}

// click on empty canvas → deselect
svg.on('click', () => {
  selectedId = null;
  drawAll();
  rightTitle.textContent = '— No node selected —';
  rightMeta.textContent = '';
  rightSource.style.display = 'none';
  rightBall.style.background = '#888';
  rightBall.style.boxShadow = 'none';
  rightBody.innerHTML = '<div class="empty">点击左侧图谱节点查看详情<br>或在上方搜索 / 添加 URL</div>';
});

// ---------- WebSocket ----------

let ws;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener('open', () => {
    statusEl.classList.replace('disconnected', 'connected');
    statusText.textContent = 'connected';
  });
  ws.addEventListener('close', () => {
    statusEl.classList.replace('connected', 'disconnected');
    statusText.textContent = 'disconnected';
    setTimeout(connect, 2000);
  });
  ws.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleServerMessage(msg);
  });
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'snapshot':
      hydrateSnapshot(msg.snapshot);
      break;
    case 'delta':
      applyDelta(msg.delta);
      break;
    case 'crawl:start':
      toast(`crawling ${msg.url}…`);
      break;
    case 'crawl:done':
      toast(`✓ ${msg.title}`);
      break;
    case 'crawl:error':
      toast(`✗ ${msg.error}`, true);
      break;
    case 'search:result':
      applySearchResult(msg.q, msg.hits);
      break;
    case 'error':
      toast(msg.error, true);
      break;
    case 'pong':
      break;
  }
}

function hydrateSnapshot(snap) {
  nodesArr = (snap.nodes || []).map(n => ({ ...n }));
  edgesArr = (snap.edges || []).map(e => ({ ...e }));
  nodeIndex.clear();
  edgeIndex.clear();
  for (const n of nodesArr) nodeIndex.set(n.id, n);
  for (const e of edgesArr) edgeIndex.set(e.id, e);
  drawAll();
}

function applyDelta(delta) {
  switch (delta.type) {
    case 'node:add': {
      if (!nodeIndex.has(delta.node.id)) {
        const n = { ...delta.node };
        nodesArr.push(n);
        nodeIndex.set(n.id, n);
      }
      break;
    }
    case 'node:update': {
      const ex = nodeIndex.get(delta.node.id);
      if (ex) Object.assign(ex, delta.node);
      else {
        const n = { ...delta.node };
        nodesArr.push(n);
        nodeIndex.set(n.id, n);
      }
      break;
    }
    case 'node:remove': {
      const idx = nodesArr.findIndex(n => n.id === delta.id);
      if (idx >= 0) nodesArr.splice(idx, 1);
      nodeIndex.delete(delta.id);
      // Drop dangling edges (server already does this; we mirror locally
      // for resilience if the edge:remove arrives in a different order).
      for (let i = edgesArr.length - 1; i >= 0; i--) {
        const e = edgesArr[i];
        const sId = typeof e.source === 'string' ? e.source : e.source?.id;
        const tId = typeof e.target === 'string' ? e.target : e.target?.id;
        if (sId === delta.id || tId === delta.id) {
          edgeIndex.delete(e.id);
          edgesArr.splice(i, 1);
        }
      }
      if (selectedId === delta.id) selectedId = null;
      break;
    }
    case 'edge:add': {
      if (!edgeIndex.has(delta.edge.id)) {
        const e = { ...delta.edge };
        edgesArr.push(e);
        edgeIndex.set(e.id, e);
      }
      break;
    }
    case 'edge:remove': {
      const idx = edgesArr.findIndex(e => e.id === delta.id);
      if (idx >= 0) edgesArr.splice(idx, 1);
      edgeIndex.delete(delta.id);
      break;
    }
    case 'snapshot':
      hydrateSnapshot(delta.snapshot);
      return;
  }
  drawAll();
}

// ---------- Search ----------

let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) {
    searchHits.clear();
    drawAll();
    return;
  }
  searchDebounce = setTimeout(() => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'search', q, limit: 50 }));
    }
  }, 180);
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    searchHits.clear();
    drawAll();
  } else if (e.key === 'Enter') {
    // Jump to the first hit if any.
    const first = [...searchHits][0];
    if (first) selectNode(first);
  }
});

function applySearchResult(q, hits) {
  if (q !== searchInput.value.trim()) return; // stale
  searchHits = new Set(hits.map(h => h.id));
  drawAll();
}

// ---------- Crawl ----------

crawlBtn.addEventListener('click', () => {
  const url = crawlUrlEl.value.trim();
  if (!url) return;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'crawl', url }));
    crawlUrlEl.value = '';
  } else {
    toast('not connected', true);
  }
});
crawlUrlEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') crawlBtn.click();
});

// ---------- Toast ----------

let toastTimer;
function toast(text, isError = false) {
  toastEl.textContent = text;
  toastEl.classList.toggle('error', !!isError);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// ---------- Boot ----------

connect();

// Heartbeat ping so reverse-proxies don't idle-kill the WS.
setInterval(() => {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 25000);


// ---------- Inject to Terminal (double-click node) ----------

async function injectToTerminal(id) {
  const n = nodeIndex.get(id);
  if (!n) return;
  try {
    const res = await fetch('/pages/' + encodeURIComponent(id));
    const md = await res.text();
    // Build a context block that can be pasted directly into Haking Code
    const block = `[Wiki: ${n.title}]\n${md}`;
    await navigator.clipboard.writeText(block);
    toast(`✓ "${n.title}" 已复制 — 粘贴到终端作为上下文`);
  } catch (err) {
    toast('复制失败: ' + (err.message || err), true);
  }
}

// ---------- Chat (AI Q&A) ----------

const chatMessages = document.getElementById('chatMessages');
const chatInput    = document.getElementById('chatInput');
const chatSend     = document.getElementById('chatSend');
let currentAiBubble = null;

function appendChatMsg(cls, html) {
  const div = document.createElement('div');
  div.className = 'chat-msg ' + cls;
  div.innerHTML = html;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function sendAsk() {
  const q = chatInput.value.trim();
  if (!q) return;
  if (!ws || ws.readyState !== 1) { toast('not connected', true); return; }

  appendChatMsg('user', escapeHtml(q));
  chatInput.value = '';
  currentAiBubble = null;

  ws.send(JSON.stringify({ type: 'ask', question: q }));
}

chatSend.addEventListener('click', sendAsk);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAsk(); }
});

function handleAskMessage(msg) {
  switch (msg.type) {
    case 'ask:sources': {
      const links = (msg.sources || []).map(s =>
        s.url ? `<a href="${s.url}" target="_blank">[${escapeHtml(s.title)}]</a>`
              : `<span>[${escapeHtml(s.title)}]</span>`
      ).join(' ');
      if (!currentAiBubble) {
        currentAiBubble = appendChatMsg('ai', `<div class="sources">${links}</div><span class="ai-text"></span>`);
      } else {
        const srcDiv = currentAiBubble.querySelector('.sources');
        if (srcDiv) srcDiv.innerHTML = links;
      }
      break;
    }
    case 'ask:text': {
      if (!currentAiBubble) {
        currentAiBubble = appendChatMsg('ai', '<span class="ai-text"></span>');
      }
      const textEl = currentAiBubble.querySelector('.ai-text');
      if (textEl) textEl.textContent += msg.text;
      chatMessages.scrollTop = chatMessages.scrollHeight;
      break;
    }
    case 'ask:expanding':
      appendChatMsg('expanding', `🔍 搜索中: "${escapeHtml(msg.query)}"...`);
      break;
    case 'ask:expanded': {
      const names = (msg.newNodes || []).map(n => escapeHtml(n.title)).join(', ');
      appendChatMsg('expanding', `✓ 已爬取: ${names}`);
      break;
    }
    case 'ask:done':
      currentAiBubble = null;
      break;
    case 'ask:error':
      appendChatMsg('error', '✗ ' + escapeHtml(msg.error || 'unknown error'));
      currentAiBubble = null;
      break;
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Hook into the existing WS message handler
const _origHandleServerMessage = handleServerMessage;
handleServerMessage = function(msg) {
  if (msg.type && msg.type.startsWith('ask:')) {
    handleAskMessage(msg);
    return;
  }
  _origHandleServerMessage(msg);
};
