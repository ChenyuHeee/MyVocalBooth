class Player {
  constructor() {
    this.masterGain = new Tone.Gain(0.8).toDestination();
    this._nodes = [];
    this._playheadCb = null;
    this._rafId = null;
    this.pixelsPerSecond = 40;
  }

  async play(tracks, getBlob) {
    // Remember current position so resume-after-drag works correctly
    const resumePos = Tone.Transport.seconds;
    this.cleanup();
    // Always stop Transport fully so re-scheduling applies cleanly
    Tone.Transport.stop();
    const anySolo = tracks.some((t) => t.solo);

    for (const track of tracks) {
      if (anySolo ? !track.solo : track.mute) continue;

      const trackGain = new Tone.Gain(track.volume);
      trackGain.connect(this.masterGain);

      for (const clip of track.clips) {
        const blob = getBlob(clip.assetId);
        if (!blob) continue;

        // Decode blob to AudioBuffer directly — more reliable than URL loading
        let audioBuffer;
        try {
          const arrayBuffer = await blob.arrayBuffer();
          audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);
        } catch (err) {
          console.error('Failed to decode audio for clip', clip.assetId, err);
          continue;
        }

        // Per-clip PitchShift: track base + clip fine-tune
        const baseShift = track.pitchShift || 0;
        const ps = new Tone.PitchShift(baseShift);
        ps.wet.value = 1;
        ps.connect(trackGain);
        this._scheduleIds = this._scheduleIds || [];

        const player = new Tone.Player(audioBuffer);
        player.connect(ps);

        // Schedule region pitch changes at region start/end
        const regions = [...(clip.pitchRegions || [])].sort((a, b) => a.start - b.start);
        for (const r of regions) {
          const id1 = Tone.Transport.schedule(() => { ps.pitch = baseShift + (r.shift || 0); }, clip.startTime + r.start);
          const id2 = Tone.Transport.schedule(() => { ps.pitch = baseShift; }, clip.startTime + r.end);
          this._scheduleIds.push(id1, id2);
        }

        const srcOffset = clip.sourceStart || 0;
        const srcDur = clip.sourceDuration > 0 ? clip.sourceDuration : undefined;
        player.sync().start(clip.startTime, srcOffset, srcDur);
        this._nodes.push({ player, gain: trackGain, ps });
      }
    }

    // Restore position then start
    Tone.Transport.seconds = resumePos;
    Tone.Transport.start();
    this._startPlayhead();
  }

  pause() {
    Tone.Transport.pause();
    this._stopPlayhead();
  }

  stop() {
    Tone.Transport.stop();
    this._stopPlayhead();
    this.cleanup();
  }

  cleanup() {
    this._stopPlayhead();
    if (this._scheduleIds) {
      for (const id of this._scheduleIds) {
        try { Tone.Transport.clear(id); } catch (_) {}
      }
      this._scheduleIds = [];
    }
    for (const { player, gain, ps } of this._nodes) {
      try { player.stop(); } catch (_) {}
      try { player.unsync(); } catch (_) {}
      try { player.dispose(); } catch (_) {}
      try { gain.dispose(); } catch (_) {}
      try { ps.dispose(); } catch (_) {}
    }
    this._nodes = [];
  }

  get position() { return Tone.Transport.seconds; }
  set position(v) { Tone.Transport.seconds = v; }

  seek(time) {
    const wasPlaying = Tone.Transport.state === 'started';
    Tone.Transport.pause();
    Tone.Transport.seconds = time;
    // Can't resume with scheduled events — just stop and let user re-play
    this.cleanup();
    if (this._playheadCb) this._playheadCb(time);
  }

  isPlaying() { return Tone.Transport.state === 'started'; }

  _startPlayhead() {
    this._stopPlayhead();
    const tick = () => {
      if (Tone.Transport.state !== 'started') { this._stopPlayhead(); return; }
      if (this._playheadCb) this._playheadCb(Tone.Transport.seconds);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopPlayhead() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  onPlayhead(cb) { this._playheadCb = cb; }
}
