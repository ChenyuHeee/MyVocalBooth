class AssetsDB {
  constructor() {
    this.db = new Dexie('MyVocalBooth');
    // v1: original takes table
    this.db.version(1).stores({
      takes: '++id, name, volume, pitchShift, isStarred, createdAt'
    });
    // v2: keep takes, add assets + project (don't drop takes!)
    this.db.version(2).stores({
      takes: '++id, name, volume, pitchShift, isStarred, createdAt',
      assets: '++id, name, isStarred, createdAt',
      project: 'key'
    });
  }

  /* ---- Assets ---- */

  async addAsset(blob, name) {
    return this.db.assets.add({
      name,
      audioBlob: blob,
      isStarred: false,
      createdAt: new Date(),
      duration: 0
    });
  }

  async getAssets() {
    let assets = await this.db.assets.orderBy('createdAt').toArray();
    // Migration: if assets table is empty, try copying from old takes table
    if (assets.length === 0) {
      try {
        const takes = await this.db.takes.orderBy('createdAt').toArray();
        if (takes.length > 0) {
          for (const t of takes) {
            await this.db.assets.add({
              name: t.name,
              audioBlob: t.audioBlob,
              isStarred: t.isStarred || false,
              createdAt: t.createdAt || new Date(),
              duration: t.duration || 0
            });
          }
          assets = await this.db.assets.orderBy('createdAt').toArray();
        }
      } catch (_) { /* takes table may not exist */ }
    }
    return assets;
  }

  async getAsset(id) {
    return this.db.assets.get(id);
  }

  async updateAsset(id, changes) {
    return this.db.assets.update(id, changes);
  }

  async removeAsset(id) {
    return this.db.assets.delete(id);
  }

  async assetCount() {
    return this.db.assets.count();
  }

  /* ---- Project / Timeline ---- */

  _defaultProject() {
    return {
      key: 'main',
      tracks: [
        { id: 1, name: 'Track 1', volume: 0.8, pitchShift: 0, mute: false, solo: false, clips: [] },
        { id: 2, name: 'Track 2', volume: 0.8, pitchShift: 0, mute: false, solo: false, clips: [] },
        { id: 3, name: 'Track 3', volume: 0.8, pitchShift: 0, mute: false, solo: false, clips: [] },
        { id: 4, name: 'Track 4', volume: 0.8, pitchShift: 0, mute: false, solo: false, clips: [] }
      ]
    };
  }

  async loadProject() {
    let proj = await this.db.project.get('main');
    if (!proj) {
      proj = this._defaultProject();
      await this.db.project.put(proj);
    }
    // Defensive: ensure tracks is a valid array
    if (!proj.tracks || !Array.isArray(proj.tracks)) {
      proj.tracks = [];
    }
    // Ensure all 4 tracks exist (fixes partial data)
    const defaults = this._defaultProject();
    for (let i = 0; i < defaults.tracks.length; i++) {
      if (!proj.tracks[i]) proj.tracks[i] = defaults.tracks[i];
    }
    return proj;
  }

  async saveProject(project) {
    return this.db.project.put(project);
  }
}
