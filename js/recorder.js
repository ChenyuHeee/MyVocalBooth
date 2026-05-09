class Recorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.onTimerTick = null;
    this._timerInterval = null;
    this._startTime = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream);

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.mediaRecorder.start();

    this._startTime = Date.now();
    this._timerInterval = setInterval(() => {
      if (this.onTimerTick) {
        const elapsed = Math.floor((Date.now() - this._startTime) / 1000);
        this.onTimerTick(elapsed);
      }
    }, 200);
  }

  stop() {
    return new Promise((resolve) => {
      this.mediaRecorder.onstop = () => {
        clearInterval(this._timerInterval);
        this.stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        this.chunks = [];
        resolve(blob);
      };
      this.mediaRecorder.stop();
    });
  }

  isRecording() {
    return this.mediaRecorder && this.mediaRecorder.state === 'recording';
  }
}
