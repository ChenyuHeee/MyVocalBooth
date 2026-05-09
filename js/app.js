const PX_PER_SEC = 40;
const HEADER_WIDTH = 145; // must match .track-header width in CSS
const WAVEFORM_RATE = 200; // peak buckets per second stored in cache

class App {
  constructor() {
    this.db = new AssetsDB();
    this.player = new Player();
    this.recorder = new Recorder();
    this._blobUrls = new Map();
    this._audioCtxStarted = false;
    this._tracks = [];
    this._assets = [];
    this.selectedTrackId = 1;
    this.selectedClip = null;  // { trackId, clipIdx }
    this._reEditor = null;     // region editor state
    this._waveformCache = new Map(); // assetId -> Float32Array of peaks | null (failed)
    this._clipDrag = null;     // { trackId, clipIdx, startX, origStart, ghostEl }
    this._history = [];        // undo stack
    this._future = [];         // redo stack

    this.player.onPlayhead((secs) => this._movePlayhead(secs));
  }

  async init() {
    this._bindEvents();
    this.recorder.onTimerTick = (s) => this._updateTimer(s);
    try {
      const proj = await this.db.loadProject();
      this._tracks = proj.tracks;
    } catch (err) {
      console.error('Failed to load project, using defaults:', err);
      this._tracks = this.db._defaultProject().tracks;
    }
    try {
      this._assets = await this.db.getAssets();
    } catch (err) {
      console.error('Failed to load assets:', err);
      this._assets = [];
    }
    this._renderAll();
  }

  /* ---- Event binding ---- */

  _bindEvents() {
    document.getElementById('btn-start').addEventListener('click', () => this._startRecording());
    document.getElementById('btn-stop').addEventListener('click', () => this._stopRecording());
    document.getElementById('btn-play').addEventListener('click', () => this._play());
    document.getElementById('btn-pause').addEventListener('click', () => this._pause());
    document.getElementById('btn-stop-tx').addEventListener('click', () => this._stopTransport());
    document.getElementById('btn-upload').addEventListener('click', () => {
      document.getElementById('file-upload').click();
    });
    document.getElementById('file-upload').addEventListener('change', (e) => {
      this._handleFileUpload(e.target.files);
    });
    document.getElementById('btn-split').addEventListener('click', () => this._splitSelected());
    document.getElementById('btn-merge').addEventListener('click', () => this._mergeSelected());
    document.getElementById('btn-undo').addEventListener('click', () => this._undo());
    document.getElementById('btn-redo').addEventListener('click', () => this._redo());

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); this._undo(); }
      if ((e.metaKey || e.ctrlKey) && (e.shiftKey && e.key === 'z' || e.key === 'y')) { e.preventDefault(); this._redo(); }
      // Ignore shortcuts when typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Space — toggle play/pause
      if (e.key === ' ') {
        e.preventDefault();
        if (this.player.isPlaying()) { this._pause(); } else { this._play(); }
        return;
      }

      // Arrow keys — move selected clip (if any), else nudge playhead
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const clipData = this._getSelectedClipData();
        if (clipData && !this.player.isPlaying()) {
          // Move selected clip in time
          const step = e.shiftKey ? 1 : 0.05;
          const clip = clipData.clip;
          this._checkpoint();
          clip.startTime = Math.max(0, clip.startTime + (e.key === 'ArrowLeft' ? -step : step));
          this._saveProject();
          this._renderAll();
        } else if (!this.player.isPlaying()) {
          // Nudge playhead
          const step = e.shiftKey ? 1 : 0.1;
          const secs = Math.max(0, this.player.position + (e.key === 'ArrowLeft' ? -step : step));
          this.player.seek(secs);
          this._movePlayhead(secs);
        }
        return;
      }

      // Delete / Backspace — remove selected clip
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedClip) {
        e.preventDefault();
        this._deleteClip(this.selectedClip.trackId, this.selectedClip.clipIdx);
      }
    });

    // Asset list — explicit button matching
    document.getElementById('asset-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const item = btn.closest('.asset-item');
      if (!item) return;
      const assetId = Number(item.dataset.assetId);
      if (!assetId) return;

      try {
        if (btn.classList.contains('asset-add')) this._addClipToTrack(assetId);
        else if (btn.classList.contains('asset-delete')) { e.preventDefault(); this._deleteAsset(assetId); }
      } catch (err) {
        console.error('Asset action failed:', err);
      }
    });

    // Timeline
    const tl = document.getElementById('timeline-tracks');
    tl.addEventListener('click', (e) => {
      // Ignore clicks that were actually drag releases
      if (this._suppressNextClick) { this._suppressNextClick = false; return; }
      const trackRow = e.target.closest('.track-row');
      if (!trackRow) { this._deselectClip(); return; }
      const trackId = Number(trackRow.dataset.trackId);

      if (e.target.closest('.track-solo')) { this._toggleTrackSolo(trackId); this._renderAll(); return; }
      if (e.target.closest('.track-mute')) { this._toggleTrackMute(trackId); this._renderAll(); return; }
      if (e.target.closest('.clip-delete')) {
        const clipEl = e.target.closest('.clip');
        if (clipEl) { this._deleteClip(trackId, Number(clipEl.dataset.clipIdx)); return; }
      }

      // Click on track header → select track
      if (e.target.closest('.track-header')) {
        this.selectedTrackId = trackId;
        this._deselectClip();
        this._renderAll();
        return;
      }

      // Click on track lane (empty) → deselect clip
      if (e.target.closest('.track-lane') && !e.target.closest('.clip')) {
        this.selectedTrackId = trackId;
        this._deselectClip();
        this._renderAll();
        return;
      }

      // Click on clip
      const clipEl = e.target.closest('.clip');
      if (clipEl) {
        const clipIdx = Number(clipEl.dataset.clipIdx);
        if (e.shiftKey) {
          // Shift+click: split at click position
          const rect = clipEl.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const offsetTime = x / PX_PER_SEC;
          this._splitClip(trackId, clipIdx, offsetTime);
        } else {
          this.selectedTrackId = trackId;
          this._selectClip(trackId, clipIdx);
        }
        return;
      }
    });

    tl.addEventListener('input', (e) => {
      // faders now live in inspector; nothing to handle here
    });

    // Clip drag — mousedown on clip starts drag
    tl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.clip-delete')) return;
      const clipEl = e.target.closest('.clip');
      if (!clipEl || e.shiftKey) return;
      const trackRow = clipEl.closest('.track-row');
      if (!trackRow) return;
      const trackId = Number(trackRow.dataset.trackId);
      const clipIdx = Number(clipEl.dataset.clipIdx);
      const track = this._tracks.find(t => t.id === trackId);
      if (!track) return;
      const clip = track.clips[clipIdx];
      if (!clip) return;

      const scrollEl = document.getElementById('lanes-scroll');
      this._clipDrag = {
        trackId, clipIdx,
        startX: e.clientX,
        startScroll: scrollEl.scrollLeft,
        origStart: clip.startTime,
        moved: false,
      };
      clipEl.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e) => {
      if (!this._clipDrag) return;
      const dx = e.clientX - this._clipDrag.startX;
      if (!this._clipDrag.moved && Math.abs(dx) < 3) return;
      this._clipDrag.moved = true;

      const track = this._tracks.find(t => t.id === this._clipDrag.trackId);
      if (!track) return;
      const clip = track.clips[this._clipDrag.clipIdx];
      if (!clip) return;

      const newStart = Math.max(0, this._clipDrag.origStart + dx / PX_PER_SEC);
      clip.startTime = Math.round(newStart * 20) / 20; // snap to 0.05s

      // Move the actual DOM element for smooth visual feedback
      const clipEl = document.querySelector(
        `.track-row[data-track-id="${this._clipDrag.trackId}"] .clip[data-clip-idx="${this._clipDrag.clipIdx}"]`
      );
      if (clipEl) clipEl.style.left = clip.startTime * PX_PER_SEC + 'px';
    });

    window.addEventListener('mouseup', (e) => {
      if (!this._clipDrag) return;
      const drag = this._clipDrag;
      this._clipDrag = null;
      document.querySelectorAll('.clip.dragging').forEach(el => el.classList.remove('dragging'));
      if (drag.moved) {
        e._wasDrag = true; // suppress the following click event on tl
        this._suppressNextClick = true;
        this._checkpoint();
        // Re-sort clips on the track by startTime
        const track = this._tracks.find(t => t.id === drag.trackId);
        if (track) track.clips.sort((a, b) => a.startTime - b.startTime);
        this._saveProject();
        this._renderAll();
      }
    });

    // Ruler seek (click anywhere on ruler)
    document.getElementById('time-ruler').addEventListener('click', (e) => {
      const container = document.getElementById('lanes-scroll');
      const containerRect = container.getBoundingClientRect();
      const contentX = e.clientX - containerRect.left + container.scrollLeft;
      const timeX = contentX - HEADER_WIDTH;
      const secs = Math.max(0, timeX / PX_PER_SEC);
      this.player.seek(secs);
      this._movePlayhead(secs);
    });

    // Playhead drag — mousedown on the playhead line/handle
    document.getElementById('lanes-scroll').addEventListener('mousedown', (e) => {
      if (!e.target.closest('.playhead')) return;
      e.preventDefault();
      e.stopPropagation();
      const scrollEl = document.getElementById('lanes-scroll');
      const onMove = (me) => {
        const rect = scrollEl.getBoundingClientRect();
        const x = Math.max(0, me.clientX - rect.left + scrollEl.scrollLeft - HEADER_WIDTH);
        const secs = Math.max(0, x / PX_PER_SEC);
        this.player.seek(secs);
        this._movePlayhead(secs);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  /* ---- Recording ---- */

  async _startRecording() {
    try {
      if (!this._audioCtxStarted) { await Tone.start(); this._audioCtxStarted = true; }
      this.player.stop();
      await this.recorder.start();
      document.getElementById('btn-start').disabled = true;
      document.getElementById('btn-stop').disabled = false;
      document.getElementById('rec-indicator').classList.remove('hidden');
    } catch (err) { alert('Cannot record: ' + err.message); }
  }

  async _stopRecording() {
    const blob = await this.recorder.stop();
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled = true;
    document.getElementById('rec-indicator').classList.add('hidden');
    const count = await this.db.assetCount();
    const id = await this.db.addAsset(blob, `Recording ${count + 1}`);
    const dur = await this._getBlobDuration(blob);
    await this.db.updateAsset(id, { duration: dur });
    this._assets = await this.db.getAssets();
    this._renderAll();
  }

  _updateTimer(secs) {
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    document.getElementById('rec-timer').textContent = `${m}:${s}`;
  }

  /* ---- File upload ---- */

  async _handleFileUpload(fileList) {
    if (!fileList || fileList.length === 0) return;
    for (const file of fileList) {
      const blob = new Blob([file], { type: file.type || 'audio/mpeg' });
      const name = file.name.replace(/\.[^.]+$/, '');
      const id = await this.db.addAsset(blob, name);
      const dur = await this._getBlobDuration(blob);
      await this.db.updateAsset(id, { duration: dur });
    }
    this._assets = await this.db.getAssets();
    this._renderAll();
    document.getElementById('file-upload').value = '';
  }

  /* ---- Playback ---- */

  async _play() {
    if (this.player.isPlaying()) return;
    if (!this._audioCtxStarted) { await Tone.start(); this._audioCtxStarted = true; }
    try {
      await this.player.play(this._tracks, (assetId) => this._getAssetBlob(assetId));
      this._renderAll();
    } catch (err) { alert('Playback failed: ' + err.message); }
  }

  _pause() { this.player.pause(); this._renderAll(); }
  _stopTransport() { this.player.stop(); this._movePlayhead(0); this._renderAll(); }

  _movePlayhead(secs) {
    const el = document.getElementById('playhead');
    if (!el) return;
    el.style.left = `${HEADER_WIDTH + secs * PX_PER_SEC}px`;
    this._updatePlayheadTime(secs);
    // Auto-scroll to keep playhead in view during playback
    const scrollEl = document.getElementById('lanes-scroll');
    if (scrollEl && this.player.isPlaying()) {
      const visibleWidth = scrollEl.clientWidth;
      const phX = HEADER_WIDTH + secs * PX_PER_SEC - scrollEl.scrollLeft;
      if (phX > visibleWidth - 80) scrollEl.scrollLeft += 150;
    }
  }

  _updatePlayheadTime(secs) {
    const timeEl = document.getElementById('playhead-time');
    if (!timeEl) return;
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 10);
    timeEl.textContent = `${m}:${String(s).padStart(2, '0')}.${ms}`;
  }

  /* ---- Undo / Redo ---- */

  _checkpoint() {
    this._history.push(JSON.parse(JSON.stringify(this._tracks)));
    if (this._history.length > 50) this._history.shift();
    this._future = [];
  }

  _undo() {
    if (this._history.length === 0) return;
    this._future.push(JSON.parse(JSON.stringify(this._tracks)));
    this._tracks = this._history.pop();
    this.selectedClip = null;
    this._saveProject();
    this._renderAll();
  }

  _redo() {
    if (this._future.length === 0) return;
    this._history.push(JSON.parse(JSON.stringify(this._tracks)));
    this._tracks = this._future.pop();
    this.selectedClip = null;
    this._saveProject();
    this._renderAll();
  }

  /* ---- Asset operations ---- */

  _getAssetBlob(assetId) {
    const asset = this._assets.find((a) => a.id === assetId);
    return asset ? asset.audioBlob : null;
  }

  async _deleteAsset(assetId) {
    try {
      this._checkpoint();
      for (const track of this._tracks) track.clips = track.clips.filter((c) => c.assetId !== assetId);
      await this.db.removeAsset(assetId);
      this._revokeBlobUrl(assetId);
      this._assets = await this.db.getAssets();
      if (this.selectedClip) {
        const data = this._getSelectedClipData();
        if (!data || data.clip.assetId === assetId) this._deselectClip();
      }
      await this._saveProject();
      this._renderAll();
    } catch (err) {
      console.error('Delete asset failed:', err);
    }
  }

  _addClipToTrack(assetId) {
    const asset = this._assets.find((a) => a.id === assetId);
    if (!asset) return;
    const track = this._tracks.find((t) => t.id === this.selectedTrackId);
    if (!track) return;
    this._checkpoint();
    const dur = asset.duration || 5;
    const lastEnd = track.clips.reduce((max, c) => {
      const d = this._clipSourceDuration(c);
      return Math.max(max, c.startTime + d);
    }, 0);
    track.clips.push({
      assetId,
      startTime: lastEnd,
      sourceStart: 0,
      sourceDuration: dur,
      pitchRegions: []
    });
    this._saveProject();
    this._renderAll();
  }

  /* ---- Clip operations ---- */

  _selectClip(trackId, clipIdx) {
    this.selectedClip = { trackId, clipIdx };
    this._renderAll();
  }

  _deselectClip() {
    this.selectedClip = null;
    this._renderAll();
  }

  _getSelectedClipData() {
    if (!this.selectedClip) return null;
    const track = this._tracks.find((t) => t.id === this.selectedClip.trackId);
    if (!track) return null;
    const clip = track.clips[this.selectedClip.clipIdx];
    if (!clip) return null;
    const asset = this._assets.find((a) => a.id === clip.assetId);
    return { track, clip, asset, trackId: this.selectedClip.trackId, clipIdx: this.selectedClip.clipIdx };
  }

  _splitClip(trackId, clipIdx, offsetTime) {
    const track = this._tracks.find((t) => t.id === trackId);
    if (!track) return;
    const clip = track.clips[clipIdx];
    if (!clip) return;

    const dur = this._clipSourceDuration(clip);
    if (offsetTime <= 0.1 || offsetTime >= dur - 0.1) return;

    this._checkpoint();

    // Split pitchRegions by offsetTime
    const srcRegions = clip.pitchRegions || [];
    const regions1 = [], regions2 = [];
    for (const r of srcRegions) {
      const rEnd = r.end;
      if (rEnd <= offsetTime) {
        regions1.push({ ...r });
      } else if (r.start >= offsetTime) {
        regions2.push({ start: r.start - offsetTime, end: rEnd - offsetTime, shift: r.shift });
      } else {
        // Straddles split point — crop to each side
        regions1.push({ start: r.start, end: offsetTime, shift: r.shift });
        regions2.push({ start: 0, end: rEnd - offsetTime, shift: r.shift });
      }
    }

    const clip1 = {
      assetId: clip.assetId,
      startTime: clip.startTime,
      sourceStart: clip.sourceStart || 0,
      sourceDuration: offsetTime,
      pitchRegions: regions1
    };
    const clip2 = {
      assetId: clip.assetId,
      startTime: clip.startTime + offsetTime,
      sourceStart: (clip.sourceStart || 0) + offsetTime,
      sourceDuration: dur - offsetTime,
      pitchRegions: regions2
    };

    track.clips.splice(clipIdx, 1, clip1, clip2);
    this.selectedClip = { trackId, clipIdx: clipIdx + 1 };
    this._saveProject();
    this._renderAll();
  }

  _splitSelected() {
    if (!this.selectedClip) return;
    const data = this._getSelectedClipData();
    if (!data) return;
    const playheadTime = this.player.position;
    const offsetTime = playheadTime - data.clip.startTime;
    if (offsetTime > 0.1 && offsetTime < this._clipSourceDuration(data.clip) - 0.1) {
      this._splitClip(data.trackId, data.clipIdx, offsetTime);
    }
  }

  _mergeSelected() {
    if (!this.selectedClip) return;
    const data = this._getSelectedClipData();
    if (!data) return;
    const { track, clip, clipIdx } = data;

    // Try merge with next clip on same track
    if (clipIdx + 1 >= track.clips.length) return;
    const nextClip = track.clips[clipIdx + 1];
    if (clip.assetId !== nextClip.assetId) return; // Must be same asset

    const dur = this._clipSourceDuration(clip);
    const isAdjacent = Math.abs((clip.startTime + dur) - nextClip.startTime) < 0.05;
    if (!isAdjacent) return;

    this._checkpoint();

    const nextDur = this._clipSourceDuration(nextClip);
    const regions1 = clip.pitchRegions || [];
    const regions2 = (nextClip.pitchRegions || []).map(r => ({ start: r.start + dur, end: r.end + dur, shift: r.shift }));
    const merged = {
      assetId: clip.assetId,
      startTime: clip.startTime,
      sourceStart: clip.sourceStart || 0,
      sourceDuration: dur + nextDur,
      pitchRegions: [...regions1, ...regions2]
    };

    track.clips.splice(clipIdx, 2, merged);
    this.selectedClip = { trackId: data.trackId, clipIdx };
    this._saveProject();
    this._renderAll();
  }

  _deleteClip(trackId, clipIdx) {
    const track = this._tracks.find((t) => t.id === trackId);
    if (!track) return;
    this._checkpoint();
    track.clips.splice(clipIdx, 1);
    if (this.selectedClip && this.selectedClip.trackId === trackId && this.selectedClip.clipIdx === clipIdx) {
      this._deselectClip();
    }
    this._saveProject();
    this._renderAll();
  }

  /* ---- Pitch keyframes ---- */
  // (removed — replaced by region-based pitch editing in inspector)

  /* ---- Track controls ---- */

  _setTrackVolume(trackId, v) {
    const track = this._tracks.find((t) => t.id === trackId);
    if (!track) return;
    track.volume = v;
    this._saveProject();
  }

  _setTrackPitch(trackId, st) {
    const track = this._tracks.find((t) => t.id === trackId);
    if (!track) return;
    track.pitchShift = st;
    this._saveProject();
  }

  _toggleTrackSolo(trackId) {
    const track = this._tracks.find((t) => t.id === trackId);
    if (!track) return;
    this._checkpoint();
    track.solo = !track.solo;
    this._saveProject();
  }

  _toggleTrackMute(trackId) {
    const track = this._tracks.find((t) => t.id === trackId);
    if (!track) return;
    this._checkpoint();
    track.mute = !track.mute;
    this._saveProject();
  }

  /* ---- Persistence ---- */

  async _saveProject() {
    await this.db.saveProject({ key: 'main', tracks: this._tracks });
    // If currently playing, restart with updated tracks (position is preserved inside play())
    if (this.player.isPlaying()) {
      this.player.play(this._tracks, (assetId) => this._getAssetBlob(assetId))
        .catch(e => console.warn('Live playback refresh failed:', e));
    }
  }

  /* ---- Rendering ---- */

  _renderAll() {
    this._renderAssetList();
    this._renderTimeline();
    this._renderInspector();
    this._renderTransportButtons();
  }

  _renderAssetList() {
    const list = document.getElementById('asset-list');
    const countEl = document.getElementById('asset-count');
    countEl.textContent = this._assets.length;

    if (this._assets.length === 0) {
      list.innerHTML = '<li class="asset-empty">No assets yet</li>';
      return;
    }

    list.innerHTML = this._assets.map((a) => {
      const dur = a.duration ? this._fmtDuration(a.duration) : '--';
      return `
        <li class="asset-item" data-asset-id="${a.id}">
          <span class="asset-name">${this._esc(a.name)}</span>
          <span class="asset-dur">${dur}</span>
          <button class="asset-add" title="Add to selected track">+</button>
          <button class="asset-delete" title="Delete">&times;</button>
        </li>
      `;
    }).join('');
  }

  _renderTimeline() {
    const container = document.getElementById('timeline-tracks');
    let totalDur = 0;
    for (const track of this._tracks) {
      for (const clip of track.clips) {
        const d = this._clipSourceDuration(clip);
        totalDur = Math.max(totalDur, clip.startTime + d);
      }
    }
    totalDur = Math.max(totalDur, 30);
    const width = totalDur * PX_PER_SEC + 200;

    // Ruler
    const ruler = document.getElementById('time-ruler');
    const tickInterval = totalDur <= 30 ? 5 : totalDur <= 60 ? 10 : totalDur <= 180 ? 15 : 30;
    // Sticky spacer covers the header column so ticks don't appear beneath it
    let rulerHTML = `<span class="ruler-header-spacer"></span>`;
    for (let t = 0; t <= totalDur; t += tickInterval) {
      const x = HEADER_WIDTH + t * PX_PER_SEC;
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      rulerHTML += `<span class="ruler-tick" style="left:${x}px">${m}:${String(s).padStart(2, '0')}</span>`;
      // Minor ticks
      if (tickInterval >= 5) {
        const minorStep = tickInterval / 5;
        for (let mt = t + minorStep; mt < t + tickInterval && mt <= totalDur; mt += minorStep) {
          rulerHTML += `<span class="ruler-tick minor" style="left:${HEADER_WIDTH + mt * PX_PER_SEC}px"></span>`;
        }
      }
    }
    ruler.innerHTML = rulerHTML;
    ruler.style.width = `${HEADER_WIDTH + width}px`;

    // Tracks
    container.innerHTML = this._tracks.map((track) => {
      const isSel = this.selectedTrackId === track.id;
      return `
        <div class="track-row${isSel ? ' selected' : ''}" data-track-id="${track.id}">
          <div class="track-header" title="Click to select track">
            <span class="track-name">${track.name}</span>
          </div>
          <div class="track-lane" style="width:${width}px">
            ${track.clips.map((clip, idx) => {
              const asset = this._assets.find((a) => a.id === clip.assetId);
              if (!asset) return '';
              const left = clip.startTime * PX_PER_SEC;
              const clipDur = this._clipSourceDuration(clip);
              const w = Math.max(clipDur * PX_PER_SEC, 20);
              const isSelected = this.selectedClip &&
                this.selectedClip.trackId === track.id &&
                this.selectedClip.clipIdx === idx;
              const regions = clip.pitchRegions || [];
              const regionsBadge = regions.length > 0
                ? `<span class="clip-pitch-badge">${regions.length} \u97f3\u9ad8\u5340</span>`
                : '';

              const srcStart = clip.sourceStart || 0;
              const srcDur = clip.sourceDuration > 0 ? clip.sourceDuration : (asset.duration || 5);
              const pitchRegionsJson = JSON.stringify(clip.pitchRegions || []);
              return `
                <div class="clip${isSelected ? ' selected' : ''}"
                     style="left:${left}px; width:${w}px"
                     data-clip-idx="${idx}"
                     title="Click to select · Shift+Click to split">
                  <canvas class="clip-wave"
                          data-asset-id="${asset.id}"
                          data-source-start="${srcStart}"
                          data-source-dur="${srcDur}"
                          data-pitch-regions="${this._esc(pitchRegionsJson)}"></canvas>
                  <span class="clip-name">${this._esc(asset.name)}</span>
                  ${regionsBadge}
                  ${isSelected ? `<button class="clip-delete" title="Remove">&times;</button>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');

    // Playhead — persistent in #lanes-scroll so it spans ruler + tracks
    const scrollEl = document.getElementById('lanes-scroll');
    let ph = document.getElementById('playhead');
    if (!ph) {
      ph = document.createElement('div');
      ph.id = 'playhead';
      ph.className = 'playhead';
      ph.innerHTML = '<span id="playhead-time" class="playhead-time">0:00.0</span>';
      scrollEl.appendChild(ph);
    }
    ph.style.left = `${HEADER_WIDTH + this.player.position * PX_PER_SEC}px`;
    this._updatePlayheadTime(this.player.position);

    // Draw waveforms after layout
    requestAnimationFrame(() => this._drawAllClipWaveforms());
  }

  _renderInspector() {
    if (this._reEditorCleanup) { this._reEditorCleanup(); this._reEditorCleanup = null; }
    this._reEditor = null;
    const panel = document.getElementById('inspector');
    if (!panel) return;

    // If a clip is selected, show clip editor
    const clipData = this._getSelectedClipData();
    if (clipData) {
      this._renderClipInspector(panel, clipData);
      return;
    }

    // Otherwise show track controls for selected track
    const track = this._tracks.find((t) => t.id === this.selectedTrackId);
    if (track) {
      this._renderTrackInspector(panel, track);
      return;
    }

    panel.innerHTML = '<div class="insp-empty">选择轨道或片段进行编辑</div>';
  }

  _renderTrackInspector(panel, track) {
    panel.innerHTML = `
      <div class="insp-header">
        <span class="insp-title">${this._esc(track.name)}</span>
        <div class="insp-track-badges">
          <button class="track-btn track-solo${track.solo ? ' active' : ''}" data-track-action="solo" data-track-id="${track.id}" title="Solo">S</button>
          <button class="track-btn track-mute${track.mute ? ' active' : ''}" data-track-action="mute" data-track-id="${track.id}" title="Mute">M</button>
        </div>
      </div>
      <div class="insp-track-ctrls">
        <div class="insp-ctrl-row">
          <span class="insp-label">音量</span>
          <input type="range" class="insp-fader" min="0" max="100"
                 value="${Math.round(track.volume * 100)}" data-track-ctrl="volume" data-track-id="${track.id}">
          <span class="insp-ctrl-val">${Math.round(track.volume * 100)}%</span>
        </div>
        <div class="insp-ctrl-row">
          <span class="insp-label">音调</span>
          <input type="range" class="insp-fader" min="-12" max="12" step="1"
                 value="${track.pitchShift}" data-track-ctrl="pitch" data-track-id="${track.id}">
          <span class="insp-ctrl-val">${track.pitchShift > 0 ? '+' : ''}${track.pitchShift} st</span>
        </div>
      </div>
      <div class="insp-hint">点击轨道 lane 上的片段可选中并在右下调整音高区域</div>
    `;

    // S / M buttons
    panel.querySelectorAll('[data-track-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.trackId);
        if (btn.dataset.trackAction === 'solo') this._toggleTrackSolo(id);
        else this._toggleTrackMute(id);
        this._renderAll();
      });
    });

    // Sliders — checkpoint on drag start, not on every input
    panel.querySelectorAll('[data-track-ctrl]').forEach(input => {
      const valSpan = input.nextElementSibling;
      input.addEventListener('pointerdown', () => this._checkpoint());
      input.addEventListener('input', () => {
        const id = Number(input.dataset.trackId);
        if (input.dataset.trackCtrl === 'volume') {
          const v = Number(input.value) / 100;
          this._setTrackVolume(id, v);
          valSpan.textContent = `${input.value}%`;
        } else {
          const st = Number(input.value);
          this._setTrackPitch(id, st);
          valSpan.textContent = `${st > 0 ? '+' : ''}${st} st`;
        }
      });
    });
  }

  _renderClipInspector(panel, data) {
    const { clip, asset } = data;
    const dur = this._clipSourceDuration(clip);
    const durFmt = this._fmtDurationMs(dur);
    const startFmt = this._fmtDurationMs(clip.startTime);
    const regions = clip.pitchRegions || [];

    panel.innerHTML = `
      <div class="insp-header">
        <span class="insp-title">片段: ${this._esc(asset ? asset.name : '?')}</span>
        <button class="insp-btn insp-btn-danger clip-delete-insp" title="删除此片段">&times; 删除</button>
      </div>
      <div class="insp-meta">
        <div class="insp-row"><span class="insp-label">起点</span><span>${startFmt}</span></div>
        <div class="insp-row"><span class="insp-label">时长</span><span>${durFmt}</span></div>
      </div>
      <div class="insp-region-hint">拖选一段时间调整音高 · 点击已有区域选中 · Del 删除选中区域</div>
      <canvas class="region-canvas" height="60"></canvas>
      <div id="region-ctrl" class="region-ctrl"></div>
    `;

    panel.querySelector('.clip-delete-insp').addEventListener('click', () => {
      if (this.selectedClip) this._deleteClip(this.selectedClip.trackId, this.selectedClip.clipIdx);
    });

    const canvas = panel.querySelector('.region-canvas');
    // Size canvas after layout
    requestAnimationFrame(() => {
      canvas.width = canvas.clientWidth;
      canvas.height = 60;
      this._initRegionEditor(canvas, data);
      this._drawRegionCanvas(canvas, clip, dur);
    });
  }

  _initRegionEditor(canvas, data) {
    const { trackId, clipIdx } = this.selectedClip || {};
    if (!trackId) return;
    const dur = this._clipSourceDuration(data.clip);
    if (!this._reEditor) this._reEditor = {};
    this._reEditor.selectedIdx = null;
    this._reEditor.dragging = false;

    const getClip = () => {
      const t = this._tracks.find(t => t.id === trackId);
      return t ? t.clips[clipIdx] : null;
    };
    const pxToTime = (px) => Math.max(0, Math.min(dur, (px / canvas.clientWidth) * dur));

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const t = pxToTime(px);
      const clip = getClip();
      if (!clip) return;

      const regions = clip.pitchRegions || [];
      let hit = -1;
      for (let i = 0; i < regions.length; i++) {
        if (t >= regions[i].start && t <= regions[i].end) { hit = i; break; }
      }

      if (hit >= 0) {
        this._reEditor.selectedIdx = hit;
        this._reEditor.dragging = false;
      } else {
        this._reEditor.selectedIdx = null;
        this._reEditor.dragging = true;
        this._reEditor.dragStartPx = px;
        this._reEditor.dragEndPx = px;
      }
      this._drawRegionCanvas(canvas, clip, dur);
      this._renderRegionCtrl(data, dur, canvas);
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this._reEditor?.dragging) return;
      const rect = canvas.getBoundingClientRect();
      this._reEditor.dragEndPx = e.clientX - rect.left;
      const clip = getClip();
      if (clip) this._drawRegionCanvas(canvas, clip, dur);
    });

    canvas.addEventListener('mouseup', (e) => {
      if (!this._reEditor?.dragging) return;
      const rect = canvas.getBoundingClientRect();
      this._reEditor.dragEndPx = e.clientX - rect.left;
      this._reEditor.dragging = false;

      const startT = pxToTime(Math.min(this._reEditor.dragStartPx, this._reEditor.dragEndPx));
      const endT   = pxToTime(Math.max(this._reEditor.dragStartPx, this._reEditor.dragEndPx));

      if (endT - startT >= 0.1) {
        this._checkpoint();
        const clip = getClip();
        if (!clip) return;
        clip.pitchRegions = clip.pitchRegions || [];
        clip.pitchRegions.push({ start: startT, end: endT, shift: 0 });
        this._reEditor.selectedIdx = clip.pitchRegions.length - 1;
        this._saveProject();
        this._drawRegionCanvas(canvas, clip, dur);
        this._renderRegionCtrl(data, dur, canvas);
      } else {
        this._drawRegionCanvas(canvas, getClip() || data.clip, dur);
      }
    });

    // Delete key removes selected region
    canvas._keyHandler = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this._reEditor?.selectedIdx != null) {
        const clip = getClip();
        if (!clip) return;
        this._checkpoint();
        clip.pitchRegions.splice(this._reEditor.selectedIdx, 1);
        this._reEditor.selectedIdx = null;
        this._saveProject();
        this._drawRegionCanvas(canvas, clip, dur);
        this._renderRegionCtrl(data, dur, canvas);
      }
    };
    window.addEventListener('keydown', canvas._keyHandler);
    // Clean up on next inspector render
    canvas._cleanup = () => window.removeEventListener('keydown', canvas._keyHandler);
    this._reEditorCleanup = canvas._cleanup;
  }

  _drawRegionCanvas(canvas, clip, dur) {
    const W = canvas.clientWidth || canvas.width;
    const H = canvas.clientHeight || canvas.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = 'var(--bg2, #111)';
    ctx.fillRect(0, 0, W, H);

    // Center baseline
    const midY = H / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();

    // Time tick marks
    const secPx = W / dur;
    const step = dur > 60 ? 10 : dur > 20 ? 5 : dur > 5 ? 1 : 0.5;
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = `9px monospace`;
    for (let t = 0; t <= dur + 0.01; t += step) {
      const x = t * secPx;
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(x, 0, 1, 8);
      if (t > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillText(this._fmtDurationMs(t), x + 2, 16);
      }
    }

    // Pitch regions
    const regions = clip.pitchRegions || [];
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      const x = r.start * secPx;
      const w = Math.max(2, (r.end - r.start) * secPx);
      const isSelected = i === this._reEditor?.selectedIdx;

      ctx.fillStyle = isSelected ? 'rgba(91,156,245,0.45)' : 'rgba(91,156,245,0.22)';
      ctx.fillRect(x, 0, w, H);
      ctx.strokeStyle = isSelected ? '#5b9cf5' : 'rgba(91,156,245,0.6)';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(x + 0.5, 0.5, w - 1, H - 1);

      const shift = r.shift || 0;
      if (w > 18) {
        ctx.fillStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.65)';
        ctx.font = `bold 10px monospace`;
        ctx.fillText(`${shift > 0 ? '+' : ''}${shift}st`, x + 3, H - 7);
      }
    }

    // Active drag preview
    if (this._reEditor?.dragging) {
      const x  = Math.min(this._reEditor.dragStartPx, this._reEditor.dragEndPx);
      const w  = Math.abs(this._reEditor.dragEndPx - this._reEditor.dragStartPx);
      ctx.fillStyle = 'rgba(255,210,0,0.15)';
      ctx.fillRect(x, 0, w, H);
      ctx.strokeStyle = 'rgba(255,210,0,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, 0.5, w - 1, H - 1);
    }
  }

  _renderRegionCtrl(data, dur, canvas) {
    const ctrl = document.getElementById('region-ctrl');
    if (!ctrl) return;
    const idx = this._reEditor?.selectedIdx;
    const clip = this._getSelectedClipData()?.clip;
    if (idx == null || !clip || !clip.pitchRegions[idx]) {
      ctrl.innerHTML = '<span class="insp-hint">拖选时间范围来创建音高區域</span>';
      return;
    }
    const r = clip.pitchRegions[idx];
    const shift = r.shift ?? 0;
    const label = shift === 0 ? '0 st' : `${shift > 0 ? '+' : ''}${shift} st`;

    ctrl.innerHTML = `
      <div class="insp-ctrl-row">
        <span class="insp-label" style="min-width:36px">区域 ${idx + 1} 音高</span>
        <button class="pitch-step-btn" data-delta="-1">&#9660;1</button>
        <button class="pitch-step-btn" data-delta="-0.5">&#9660;½</button>
        <input type="range" class="insp-fader" id="region-pitch-slider"
               min="-12" max="12" step="0.5" value="${shift}">
        <button class="pitch-step-btn" data-delta="0.5">&#9650;½</button>
        <button class="pitch-step-btn" data-delta="1">&#9650;1</button>
        <span class="insp-ctrl-val" id="region-pitch-val">${label}</span>
        <button class="insp-btn" id="region-pitch-reset" title="重置">↺</button>
        <button class="insp-btn insp-btn-danger" id="region-delete" title="删除區域">&times;</button>
      </div>
      <div class="insp-hint">时间: ${this._fmtDurationMs(r.start)} – ${this._fmtDurationMs(r.end)}
        (${(r.end - r.start).toFixed(2)}s)</div>
    `;

    const slider = ctrl.querySelector('#region-pitch-slider');
    const valSpan = ctrl.querySelector('#region-pitch-val');

    const applyShift = (v) => {
      const c = this._getSelectedClipData()?.clip;
      if (!c || !c.pitchRegions[idx]) return;
      const clamped = Math.max(-12, Math.min(12, v));
      c.pitchRegions[idx].shift = clamped;
      slider.value = clamped;
      valSpan.textContent = clamped === 0 ? '0 st' : `${clamped > 0 ? '+' : ''}${clamped} st`;
      this._drawRegionCanvas(canvas, c, dur);
      this._saveProject();
    };

    slider.addEventListener('pointerdown', () => this._checkpoint());
    slider.addEventListener('input', () => applyShift(parseFloat(slider.value)));

    ctrl.querySelectorAll('.pitch-step-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = this._getSelectedClipData()?.clip;
        if (!c || !c.pitchRegions[idx]) return;
        this._checkpoint();
        applyShift((c.pitchRegions[idx].shift || 0) + parseFloat(btn.dataset.delta));
      });
    });

    ctrl.querySelector('#region-pitch-reset').addEventListener('click', () => {
      this._checkpoint();
      applyShift(0);
    });
    ctrl.querySelector('#region-delete').addEventListener('click', () => {
      const c = this._getSelectedClipData()?.clip;
      if (!c) return;
      this._checkpoint();
      c.pitchRegions.splice(idx, 1);
      this._reEditor.selectedIdx = null;
      this._saveProject();
      this._drawRegionCanvas(canvas, c, dur);
      ctrl.innerHTML = '<span class="insp-hint">拖选时间范围来创建音高區域</span>';
    });
  }

  _renderTransportButtons() {
    const playBtn = document.getElementById('btn-play');
    if (playBtn) playBtn.classList.toggle('active', this.player.isPlaying());

    const splitBtn = document.getElementById('btn-split');
    const mergeBtn = document.getElementById('btn-merge');
    const hasSelection = !!this.selectedClip;
    if (splitBtn) splitBtn.disabled = !hasSelection;
    if (mergeBtn) mergeBtn.disabled = !hasSelection;

    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = this._history.length === 0;
    if (redoBtn) redoBtn.disabled = this._future.length === 0;
  }

  /* ---- Pitch canvas ---- */
  // (removed — pitch editing now lives in the inspector region editor)

  /* ---- Waveform ---- */

  async _ensureWaveformPeaks(assetId) {
    if (this._waveformCache.has(assetId)) return this._waveformCache.get(assetId);
    const asset = this._assets.find(a => a.id === assetId);
    if (!asset?.audioBlob) { this._waveformCache.set(assetId, null); return null; }
    try {
      const arrayBuffer = await asset.audioBlob.arrayBuffer();
      const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);
      const channelData = audioBuffer.getChannelData(0);
      const sr = audioBuffer.sampleRate;
      const bucketSize = Math.max(1, Math.floor(sr / WAVEFORM_RATE));
      const numBuckets = Math.ceil(channelData.length / bucketSize);
      const peaks = new Float32Array(numBuckets);
      for (let i = 0; i < numBuckets; i++) {
        const start = i * bucketSize;
        const end = Math.min(start + bucketSize, channelData.length);
        let max = 0;
        for (let j = start; j < end; j++) {
          const v = Math.abs(channelData[j]);
          if (v > max) max = v;
        }
        peaks[i] = max;
      }
      this._waveformCache.set(assetId, peaks);
      return peaks;
    } catch (e) {
      console.warn('Waveform decode failed', assetId, e);
      this._waveformCache.set(assetId, null);
      return null;
    }
  }

  async _drawAllClipWaveforms() {
    const canvases = document.querySelectorAll('canvas.clip-wave');
    for (const canvas of canvases) {
      const assetId = Number(canvas.dataset.assetId);
      const sourceStart = parseFloat(canvas.dataset.sourceStart || '0');
      const sourceDur = parseFloat(canvas.dataset.sourceDur || '5');
      let pitchRegions = [];
      try { pitchRegions = JSON.parse(canvas.dataset.pitchRegions || '[]'); } catch (_) {}
      let peaks = this._waveformCache.get(assetId);
      if (peaks === undefined) {
        peaks = await this._ensureWaveformPeaks(assetId);
      }
      if (peaks) this._drawClipWave(canvas, peaks, sourceStart, sourceDur, pitchRegions);
    }
  }

  _drawClipWave(canvas, peaks, sourceStart, sourceDur, pitchRegions = []) {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    // ── Top lane: pitch regions (35% height) ──────────────────────────
    const pitchH = Math.floor(H * 0.35);
    // background
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, W, pitchH);
    // divider
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, pitchH - 1, W, 1);
    // regions
    for (const r of pitchRegions) {
      if (!r.shift) continue;
      const x0 = Math.round(((r.start - 0) / sourceDur) * W);
      const x1 = Math.round(((r.end   - 0) / sourceDur) * W);
      const ratio = Math.min(1, Math.abs(r.shift) / 12);
      const alpha = 0.3 + ratio * 0.45;
      ctx.fillStyle = r.shift > 0
        ? `rgba(80,220,120,${alpha})`   // green = pitch up
        : `rgba(255,120,80,${alpha})`;  // red   = pitch down
      ctx.fillRect(x0, 1, Math.max(1, x1 - x0), pitchH - 2);
      // semitone label if wide enough
      if (x1 - x0 > 18) {
        ctx.font = `bold ${Math.min(8, pitchH - 2)}px monospace`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.textBaseline = 'middle';
        const label = (r.shift > 0 ? '+' : '') + r.shift + 'st';
        ctx.fillText(label, x0 + 2, pitchH / 2);
      }
    }

    // ── Bottom lane: amplitude waveform (65% height) ──────────────────
    const waveTop = pitchH;
    const waveH = H - pitchH;
    const midY = waveTop + waveH / 2;
    ctx.fillStyle = 'rgba(91, 156, 245, 0.60)';
    for (let x = 0; x < W; x++) {
      const t = sourceStart + (x / W) * sourceDur;
      const bi = Math.min(peaks.length - 1, Math.max(0, Math.floor(t * WAVEFORM_RATE)));
      const peak = peaks[bi];
      if (peak <= 0) continue;
      const h = Math.max(1, peak * (waveH - 2) * 0.88);
      ctx.fillRect(x, midY - h / 2, 1, h);
    }
  }

  /* ---- Helpers ---- */

  _clipSourceDuration(clip) {
    if (clip.sourceDuration > 0) return clip.sourceDuration;
    const a = this._assets.find((x) => x.id === clip.assetId);
    return a ? (a.duration || 5) : 5;
  }

  _fmtDurationMs(secs) {
    // Format with milliseconds for region editor precision
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.round((secs % 1) * 10);
    return `${m}:${String(s).padStart(2, '0')}.${ms}`;
  }

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  _fmtDuration(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  _getBlobUrl(assetId, blob) {
    if (!blob) {
      const asset = this._assets.find((a) => a.id === assetId);
      if (!asset) return null;
      blob = asset.audioBlob;
    }
    if (this._blobUrls.has(assetId)) return this._blobUrls.get(assetId);
    const url = URL.createObjectURL(blob);
    this._blobUrls.set(assetId, url);
    return url;
  }

  _revokeBlobUrl(assetId) {
    if (this._blobUrls.has(assetId)) {
      URL.revokeObjectURL(this._blobUrls.get(assetId));
      this._blobUrls.delete(assetId);
    }
  }

  _getBlobDuration(blob) {
    return new Promise((resolve) => {
      const audio = new Audio();
      audio.src = URL.createObjectURL(blob);
      audio.addEventListener('loadedmetadata', () => {
        URL.revokeObjectURL(audio.src);
        resolve(audio.duration || 0);
      });
      audio.addEventListener('error', () => resolve(0));
    });
  }
}

const app = new App();
app.init();
