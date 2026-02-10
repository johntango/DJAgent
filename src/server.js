const express = require('express');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { parseFile } = require('music-metadata');
const OpenAI = require('openai');

loadLocalEnv();

const app = express();
const PORT = process.env.PORT || 3000;
const MUSIC_ROOT = process.env.MUSIC_ROOT || '/users/johnwilliams/Music/MyMusic';
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const LIBRARY_FILE = path.join(DATA_DIR, 'library', 'library.json');
const CATALOG_FALLBACK_FILES = ['CatalogArt.json', 'catalog-Art.json'];
const PLAYLISTS_DIR = path.join(DATA_DIR, 'playlists');
const TANDA_LIBRARY_DIR = path.join(DATA_DIR, 'tanda-library');
const ALLOWED_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.aiff']);


function loadLocalEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');

  try {
    const contents = fsSync.readFileSync(envPath, 'utf8');
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separatorIndex = line.indexOf('=');
      if (separatorIndex <= 0) continue;

      const key = line.slice(0, separatorIndex).trim();
      if (!key || process.env[key] !== undefined) continue;

      let value = line.slice(separatorIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // Ignore missing or unreadable .env files.
  }
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.resolve(__dirname, '..', 'public')));

function resolveOpenAIApiKey(overrideApiKey = '') {
  const override = typeof overrideApiKey === 'string' ? overrideApiKey.trim() : '';
  if (override) return override;

  const apiKey = process.env.OPENAI_API_KEY;
  return apiKey || process.env.OPENAI_KEY || process.env.OPENAI_TOKEN || '';
}

function buildOpenAIClient(overrideApiKey = '') {
  const apiKey = resolveOpenAIApiKey(overrideApiKey);
  return apiKey ? new OpenAI({ apiKey }) : null;
}

const generationSchema = {
  name: 'tango_playlist_plan',
  schema: {
    type: 'object',
    required: ['tandas'],
    properties: {
      tandas: {
        type: 'array',
        minItems: 6,
        maxItems: 6,
        items: {
          type: 'object',
          required: ['type', 'reasoning', 'trackIds'],
          properties: {
            type: { type: 'string', enum: ['tango', 'vals', 'milonga'] },
            reasoning: { type: 'string' },
            trackIds: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          additionalProperties: false
        }
      },
      cortinaTrackIds: {
        type: 'array',
        minItems: 6,
        maxItems: 6,
        items: { type: 'string' }
      }
    },
    additionalProperties: false
  }
};

async function ensureDataDirs() {
  await fs.mkdir(path.dirname(LIBRARY_FILE), { recursive: true });
  await fs.mkdir(PLAYLISTS_DIR, { recursive: true });
  await fs.mkdir(TANDA_LIBRARY_DIR, { recursive: true });
  try {
    await fs.access(LIBRARY_FILE);
  } catch {
    const seededLibrary = await loadCatalogFallback();
    await fs.writeFile(LIBRARY_FILE, JSON.stringify(seededLibrary, null, 2));
  }
}

function inferTrackStyle(tags = {}) {
  const text = `${(tags.genre || []).join(' ')} ${tags.title || ''} ${tags.album || ''}`.toLowerCase();
  if (text.includes('vals') || text.includes('waltz')) return 'vals';
  if (text.includes('milonga')) return 'milonga';
  if (text.includes('cortina')) return 'cortina';
  return 'tango';
}

function mapCatalogTrack(entry = {}) {
  const absPath = entry.file?.absPath;
  if (!absPath) return null;

  const tags = entry.tags || {};
  return {
    id: absPath,
    sourcePath: absPath,
    relativePath: absPath,
    title: tags.title || path.basename(absPath),
    artist: tags.artist || tags.albumartist || 'Unknown Artist',
    album: tags.album || 'Unknown Album',
    genre: Array.isArray(tags.genre) ? tags.genre.join(', ') : tags.genre || '',
    year: tags.year || null,
    duration: 0,
    style: inferTrackStyle(tags),
    artUrl: entry.artUrl || null
  };
}

async function loadCatalogFallback() {
  const repoRoot = path.resolve(__dirname, '..');

  for (const fileName of CATALOG_FALLBACK_FILES) {
    const fallbackPath = path.join(repoRoot, fileName);
    const catalog = await readJson(fallbackPath, null);
    if (!catalog?.tracks?.length) continue;

    const tracks = catalog.tracks.map(mapCatalogTrack).filter(Boolean);
    if (!tracks.length) continue;

    return {
      generatedAt: new Date().toISOString(),
      root: MUSIC_ROOT,
      source: fileName,
      trackCount: tracks.length,
      tracks
    };
  }

  return { generatedAt: null, root: MUSIC_ROOT, tracks: [] };
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function walk(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

function guessStyleFromMetadata(metadata) {
  const text = `${metadata.genre || ''} ${metadata.title || ''} ${metadata.album || ''}`.toLowerCase();
  if (text.includes('vals') || text.includes('waltz')) return 'vals';
  if (text.includes('milonga')) return 'milonga';
  if (text.includes('cortina')) return 'cortina';
  return 'tango';
}

async function buildLibrary(rootDir = MUSIC_ROOT) {
  const files = await walk(rootDir);
  const tracks = [];

  for (const file of files) {
    try {
      const meta = await parseFile(file);
      const relativePath = path.relative(rootDir, file);
      const common = meta.common || {};
      const format = meta.format || {};
      const title = common.title || path.basename(file);
      const artist = common.artist || 'Unknown Artist';
      const album = common.album || 'Unknown Album';
      const genre = (common.genre && common.genre[0]) || '';
      const year = common.year || null;
      const duration = format.duration || 0;

      tracks.push({
        id: relativePath,
        sourcePath: file,
        relativePath,
        title,
        artist,
        album,
        genre,
        year,
        duration,
        style: guessStyleFromMetadata({ genre, title, album })
      });
    } catch (error) {
      console.warn(`Could not parse ${file}: ${error.message}`);
    }
  }

  const library = {
    generatedAt: new Date().toISOString(),
    root: rootDir,
    trackCount: tracks.length,
    tracks
  };

  await writeJson(LIBRARY_FILE, library);
  return library;
}

function groupByStyle(library) {
  const grouped = { tango: [], vals: [], milonga: [], cortina: [] };
  for (const track of library.tracks || []) {
    const style = grouped[track.style] ? track.style : 'tango';
    grouped[style].push(track);
  }
  return grouped;
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function fallbackPlaylistPlan(library) {
  const grouped = groupByStyle(library);
  const pattern = [
    { type: 'tango', size: 4 },
    { type: 'tango', size: 4 },
    { type: 'vals', size: 3 },
    { type: 'tango', size: 4 },
    { type: 'tango', size: 4 },
    { type: 'milonga', size: 3 }
  ];

  const used = new Set();
  const tandas = pattern.map((slot, idx) => {
    const pool = shuffle(grouped[slot.type]).filter((track) => !used.has(track.id));
    const chosen = pool.slice(0, slot.size);
    chosen.forEach((track) => used.add(track.id));
    return {
      id: `tanda-${idx + 1}`,
      type: slot.type,
      reasoning: 'Fallback selection due to unavailable OpenAI plan.',
      tracks: chosen
    };
  });

  const cortinaPool = shuffle(grouped.cortina.length ? grouped.cortina : grouped.tango).filter((track) => !used.has(track.id));
  const cortinas = tandas.map((_, idx) => cortinaPool[idx] || null);

  return { tandas, cortinas };
}

function validatePlanShape(plan) {
  if (!plan || !Array.isArray(plan.tandas) || plan.tandas.length !== 6) return false;
  const pattern = ['tango', 'tango', 'vals', 'tango', 'tango', 'milonga'];
  return plan.tandas.every((t, i) => t.type === pattern[i] && Array.isArray(t.trackIds));
}

async function createPlanWithAgent(library, userPrompt, overrideApiKey = '') {
  const openai = buildOpenAIClient(overrideApiKey);
  if (!openai) {
    return {
      plan: null,
      debug: {
        enabled: false,
        reason: 'No OpenAI API key found (checked request override, OPENAI_API_KEY, OPENAI_KEY, OPENAI_TOKEN)',
        timestamp: new Date().toISOString()
      }
    };
  }

  const pattern = ['tango', 'tango', 'vals', 'tango', 'tango', 'milonga'];
  const conciseLibrary = library.tracks.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    style: t.style,
    year: t.year,
    duration: t.duration
  }));

  const instructions = [
    'You are an expert Tango DJ agent. Build tandas with strong dance-floor flow.',
    'Pattern must be tango(4), tango(4), vals(3), tango(4), tango(4), milonga(3).',
    'Add one cortina id after each tanda (6 total).',
    'Do not repeat track IDs.',
    'Orchestras can repeat only if separated by at least two full tandas.',
    'Prefer coherent orchestra/era feeling inside a tanda.',
    userPrompt ? `User direction: ${userPrompt}` : ''
  ].filter(Boolean).join('\n');

  const startedAt = Date.now();
  const requestPayload = {
    pattern,
    trackCount: conciseLibrary.length,
    sampleTrackIds: conciseLibrary.slice(0, 5).map((track) => track.id),
    userPrompt: userPrompt || ''
  };

  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ pattern, tracks: conciseLibrary }) }] }],
    text: {
      format: {
        type: 'json_schema',
        name: generationSchema.name,
        schema: generationSchema.schema,
        strict: true
      }
    }
  });

  const jsonText = response.output_text;
  const plan = JSON.parse(jsonText);
  const debug = {
    enabled: true,
    model: response.model,
    responseId: response.id,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    request: requestPayload,
    response: {
      outputTextLength: jsonText.length,
      tandaTypes: (plan.tandas || []).map((t) => t.type),
      cortinaCount: (plan.cortinaTrackIds || []).length
    }
  };

  console.log('[Agent Debug] OpenAI request/response', JSON.stringify(debug));

  return { plan, debug };
}

function hydratePlan(plan, library) {
  const trackMap = new Map(library.tracks.map((track) => [track.id, track]));
  const patternSizes = [4, 4, 3, 4, 4, 3];

  const tandas = plan.tandas.map((tanda, idx) => ({
    id: `tanda-${idx + 1}`,
    type: tanda.type,
    reasoning: tanda.reasoning || 'AI selected this tanda for flow.',
    tracks: (tanda.trackIds || []).map((id) => trackMap.get(id)).filter(Boolean).slice(0, patternSizes[idx])
  }));

  const cortinas = (plan.cortinaTrackIds || []).map((id) => trackMap.get(id)).filter(Boolean).slice(0, 6);
  return { tandas, cortinas };
}

function normalizePlaylist(playlist) {
  return {
    ...playlist,
    tandas: (playlist.tandas || []).map((t) => ({ ...t, tracks: t.tracks || [] })),
    cortinas: (playlist.cortinas || []).map((c) => c || null),
    updatedAt: new Date().toISOString()
  };
}

async function readPlaylist(id) {
  const filePath = path.join(PLAYLISTS_DIR, `${id}.json`);
  const playlist = await readJson(filePath, null);
  return playlist;
}

app.get('/api/library', async (_req, res) => {
  const library = await readJson(LIBRARY_FILE, { generatedAt: null, tracks: [] });
  res.json(library);
});

app.post('/api/library/scan', async (req, res) => {
  try {
    const root = req.body?.root || MUSIC_ROOT;
    const library = await buildLibrary(root);
    res.json(library);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/playlists', async (_req, res) => {
  const entries = await fs.readdir(PLAYLISTS_DIR, { withFileTypes: true });
  const playlists = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const playlist = await readJson(path.join(PLAYLISTS_DIR, entry.name), null);
    if (playlist) playlists.push({ id: playlist.id, name: playlist.name, updatedAt: playlist.updatedAt });
  }
  playlists.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  res.json({ playlists });
});

app.get('/api/playlists/:id', async (req, res) => {
  const playlist = await readPlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  res.json(playlist);
});

app.post('/api/playlists', async (req, res) => {
  const library = await readJson(LIBRARY_FILE, { tracks: [] });
  if (!library.tracks?.length) {
    return res.status(400).json({ error: 'Library is empty. Scan library first.' });
  }

  const id = `playlist-${Date.now()}`;
  const name = req.body?.name || `Milonga ${new Date().toLocaleDateString()}`;

  let plan = null;
  let agentDebug = {
    enabled: false,
    createdAt: new Date().toISOString(),
    reason: 'Agent was not called'
  };
  try {
    const agentResult = await createPlanWithAgent(
      library,
      req.body?.prompt || '',
      req.body?.openaiApiKey || ''
    );
    plan = agentResult.plan;
    agentDebug = agentResult.debug;
  } catch (error) {
    console.warn(`OpenAI generation failed: ${error.message}`);
    agentDebug = {
      enabled: false,
      createdAt: new Date().toISOString(),
      reason: `OpenAI generation failed: ${error.message}`
    };
  }

  const usedFallback = !plan || !validatePlanShape(plan);
  if (usedFallback && agentDebug?.enabled) {
    agentDebug.validation = 'Agent response shape was invalid; fallback plan used';
  }
  const hydrated = usedFallback ? fallbackPlaylistPlan(library) : hydratePlan(plan, library);
  const playlist = normalizePlaylist({
    id,
    name,
    prompt: req.body?.prompt || '',
    generationSource: usedFallback ? 'fallback' : 'agent',
    agentDebug,
    createdAt: new Date().toISOString(),
    ...hydrated
  });

  await writeJson(path.join(PLAYLISTS_DIR, `${id}.json`), playlist);
  res.status(201).json(playlist);
});

app.put('/api/playlists/:id', async (req, res) => {
  const existing = await readPlaylist(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Playlist not found' });
  const updated = normalizePlaylist({ ...existing, ...req.body, id: existing.id });
  await writeJson(path.join(PLAYLISTS_DIR, `${existing.id}.json`), updated);
  res.json(updated);
});

app.post('/api/playlists/:id/move-tanda', async (req, res) => {
  const { fromIndex, toIndex } = req.body || {};
  const playlist = await readPlaylist(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  if ([fromIndex, toIndex].some((n) => typeof n !== 'number')) {
    return res.status(400).json({ error: 'fromIndex and toIndex must be numbers' });
  }

  const tandas = [...playlist.tandas];
  const cortinas = [...playlist.cortinas];
  const [tanda] = tandas.splice(fromIndex, 1);
  const [cortina] = cortinas.splice(fromIndex, 1);
  tandas.splice(toIndex, 0, tanda);
  cortinas.splice(toIndex, 0, cortina);

  const updated = normalizePlaylist({ ...playlist, tandas, cortinas });
  await writeJson(path.join(PLAYLISTS_DIR, `${playlist.id}.json`), updated);
  res.json(updated);
});

app.post('/api/playlists/:id/replace-track', async (req, res) => {
  const { tandaIndex, trackIndex, replacementTrackId } = req.body || {};
  const playlist = await readPlaylist(req.params.id);
  const library = await readJson(LIBRARY_FILE, { tracks: [] });
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const replacement = library.tracks.find((t) => t.id === replacementTrackId);
  if (!replacement) return res.status(400).json({ error: 'replacementTrackId not found in library' });

  playlist.tandas[tandaIndex].tracks[trackIndex] = replacement;
  const updated = normalizePlaylist(playlist);
  await writeJson(path.join(PLAYLISTS_DIR, `${playlist.id}.json`), updated);
  res.json(updated);
});

app.post('/api/tanda-library', async (req, res) => {
  const { playlistId, tandaIndex, name } = req.body || {};
  const playlist = await readPlaylist(playlistId);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  const tanda = playlist.tandas[tandaIndex];
  if (!tanda) return res.status(404).json({ error: 'Tanda not found' });

  const record = {
    id: `saved-tanda-${Date.now()}`,
    name: name || `${tanda.type} tanda ${new Date().toISOString()}`,
    sourcePlaylistId: playlistId,
    savedAt: new Date().toISOString(),
    tanda
  };

  await writeJson(path.join(TANDA_LIBRARY_DIR, `${record.id}.json`), record);
  res.status(201).json(record);
});

app.get('/api/tanda-library', async (_req, res) => {
  const entries = await fs.readdir(TANDA_LIBRARY_DIR, { withFileTypes: true });
  const tandas = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const item = await readJson(path.join(TANDA_LIBRARY_DIR, entry.name), null);
    if (item) tandas.push(item);
  }
  tandas.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  res.json({ tandas });
});

app.get('/api/audio/:trackId(*)', async (req, res) => {
  const trackId = req.params.trackId;
  const library = await readJson(LIBRARY_FILE, { tracks: [] });
  const track = library.tracks.find((item) => item.id === trackId);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  res.sendFile(track.sourcePath);
});

app.get('*', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'index.html'));
});

ensureDataDirs().then(() => {
  app.listen(PORT, () => {
    console.log(`Tango DJ Agent listening on http://localhost:${PORT}`);
  });
});
