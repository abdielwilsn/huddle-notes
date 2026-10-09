// IndexedDB storage shared by the offscreen recorder and the viewer page.
// meetings: { id, title, url, startedAt, endedAt, durationMs, status, mode, tracks, transcript, summary, error }
// segments: { key, meetingId, track ('mix'|'me'|'them'), index, startMs, endMs, size, blob, result }

let _hnDb = null;

function hnOpenDb() {
  if (_hnDb) return Promise.resolve(_hnDb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('huddle-notes', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meetings')) db.createObjectStore('meetings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('segments')) {
        const s = db.createObjectStore('segments', { keyPath: 'key', autoIncrement: true });
        s.createIndex('meetingId', 'meetingId');
      }
    };
    req.onsuccess = () => { _hnDb = req.result; resolve(_hnDb); };
    req.onerror = () => reject(req.error);
  });
}

function hnReq(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function hnStore(name, mode = 'readonly') {
  const db = await hnOpenDb();
  return db.transaction(name, mode).objectStore(name);
}

const DB = {
  async putMeeting(m) { const db = await hnOpenDb(); return hnReq(db.transaction('meetings', 'readwrite').objectStore('meetings').put(m)); },
  async getMeeting(id) { const db = await hnOpenDb(); return hnReq(db.transaction('meetings').objectStore('meetings').get(id)); },
  async listMeetings() {
    const db = await hnOpenDb();
    const all = await hnReq(db.transaction('meetings').objectStore('meetings').getAll());
    return all.sort((a, b) => b.startedAt - a.startedAt);
  },
  async updateMeeting(id, patch) {
    const m = await DB.getMeeting(id);
    if (!m) return null;
    Object.assign(m, patch);
    await DB.putMeeting(m);
    return m;
  },
  async addSegment(s) { const db = await hnOpenDb(); return hnReq(db.transaction('segments', 'readwrite').objectStore('segments').add(s)); },
  async putSegment(s) { const db = await hnOpenDb(); return hnReq(db.transaction('segments', 'readwrite').objectStore('segments').put(s)); },
  async getSegments(meetingId) {
    const db = await hnOpenDb();
    const segs = await hnReq(db.transaction('segments').objectStore('segments').index('meetingId').getAll(meetingId));
    return segs.sort((a, b) => (a.track === b.track ? a.index - b.index : a.track < b.track ? -1 : 1));
  },
  async deleteMeeting(id) {
    const segs = await DB.getSegments(id);
    const db = await hnOpenDb();
    const tx = db.transaction(['meetings', 'segments'], 'readwrite');
    tx.objectStore('meetings').delete(id);
    for (const s of segs) tx.objectStore('segments').delete(s.key);
    return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  }
};
