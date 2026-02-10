const state = {
  library: null,
  playlist: null
};

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

function el(id) { return document.getElementById(id); }

function trackLabel(track) {
  return `${track.title} — ${track.artist}${track.year ? ` (${track.year})` : ''}`;
}

function renderLibraryStatus() {
  if (!state.library) return;
  el('libraryStatus').textContent = `Tracks: ${state.library.trackCount || 0} (Generated: ${state.library.generatedAt || 'never'})`;
}

function createTrackReplacementSelect(tandaIndex, trackIndex) {
  const select = document.createElement('select');
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Replace track…';
  select.append(defaultOpt);

  (state.library?.tracks || []).forEach((track) => {
    const opt = document.createElement('option');
    opt.value = track.id;
    opt.textContent = `${track.style.toUpperCase()} | ${trackLabel(track)}`;
    select.append(opt);
  });

  select.addEventListener('change', async () => {
    if (!select.value || !state.playlist) return;
    const updated = await api(`/api/playlists/${state.playlist.id}/replace-track`, {
      method: 'POST',
      body: JSON.stringify({ tandaIndex, trackIndex, replacementTrackId: select.value })
    });
    state.playlist = updated;
    renderPlaylist();
  });

  return select;
}

function renderPlaylist() {
  const container = el('playlist');
  const meta = el('playlistMeta');
  container.innerHTML = '';
  meta.innerHTML = '';

  if (!state.playlist) {
    renderAgentDecisioning();
    return;
  }

  meta.innerHTML = `<strong>${state.playlist.name}</strong><br><small>${state.playlist.prompt || 'No custom prompt'}</small>`;

  state.playlist.tandas.forEach((tanda, tandaIndex) => {
    const tandaDiv = document.createElement('div');
    tandaDiv.className = 'tanda';

    const header = document.createElement('h3');
    const controls = document.createElement('span');

    const up = document.createElement('button');
    up.textContent = '↑';
    up.disabled = tandaIndex === 0;
    up.onclick = () => moveTanda(tandaIndex, tandaIndex - 1);

    const down = document.createElement('button');
    down.textContent = '↓';
    down.disabled = tandaIndex === state.playlist.tandas.length - 1;
    down.onclick = () => moveTanda(tandaIndex, tandaIndex + 1);

    const save = document.createElement('button');
    save.textContent = 'Save tanda';
    save.onclick = () => saveTanda(tandaIndex);

    controls.append(up, down, save);
    header.innerHTML = `Tanda ${tandaIndex + 1}: ${tanda.type.toUpperCase()}`;
    header.append(controls);
    tandaDiv.append(header);

    const reasoning = document.createElement('small');
    reasoning.textContent = tanda.reasoning;
    tandaDiv.append(reasoning);

    tanda.tracks.forEach((track, trackIndex) => {
      const row = document.createElement('div');
      row.className = 'track';

      const playBtn = document.createElement('button');
      playBtn.textContent = 'Play';
      playBtn.onclick = () => playTrack(track);

      const label = document.createElement('span');
      label.textContent = trackLabel(track);

      row.append(playBtn, label, createTrackReplacementSelect(tandaIndex, trackIndex));
      tandaDiv.append(row);
    });

    const cortina = state.playlist.cortinas[tandaIndex];
    const cortinaDiv = document.createElement('div');
    cortinaDiv.className = 'cortina';
    cortinaDiv.textContent = cortina ? `Cortina: ${trackLabel(cortina)}` : 'Cortina: (none selected)';
    if (cortina) {
      const playCortina = document.createElement('button');
      playCortina.textContent = 'Play cortina';
      playCortina.onclick = () => playTrack(cortina);
      cortinaDiv.append(playCortina);
    }

    tandaDiv.append(cortinaDiv);
    container.append(tandaDiv);
  });

  renderAgentDecisioning();
}

function renderAgentDecisioning() {
  const host = el('agentDecisioning');
  const playlist = state.playlist;

  if (!playlist) {
    host.innerHTML = '<small>Load or create a playlist to see why tandas and tracks were selected.</small>';
    return;
  }

  const debug = playlist.agentDebug || {};
  const decisionItems = (playlist.tandas || [])
    .map((tanda, index) => `<li><strong>Tanda ${index + 1} (${tanda.type.toUpperCase()}):</strong> ${tanda.reasoning || 'No reasoning provided.'}</li>`)
    .join('');

  const modelInfo = debug.enabled
    ? `${debug.model || 'Agent'}${debug.durationMs ? ` · ${debug.durationMs}ms` : ''}`
    : 'Fallback planner';

  host.innerHTML = `
    <div class="decision-meta">
      <div><strong>Selection source:</strong> ${playlist.generationSource || 'unknown'}</div>
      <div><strong>Planner:</strong> ${modelInfo}</div>
      <div><strong>Prompt guidance:</strong> ${playlist.prompt || 'No custom prompt'}</div>
      <div><small>${debug.reason || debug.validation || 'Agent response was used to create this set.'}</small></div>
    </div>
    <ol class="decision-list">${decisionItems}</ol>
  `;
}

async function moveTanda(fromIndex, toIndex) {
  const updated = await api(`/api/playlists/${state.playlist.id}/move-tanda`, {
    method: 'POST',
    body: JSON.stringify({ fromIndex, toIndex })
  });
  state.playlist = updated;
  renderPlaylist();
}

async function saveTanda(tandaIndex) {
  await api('/api/tanda-library', {
    method: 'POST',
    body: JSON.stringify({ playlistId: state.playlist.id, tandaIndex })
  });
  await loadTandaLibrary();
}

function playTrack(track) {
  const player = el('audioPlayer');
  player.src = `/api/audio/${encodeURIComponent(track.id)}`;
  player.play();
  el('nowPlaying').textContent = `Now playing: ${trackLabel(track)}`;
}

async function refreshLibrary() {
  state.library = await api('/api/library');
  renderLibraryStatus();
}

async function loadPlaylists() {
  const { playlists } = await api('/api/playlists');
  const select = el('playlistSelect');
  select.innerHTML = '';
  playlists.forEach((p) => {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = `${p.name} (${new Date(p.updatedAt).toLocaleString()})`;
    select.append(option);
  });
}

async function loadPlaylistById(id) {
  state.playlist = await api(`/api/playlists/${id}`);
  renderPlaylist();
}

async function loadTandaLibrary() {
  const { tandas } = await api('/api/tanda-library');
  const host = el('savedTandas');
  host.innerHTML = tandas.map((t) => `<div class="tanda"><strong>${t.name}</strong><br><small>${t.tanda.type} · ${t.tanda.tracks.length} tracks</small></div>`).join('') || '<small>No saved tandas yet.</small>';
}

el('scanLibrary').addEventListener('click', async () => {
  try {
    const root = el('musicRoot').value.trim();
    state.library = await api('/api/library/scan', {
      method: 'POST',
      body: JSON.stringify({ root })
    });
    renderLibraryStatus();
  } catch (error) {
    alert(error.message);
  }
});

el('createPlaylist').addEventListener('click', async () => {
  try {
    const playlist = await api('/api/playlists', {
      method: 'POST',
      body: JSON.stringify({
        name: el('playlistName').value.trim(),
        prompt: el('playlistPrompt').value.trim()
      })
    });
    state.playlist = playlist;
    renderPlaylist();
    await loadPlaylists();
  } catch (error) {
    alert(error.message);
  }
});

el('loadPlaylist').addEventListener('click', async () => {
  const id = el('playlistSelect').value;
  if (id) await loadPlaylistById(id);
});

el('refreshTandaLibrary').addEventListener('click', loadTandaLibrary);

Promise.all([refreshLibrary(), loadPlaylists(), loadTandaLibrary()]).catch((error) => {
  console.error(error);
});
