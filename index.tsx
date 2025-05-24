/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */

import {GoogleGenAI, GenerateContentResponse} from '@google/genai';
import {marked} from 'marked';

const MODEL_NAME = 'gemini-2.5-flash-preview-04-17';
const CHUNK_DURATION_MS = 15000; // 15 seconds for chunked recording for Gemini
// const LOCAL_WHISPER_URL = 'ws://localhost:8000/ws/transcribe'; // Default for realtime-transcription-fastrtc - REMOVED

type InferenceEngine = 'gemini' | 'localWhisper';

interface Note {
  id: string;
  rawTranscription: string;
  polishedNote: string;
  timestamp: number;
  sourceEngine: InferenceEngine;
}

class VoiceNotesApp {
  private genAI: GoogleGenAI;
  private mediaRecorder: MediaRecorder | null = null;
  private recordButton: HTMLButtonElement;
  private recordingStatus: HTMLDivElement;
  private rawTranscription: HTMLDivElement;
  private polishedNote: HTMLDivElement;
  private newButton: HTMLButtonElement;
  private newButtonIcon: HTMLElement;
  private themeToggleButton: HTMLButtonElement;
  private themeToggleIcon: HTMLElement;
  private savePolishedButton: HTMLButtonElement;
  private saveRawButton: HTMLButtonElement;
  private exportVideoCaptionButton: HTMLButtonElement;
  private polishWithGeminiButton: HTMLButtonElement;
  private uploadAudioInput: HTMLInputElement;
  private editorTitle: HTMLDivElement;

  private audioChunks: Blob[] = [];
  private isRecording = false;
  private currentNote: Note | null = null;
  private stream: MediaStream | null = null;
  
  private cumulativeRawTranscription: string = '';
  private isProcessingChunk: boolean = false; // Used for Gemini chunking
  private hasContentInCurrentNote: boolean = false;

  private recordingInterface: HTMLDivElement;
  private liveRecordingTitle: HTMLDivElement;
  private liveWaveformCanvas: HTMLCanvasElement | null;
  private liveWaveformCtx: CanvasRenderingContext2D | null = null;
  private liveRecordingTimerDisplay: HTMLDivElement;
  private statusIndicatorDiv: HTMLDivElement | null;

  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private waveformDataArray: Uint8Array | null = null;
  private waveformDrawingId: number | null = null;
  private timerIntervalId: number | null = null;
  private recordingStartTime: number = 0;

  private inferenceEngineToggleInputs: NodeListOf<HTMLInputElement>;
  private currentInferenceEngine: InferenceEngine = 'gemini';
  // private localWhisperSocket: WebSocket | null = null; // REMOVED
  private switchSelectionIndicator: HTMLSpanElement;

  // Properties for WebRTC and EventSource
  private peerConnection: RTCPeerConnection | null = null;
  private webrtcId: string | null = null;
  private transcriptionEventSource: EventSource | null = null;
  private localApiBaseUrl: string = 'http://localhost:7860';


  constructor() {
    if (!process.env.API_KEY) {
      this.displayApiKeyError();
      // Prevent further initialization if API key is missing
      // by not assigning critical elements or binding listeners.
      // User will only see the error message.
      return;
    }
    this.genAI = new GoogleGenAI({apiKey: process.env.API_KEY});

    this.recordButton = document.getElementById('recordButton') as HTMLButtonElement;
    this.recordingStatus = document.getElementById('recordingStatus') as HTMLDivElement;
    this.rawTranscription = document.getElementById('rawTranscription') as HTMLDivElement;
    this.polishedNote = document.getElementById('polishedNote') as HTMLDivElement;
    this.newButton = document.getElementById('newButton') as HTMLButtonElement;
    this.newButtonIcon = this.newButton.querySelector('i') as HTMLElement;
    this.themeToggleButton = document.getElementById('themeToggleButton') as HTMLButtonElement;
    this.themeToggleIcon = this.themeToggleButton.querySelector('i') as HTMLElement;
    this.editorTitle = document.querySelector('.editor-title') as HTMLDivElement;
    
    this.savePolishedButton = document.getElementById('savePolishedButton') as HTMLButtonElement;
    this.saveRawButton = document.getElementById('saveRawButton') as HTMLButtonElement;
    this.exportVideoCaptionButton = document.getElementById('exportVideoCaptionButton') as HTMLButtonElement;
    this.polishWithGeminiButton = document.getElementById('polishWithGeminiButton') as HTMLButtonElement;
    this.uploadAudioInput = document.getElementById('uploadAudioInput') as HTMLInputElement;

    this.recordingInterface = document.querySelector('.recording-interface') as HTMLDivElement;
    this.liveRecordingTitle = document.getElementById('liveRecordingTitle') as HTMLDivElement;
    this.liveWaveformCanvas = document.getElementById('liveWaveformCanvas') as HTMLCanvasElement;
    this.liveRecordingTimerDisplay = document.getElementById('liveRecordingTimerDisplay') as HTMLDivElement;
    
    if (this.liveWaveformCanvas) {
      this.liveWaveformCtx = this.liveWaveformCanvas.getContext('2d');
    }
    if (this.recordingInterface) {
      this.statusIndicatorDiv = this.recordingInterface.querySelector('.status-indicator') as HTMLDivElement;
    }

    this.inferenceEngineToggleInputs = document.querySelectorAll('input[name="inferenceEngine"]') as NodeListOf<HTMLInputElement>;
    this.switchSelectionIndicator = document.querySelector('.toggle-switch .switch-selection') as HTMLSpanElement;


    this.bindEventListeners();
    this.initTheme();
    this.initInferenceEngineToggle();
    this.createNewNote(); 
    this.updateHasContent(); 

    this.recordingStatus.textContent = 'Ready to record';

    [this.editorTitle, this.rawTranscription, this.polishedNote].forEach(el => {
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) {
            if (!el.textContent?.trim() || el.textContent?.trim() === placeholder) {
                el.textContent = placeholder;
                el.classList.add('placeholder-active');
            } else {
                 el.classList.remove('placeholder-active');
            }

            el.addEventListener('focus', () => {
                if (el.classList.contains('placeholder-active')) {
                    el.textContent = '';
                    el.classList.remove('placeholder-active');
                }
            });
            el.addEventListener('blur', () => {
                if (!el.textContent?.trim()) {
                    el.textContent = placeholder;
                    el.classList.add('placeholder-active');
                }
                 this.updateHasContent(); 
            });
        }
    });
  }

  private displayApiKeyError(): void {
    const appContainer = document.querySelector('.app-container');
    if (appContainer) {
        appContainer.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: Inter, sans-serif; background-color: var(--color-bg-dark); color: var(--color-text-dark); padding: 30px; text-align: center; box-sizing: border-box;">
            <h1 style="font-size: 24px; margin-bottom: 15px; color: var(--color-recording-dark);">API Key Not Found</h1>
            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 20px;">The <code>API_KEY</code> environment variable is not set or accessible.</p>
            <p style="font-size: 14px; line-height: 1.6; color: var(--color-text-secondary-dark);">This application cannot function without a valid Google Gemini API key. Please ensure the API key is correctly configured in your environment and the application is built/served in a way that makes <code>process.env.API_KEY</code> available to the frontend JavaScript.</p>
            <p style="font-size: 12px; margin-top: 30px; color: var(--color-text-tertiary-dark);">If you are developing locally, you might need to set this in a <code>.env</code> file or through your build process.</p>
          </div>
        `;
    }
    console.error('FATAL: API_KEY environment variable not set. Application cannot start.');
  }

  private initInferenceEngineToggle(): void {
    this.inferenceEngineToggleInputs.forEach(input => {
      input.addEventListener('change', (event) => {
        const selectedEngine = (event.target as HTMLInputElement).value as InferenceEngine;
        this.setInferenceEngine(selectedEngine);
      });
    });
    // Set initial state from checked input
    const checkedInput = document.querySelector('input[name="inferenceEngine"]:checked') as HTMLInputElement;
    this.currentInferenceEngine = (checkedInput?.value as InferenceEngine) || 'gemini';
    this.updateToggleSwitchUI(this.currentInferenceEngine);
    this.updateUIForInferenceEngine();
  }

  private updateToggleSwitchUI(engine: InferenceEngine): void {
    const selectedLabel = document.querySelector(`.toggle-switch label[for="engine${engine.charAt(0).toUpperCase() + engine.slice(1)}"]`) as HTMLElement;
    if (selectedLabel && this.switchSelectionIndicator) {
        this.switchSelectionIndicator.style.left = `${selectedLabel.offsetLeft}px`;
        this.switchSelectionIndicator.style.width = `${selectedLabel.offsetWidth}px`;
    }
  }

  private setInferenceEngine(engine: InferenceEngine): void {
    if (this.isRecording) {
      // If recording with localWhisper and trying to switch, stop localWhisper first.
      if (this.currentInferenceEngine === 'localWhisper') {
        alert("Switching engine: Local Whisper recording will be stopped.");
        this.stopRecordingLocalWhisper(); // Stop local whisper
      } else {
        alert("Please stop the current Cloud recording before changing the inference engine.");
        // Revert UI to current engine if it was a cloud recording
        this.inferenceEngineToggleInputs.forEach(input => {
          input.checked = input.value === this.currentInferenceEngine;
        });
        return;
      }
    }
    this.currentInferenceEngine = engine;
    console.log(`Inference engine set to: ${this.currentInferenceEngine}`);
    this.updateUIForInferenceEngine();
    this.updateToggleSwitchUI(engine);
  }

  private updateUIForInferenceEngine(): void {
    // Adjust UI elements based on the selected engine
    if (this.currentInferenceEngine === 'localWhisper') {
      this.recordButton.classList.add('local-recording'); // Visual cue for local
      // Show polish with Gemini button if there's raw content from local
      this.updatePolishWithGeminiButtonVisibility();
    } else {
      this.recordButton.classList.remove('local-recording');
      this.polishWithGeminiButton.classList.add('hidden');
    }
    this.updateHasContent(); // Re-evaluates save buttons etc.
  }


  private bindEventListeners(): void {
    this.recordButton.addEventListener('click', () => this.toggleRecording());
    this.newButton.addEventListener('click', () => this.handleNewUploadClearClick());
    this.themeToggleButton.addEventListener('click', () => this.toggleTheme());
    this.savePolishedButton.addEventListener('click', () => this.savePolishedContent());
    this.saveRawButton.addEventListener('click', () => this.saveRawTranscript());
    this.exportVideoCaptionButton.addEventListener('click', () => this.exportVideoWithCaptions());
    this.polishWithGeminiButton.addEventListener('click', () => this.polishLocalTranscriptWithGemini());
    this.uploadAudioInput.addEventListener('change', (event) => this.handleFileUpload(event));
    
    window.addEventListener('resize', () => {
        this.handleResize();
        this.updateToggleSwitchUI(this.currentInferenceEngine); // Keep toggle indicator correct
    });
    this.editorTitle.addEventListener('input', () => this.updateHasContent());
    this.rawTranscription.addEventListener('input', () => this.updateHasContent());
    this.polishedNote.addEventListener('input', () => this.updateHasContent());
  }

  private handleResize(): void {
    if (this.isRecording && this.liveWaveformCanvas && this.liveWaveformCanvas.style.display === 'block') {
      requestAnimationFrame(() => { this.setupCanvasDimensions(); });
    }
  }
  private setupCanvasDimensions(): void {
    if (!this.liveWaveformCanvas || !this.liveWaveformCtx) return;
    const canvas = this.liveWaveformCanvas;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    this.liveWaveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private initTheme(): void {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      document.body.classList.remove('light-mode');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private toggleTheme(): void {
    document.body.classList.toggle('light-mode');
    const isLight = document.body.classList.contains('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    this.themeToggleIcon.classList.toggle('fa-sun', !isLight);
    this.themeToggleIcon.classList.toggle('fa-moon', isLight);
  }

  private updateNewUploadButtonUI(): void {
    if (this.hasContentInCurrentNote) {
      this.newButton.title = 'Clear Current Note';
      this.newButtonIcon.className = 'fas fa-eraser';
      this.savePolishedButton.style.display = 'flex'; 
      this.saveRawButton.style.display = 'flex';
      if (this.currentNote?.sourceEngine === 'localWhisper' && this.cumulativeRawTranscription.trim()) {
        this.exportVideoCaptionButton.style.display = 'flex';
      } else {
        this.exportVideoCaptionButton.style.display = 'none';
      }
    } else {
      this.newButton.title = 'Upload Audio/Video';
      this.newButtonIcon.className = 'fas fa-upload'; 
      this.savePolishedButton.style.display = 'none'; 
      this.saveRawButton.style.display = 'none';
      this.exportVideoCaptionButton.style.display = 'none';
    }
    this.updatePolishWithGeminiButtonVisibility();
  }
  
  private updateHasContent(): void {
    const rawText = this.cumulativeRawTranscription.trim() || (this.rawTranscription.textContent?.trim() && !this.rawTranscription.classList.contains('placeholder-active') ? this.rawTranscription.textContent.trim() : '');
    
    let polishedText = '';
     if (!this.polishedNote.classList.contains('placeholder-active') && this.polishedNote.innerHTML.trim() !== '<p><em>Polishing... (AI is thinking)</em></p>') {
        polishedText = this.polishedNote.textContent?.trim() || this.polishedNote.innerHTML.trim(); // Consider innerHTML for existence if textContent is empty but elements exist
    }

    let titleText = '';
    if (!this.editorTitle.classList.contains('placeholder-active')) {
        titleText = this.editorTitle.textContent?.trim() || '';
    }
    
    this.hasContentInCurrentNote = !!(rawText || polishedText || titleText);
    this.updateNewUploadButtonUI();
  }

  private updatePolishWithGeminiButtonVisibility(): void {
    const showButton = this.currentInferenceEngine === 'localWhisper' &&
                       this.hasContentInCurrentNote &&
                       this.cumulativeRawTranscription.trim() !== '' &&
                       this.currentNote?.polishedNote === this.cumulativeRawTranscription; // Show if polished is same as raw (i.e. not yet Gemini polished)
    this.polishWithGeminiButton.classList.toggle('hidden', !showButton);
  }


  private handleNewUploadClearClick(): void {
    if (this.isRecording) {
        this.recordingStatus.textContent = "Please stop recording before clearing or uploading.";
        this.recordingStatus.style.color = 'var(--color-recording)';
        setTimeout(() => { this.recordingStatus.style.color = '';}, 2000);
        return;
    }

    if (this.hasContentInCurrentNote) {
      this.confirmClearNote();
    } else {
      this.triggerFileUpload();
    }
  }

  private triggerFileUpload(): void {
    this.uploadAudioInput.value = ''; 
    this.uploadAudioInput.click();
  }

  private async handleFileUpload(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    // For uploads, always use Gemini for now, or adapt based on selected engine.
    // Let's assume uploaded files are processed by Gemini.
    if (this.currentInferenceEngine === 'localWhisper') {
        alert("File uploads are processed by Gemini Cloud. Switching engine to Cloud for this file.");
        this.setInferenceEngine('gemini');
        (document.getElementById('engineGemini') as HTMLInputElement).checked = true;
        this.updateToggleSwitchUI('gemini');
    }


    this.recordingStatus.textContent = 'Processing uploaded file...';
    this.createNewNote('gemini'); // Default to Gemini for uploads
    this.editorTitle.textContent = file.name.split('.').slice(0, -1).join('.') || 'Uploaded File';
    this.editorTitle.classList.remove('placeholder-active');

    try {
      const base64Audio = await this.fileToBase64(file);
      const mimeType = file.type || (file.name.endsWith('.webm') ? 'audio/webm' : 'application/octet-stream');
      
      this.cumulativeRawTranscription = ''; 
      await this.performTranscriptionGemini(base64Audio, mimeType, false); 
      this.recordingStatus.textContent = 'File processing complete.';

    } catch (error) {
      console.error('Error processing uploaded file:', error);
      this.recordingStatus.textContent = 'Error processing file. Please try again.';
      this.updateHasContent();
    }
  }

  private fileToBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64data = reader.result as string;
        resolve(base64data.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  private confirmClearNote(): void {
    if (confirm('Are you sure you want to clear the current note and title? This action cannot be undone.')) {
      this.createNewNote(this.currentInferenceEngine); 
    }
  }
  
  private async toggleRecording(): Promise<void> {
    if (!this.isRecording) {
      if (this.currentInferenceEngine === 'gemini') {
        await this.startRecordingGemini();
      } else if (this.currentInferenceEngine === 'localWhisper') { // Added explicit check
        await this.startRecordingLocalWhisper();
      }
    } else {
      if (this.currentInferenceEngine === 'gemini') {
        await this.stopRecordingGemini();
      } else if (this.currentInferenceEngine === 'localWhisper') { // Added explicit check
        await this.stopRecordingLocalWhisper();
      }
    }
  }

  // --- Live Display Methods (common for both engines) ---
  private setupAudioVisualizer(): void {
    if (!this.stream || this.audioContext) return; // Don't re-init if already exists
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 256; // Smaller for faster processing, adjust if needed
    this.analyserNode.smoothingTimeConstant = 0.75; // Smoother transitions
    const bufferLength = this.analyserNode.frequencyBinCount;
    this.waveformDataArray = new Uint8Array(bufferLength);
    source.connect(this.analyserNode);
  }

  private drawLiveWaveform(): void {
    if (!this.analyserNode || !this.waveformDataArray || !this.liveWaveformCtx || !this.liveWaveformCanvas || !this.isRecording) {
      if (this.waveformDrawingId) cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
      return;
    }
    this.waveformDrawingId = requestAnimationFrame(() => this.drawLiveWaveform());
    this.analyserNode.getByteFrequencyData(this.waveformDataArray); // Use frequency data for more "bouncy" bars
    
    const ctx = this.liveWaveformCtx;
    const canvas = this.liveWaveformCanvas;
    const logicalWidth = canvas.clientWidth;
    const logicalHeight = canvas.clientHeight;

    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const bufferLength = this.analyserNode.frequencyBinCount;
    const numBars = Math.floor(bufferLength * 0.5); // Use about half of the bins for visual simplicity
    if (numBars === 0) return;

    const totalBarPlusSpacingWidth = logicalWidth / numBars;
    const barWidth = Math.max(1, Math.floor(totalBarPlusSpacingWidth * 0.7)); 
    const barSpacing = Math.max(0, Math.floor(totalBarPlusSpacingWidth * 0.3));
    
    let x = 0;
    const engineClass = this.currentInferenceEngine === 'localWhisper' ? 'local-recording' : '';
    const recordingColorVar = engineClass ? '--color-local' : '--color-recording';
    const recordingColor = getComputedStyle(document.documentElement).getPropertyValue(recordingColorVar).trim() || '#ff3b30';
    ctx.fillStyle = recordingColor;

    for (let i = 0; i < numBars; i++) {
        if (x >= logicalWidth) break; 
        // Use a data point from the array, scaling for visual effect
        const dataIndex = Math.floor(i * (bufferLength / numBars)); // Distribute bars across available data
        const barHeightNormalized = this.waveformDataArray[dataIndex] / 255.0;
        let barHeight = barHeightNormalized * logicalHeight;
        if (barHeight < 1 && barHeight > 0) barHeight = 1; // Ensure minimum visibility
        barHeight = Math.round(barHeight);

        const y = Math.round((logicalHeight - barHeight) / 2); // Center bars vertically
        ctx.fillRect(Math.floor(x), y, barWidth, barHeight);
        x += barWidth + barSpacing;
    }
  }

  private updateLiveTimer(): void {
    if (!this.isRecording || !this.liveRecordingTimerDisplay) return;
    const now = Date.now();
    const elapsedMs = now - this.recordingStartTime;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hundredths = Math.floor((elapsedMs % 1000) / 10);
    this.liveRecordingTimerDisplay.textContent = 
        `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  private startLiveDisplay(): void {
    if (!this.recordingInterface || !this.liveRecordingTitle || !this.liveWaveformCanvas || !this.liveRecordingTimerDisplay) return;
    this.recordingInterface.classList.add('is-live');
    this.liveRecordingTitle.style.display = 'block';
    this.liveWaveformCanvas.style.display = 'block';
    this.liveRecordingTimerDisplay.style.display = 'block';
    this.setupCanvasDimensions();

    if (this.statusIndicatorDiv) this.statusIndicatorDiv.style.display = 'none';

    const iconElement = this.recordButton.querySelector('.record-button-inner i') as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-microphone');
      iconElement.classList.add('fa-stop');
    }
    const currentTitle = this.editorTitle.textContent?.trim();
    const placeholder = this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
    this.liveRecordingTitle.textContent = (currentTitle && !this.editorTitle.classList.contains('placeholder-active')) ? currentTitle : 'New Recording';

    this.setupAudioVisualizer(); // Needs this.stream to be set
    this.drawLiveWaveform();
    this.recordingStartTime = Date.now();
    this.updateLiveTimer();
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);
    this.timerIntervalId = window.setInterval(() => this.updateLiveTimer(), 50); // Update ~20fps
  }

  private stopLiveDisplay(): void {
    if (!this.recordingInterface || !this.liveRecordingTitle || !this.liveWaveformCanvas || !this.liveRecordingTimerDisplay) {
        if (this.recordingInterface) this.recordingInterface.classList.remove('is-live');
        return;
    }
    this.recordingInterface.classList.remove('is-live');
    this.liveRecordingTitle.style.display = 'none';
    this.liveWaveformCanvas.style.display = 'none';
    this.liveRecordingTimerDisplay.style.display = 'none';
    
    if (this.statusIndicatorDiv) this.statusIndicatorDiv.style.display = 'block';
    
    const iconElement = this.recordButton.querySelector('.record-button-inner i') as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-stop');
      iconElement.classList.add('fa-microphone');
    }

    if (this.waveformDrawingId) cancelAnimationFrame(this.waveformDrawingId);
    this.waveformDrawingId = null;
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);
    this.timerIntervalId = null;

    if (this.liveWaveformCtx && this.liveWaveformCanvas) {
        this.liveWaveformCtx.clearRect(0, 0, this.liveWaveformCanvas.width, this.liveWaveformCanvas.height);
    }
    // Close AudioContext when stopping display to free resources
    if (this.audioContext) {
        if (this.audioContext.state !== 'closed') {
            this.audioContext.close().catch(e => console.warn('Error closing audio context', e));
        }
        this.audioContext = null;
    }
    this.analyserNode = null; // Allow re-creation on next start
    this.waveformDataArray = null;
  }


  // --- Gemini Recording & Transcription ---
  private async startRecordingGemini(): Promise<void> {
    if (this.hasContentInCurrentNote && !this.editorTitle.classList.contains('placeholder-active') && this.editorTitle.textContent !== (this.editorTitle.getAttribute('placeholder') || 'Untitled Note')) {
        if (!confirm("Starting a new recording will clear the current note and title. Continue?")) {
            return;
        }
    }
    this.createNewNote('gemini'); 
    
    const date = new Date();
    const defaultTitle = `Recording (Cloud) ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    this.editorTitle.textContent = defaultTitle;
    this.editorTitle.classList.remove('placeholder-active');

    try {
      this.audioChunks = []; // Clear previous audio chunks
      if (this.stream) { // Stop any existing stream tracks
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
      }
      if (this.audioContext && this.audioContext.state !== 'closed') { // Close existing audio context
          await this.audioContext.close();
          this.audioContext = null;
      }
      this.recordingStatus.textContent = 'Requesting microphone access...';

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({audio: true});
      } catch (err) {
        console.warn("Standard getUserMedia failed, trying fallbacks:", err);
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }});
      }
      
      try {
        this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm' });
      } catch (e) {
        console.warn("audio/webm mimeType not supported, trying default:", e);
        this.mediaRecorder = new MediaRecorder(this.stream); 
      }

      this.mediaRecorder.ondataavailable = async (event) => {
        if (event.data && event.data.size > 0 && !this.isProcessingChunk) {
          this.isProcessingChunk = true;
          this.audioChunks.push(event.data); // Still save chunks for potential full export if needed
          const audioBlobChunk = event.data;
          try {
            const base64AudioChunk = await this.fileToBase64(audioBlobChunk);
            const mimeType = audioBlobChunk.type || this.mediaRecorder?.mimeType || 'audio/webm';
            await this.performTranscriptionGemini(base64AudioChunk, mimeType, true); 
          } catch (err) {
            console.error('Error processing audio chunk (Gemini):', err);
            this.recordingStatus.textContent = 'Error processing audio chunk.';
          } finally {
            this.isProcessingChunk = false;
          }
        }
      };

      this.mediaRecorder.onstop = async () => {
        this.stopLiveDisplay(); 
        
        if (this.isProcessingChunk) {
          console.warn("MediaRecorder.onstop (Gemini): Chunk processing. Waiting...");
          while (this.isProcessingChunk) {
            await new Promise(resolve => setTimeout(resolve, 100)); 
          }
        }
        
        this.recordingStatus.textContent = 'Finalizing note (Cloud)...';
        if (this.cumulativeRawTranscription.trim()) {
            await this.getPolishedNoteGemini();
        }
        this.recordingStatus.textContent = 'Cloud recording finished.';
        this.updateHasContent();

        if (this.stream) {
          this.stream.getTracks().forEach(track => track.stop());
          this.stream = null;
        }
      };

      this.mediaRecorder.start(CHUNK_DURATION_MS);
      this.isRecording = true;
      this.recordButton.classList.add('recording');
      this.recordButton.setAttribute('title', 'Stop Cloud Recording');
      this.recordButton.setAttribute('aria-pressed', 'true');
      this.startLiveDisplay(); // Pass stream
      this.updateHasContent(); 
    } catch (error) {
      this.handleRecordingError(error);
    }
  }

  private async stopRecordingGemini(): Promise<void> {
    if (this.mediaRecorder && this.isRecording) {
        if (this.mediaRecorder.state === "recording") {
            this.mediaRecorder.stop(); 
        }
    }
    this.isRecording = false; 
    this.recordButton.classList.remove('recording');
    this.recordButton.setAttribute('title', 'Start Cloud Recording');
    this.recordButton.setAttribute('aria-pressed', 'false');
    this.stopLiveDisplay(); 

    if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
        this.recordingStatus.textContent = 'Ready for cloud recording.';
        if (this.cumulativeRawTranscription.trim() && !this.isProcessingChunk) { 
            await this.getPolishedNoteGemini();
        }
        this.updateHasContent();
    }
  }

  private async performTranscriptionGemini(audioData: string, mimeType: string, isChunk: boolean): Promise<void> {
    if (!this.currentNote) this.createNewNote('gemini');
    this.recordingStatus.textContent = isChunk ? 'Transcribing chunk (Cloud)...' : 'Transcribing audio (Cloud)...';
    this.rawTranscription.classList.remove('placeholder-active');

    try {
      const textPart = { text: "Transcribe this audio input accurately. Preserve original speech as much as possible for raw transcription." };
      const audioPart = { inlineData: { data: audioData, mimeType: mimeType } };

      const response: GenerateContentResponse = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: { parts: [textPart, audioPart] },
      });

      const transcription = response.text;
      if (transcription) {
        const formattedTranscription = transcription.trim() + (transcription.trim().match(/[.?!]$/) ? ' ' : '. ');
        if (isChunk) {
          this.cumulativeRawTranscription += formattedTranscription;
          this.rawTranscription.textContent = this.cumulativeRawTranscription;
          this.rawTranscription.scrollTop = this.rawTranscription.scrollHeight;
          await this.getPolishedNoteGemini(); 
        } else { 
          this.cumulativeRawTranscription = formattedTranscription;
          this.rawTranscription.textContent = this.cumulativeRawTranscription;
          await this.getPolishedNoteGemini(); 
        }
      } else {
        this.recordingStatus.textContent = isChunk ? 'Cloud transcription chunk empty.' : 'Cloud transcription empty.';
      }
    } catch (error) {
      console.error('Error during Gemini transcription:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.recordingStatus.textContent = `Cloud transcription error: ${errorMsg.substring(0, 100)}`;
      this.cumulativeRawTranscription += `\n[Cloud Transcription Error: ${errorMsg}]\n`;
      this.rawTranscription.textContent = this.cumulativeRawTranscription;
    }
    if (this.currentNote) this.currentNote.rawTranscription = this.cumulativeRawTranscription;
    this.updateHasContent();
  }

  private async getPolishedNoteGemini(): Promise<void> {
    if (!this.currentNote || !this.cumulativeRawTranscription.trim()) {
      this.polishedNote.innerHTML = ''; 
      if (this.polishedNote.getAttribute('placeholder')) {
        this.polishedNote.classList.add('placeholder-active');
        this.polishedNote.textContent = this.polishedNote.getAttribute('placeholder');
      }
      this.updateHasContent();
      return;
    }

    this.recordingStatus.textContent = 'Polishing notes (Cloud)...';
    this.polishedNote.classList.remove('placeholder-active');
    this.polishedNote.innerHTML = '<p><em>Polishing... (AI is thinking)</em></p>';

    try {
      const prompt = `Based on the following raw audio transcription, please generate a polished and well-structured note. 
      Correct grammar and spelling, remove filler words (like "um", "uh"), improve sentence flow, and organize the content logically. 
      Use headings, bullet points, or numbered lists where appropriate to enhance readability. The output should be in clean HTML format.
      Ensure the key information and intent from the raw transcription are preserved.

      Raw Transcription:
      ---
      ${this.cumulativeRawTranscription}
      ---
      Polished HTML Note:`;
      
      const response: GenerateContentResponse = await this.genAI.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
      });
      
      let polishedContent = response.text;

      if (polishedContent) {
        const mdRegex = /^(#+\s|\*\s|-\s|>\s|`{1,3}|\[.*?\]\(.*?\)|!\[.*?\]\(.*?\))/m;
        if (mdRegex.test(polishedContent.substring(0, 500))) { 
            console.warn("Gemini returned Markdown-like content despite HTML prompt; converting with Marked.js");
            polishedContent = marked(polishedContent) as string;
        }
        this.polishedNote.innerHTML = polishedContent;
        if (this.currentNote) this.currentNote.polishedNote = polishedContent;
      } else {
        this.polishedNote.innerHTML = '<p><em>Could not polish notes (empty Cloud response). Original raw text is available.</em></p>';
        if (this.currentNote) this.currentNote.polishedNote = 'Cloud polishing failed: Empty response.';
      }
    } catch (error) {
      console.error('Error polishing notes with Gemini:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.polishedNote.innerHTML = `<p><em>Error polishing notes (Cloud): ${errorMsg.substring(0,150)}. Raw text is available.</em></p>`;
      if (this.currentNote) this.currentNote.polishedNote = `Cloud polishing error: ${errorMsg}`;
    }
    this.recordingStatus.textContent = 'Cloud notes polished.';
    if (this.currentNote) this.currentNote.sourceEngine = 'gemini'; // Mark as Gemini polished
    this.updateHasContent();
  }

  // --- Local Whisper Recording & Transcription --- // REMOVED WebSocket based implementation
  private async startRecordingLocalWhisper(): Promise<void> {
    if (this.hasContentInCurrentNote && !this.editorTitle.classList.contains('placeholder-active') && this.editorTitle.textContent !== (this.editorTitle.getAttribute('placeholder') || 'Untitled Note')) {
        if (!confirm("Starting a new recording will clear the current note and title. Continue?")) {
            return;
        }
    }
    this.createNewNote('localWhisper');
    const date = new Date();
    const defaultTitle = `Recording (Local WebRTC) ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    this.editorTitle.textContent = defaultTitle;
    this.editorTitle.classList.remove('placeholder-active');
    this.recordingStatus.textContent = 'Initializing Local WebRTC...';

    try {
      this.peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      this.webrtcId = Math.random().toString(36).substring(7);

      this.peerConnection.onicecandidate = async (event) => {
        if (event.candidate) {
          // Typically, ICE candidates are sent to the remote peer.
          // For local server, often the offer/answer SDP contains all necessary candidates,
          // or the server might not need individual ICE candidates if running on localhost.
          // If the server expects trickle ICE, this is where you'd send them.
          // console.log('ICE candidate:', event.candidate);
        } else {
          console.log('ICE gathering finished.');
          // ICE gathering is complete, now send the offer if not already sent.
          // In many simple WebRTC setups, the offer is sent immediately after setLocalDescription.
        }
      };
      
      this.peerConnection.onconnectionstatechange = () => {
        console.log('WebRTC Connection State:', this.peerConnection?.connectionState);
        if (this.peerConnection) {
            this.recordingStatus.textContent = `WebRTC: ${this.peerConnection.connectionState}`;
            switch (this.peerConnection.connectionState) {
                case 'connected':
                    this.recordingStatus.textContent = 'Connected to Local WebRTC.';
                    // Start MediaRecorder or other audio processing AFTER connection
                    if (this.stream && !this.mediaRecorder) { // Ensure stream is available and MR not already started
                        try {
                             // We don't need MediaRecorder to send data to the server with WebRTC addTrack
                             // But we might still want it for local saving of audio chunks if needed for export
                            this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm' });
                            this.mediaRecorder.ondataavailable = (event) => {
                                if (event.data.size > 0) this.audioChunks.push(event.data);
                            };
                            this.mediaRecorder.start(1000); // Collect chunks every second
                        } catch (e) {
                            console.warn("Could not start MediaRecorder for local audio chunk saving:", e);
                        }
                    }
                    break;
                case 'failed':
                case 'disconnected':
                case 'closed':
                    this.handleLocalWebRTCConnectionFailure();
                    break;
            }
        }
      };

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.warn("Standard getUserMedia failed, trying fallbacks for Local WebRTC:", err);
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      }
      
      this.setupAudioVisualizer(); // Uses this.stream

      this.stream.getTracks().forEach(track => {
        if (this.peerConnection) {
            this.peerConnection.addTrack(track, this.stream!);
        }
      });
      
      // Optional: Data Channel
      // const dataChannel = this.peerConnection.createDataChannel('text');
      // dataChannel.onmessage = (event) => console.log('Data channel message (Local):', event.data);
      // dataChannel.onopen = () => console.log('Data channel open (Local)');
      // dataChannel.onclose = () => console.log('Data channel closed (Local)');


      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      // Wait for ICE gathering to complete, or at least for some candidates to be gathered.
      // For a local server, this might not be strictly necessary if all info is in SDP.
      // await new Promise<void>(resolve => {
      //   if (this.peerConnection?.iceGatheringState === 'complete') {
      //     resolve();
      //   } else {
      //     this.peerConnection!.onicegatheringstatechange = () => {
      //       if (this.peerConnection?.iceGatheringState === 'complete') resolve();
      //     };
      //   }
      // });
      // The above explicit wait for ice gathering might be too slow or unnecessary for local.
      // Sending offer right after setLocalDescription is common.

      this.recordingStatus.textContent = 'Sending offer to Local WebRTC server...';
      const response = await fetch(`${this.localApiBaseUrl}/webrtc/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: this.peerConnection.localDescription!.sdp,
          type: this.peerConnection.localDescription!.type,
          webrtc_id: this.webrtcId,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Local WebRTC server rejected offer: ${response.status} ${errorText}`);
      }

      const serverAnswer = await response.json();
      if (!serverAnswer.sdp || !serverAnswer.type) {
        throw new Error('Invalid answer from Local WebRTC server');
      }
      
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(serverAnswer));
      this.recordingStatus.textContent = 'Remote description set. Establishing transcription stream...';
      
      this.establishTranscriptionEventSource(); // Call this after successful handshake

      this.isRecording = true;
      this.recordButton.classList.add('recording', 'local-recording');
      this.recordButton.setAttribute('title', 'Stop Local Recording');
      this.recordButton.setAttribute('aria-pressed', 'true');
      this.startLiveDisplay(); // Includes setupAudioVisualizer if stream is ready
      this.updateHasContent();

    } catch (error) {
      console.error('Error starting Local WebRTC recording:', error);
      this.recordingStatus.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
      this.stopRecordingLocalWhisper(); // Clean up
      this.handleRecordingError(error); // Generic error handler for UI updates
    }
  }

  private establishTranscriptionEventSource(): void {
    if (this.transcriptionEventSource) {
      this.transcriptionEventSource.close();
    }

    if (!this.webrtcId) {
      console.error("Cannot establish transcription EventSource without a webrtcId.");
      this.recordingStatus.textContent = "Error: Missing WebRTC ID for transcription.";
      return;
    }

    const eventSourceUrl = `${this.localApiBaseUrl}/transcript?webrtc_id=${this.webrtcId}`;
    console.log(`Connecting to EventSource: ${eventSourceUrl}`);
    this.transcriptionEventSource = new EventSource(eventSourceUrl);

    this.transcriptionEventSource.addEventListener('output', (event) => {
      const messageEvent = event as MessageEvent;
      const transcription = messageEvent.data;
      
      if (transcription) {
        this.cumulativeRawTranscription += transcription + ' ';
        this.rawTranscription.textContent = this.cumulativeRawTranscription;
        this.rawTranscription.scrollTop = this.rawTranscription.scrollHeight;
        
        // For local whisper, polished note initially mirrors raw transcription.
        // It can be later polished using Gemini if the user chooses.
        this.polishedNote.textContent = this.cumulativeRawTranscription;
        this.polishedNote.classList.remove('placeholder-active');


        if (this.currentNote) {
          this.currentNote.rawTranscription = this.cumulativeRawTranscription;
          this.currentNote.polishedNote = this.cumulativeRawTranscription; 
        }
        this.updateHasContent();
      }
    });

    this.transcriptionEventSource.onerror = (err) => {
      console.error('Transcription EventSource error:', err);
      this.recordingStatus.textContent = 'Transcription connection error. Stream may have ended or server issue.';
      // Consider if stopRecordingLocalWhisper should be called here. 
      // If the server gracefully ends the stream, an error might be expected.
      // If it's an unexpected error, then cleanup is good.
      // For now, let's not auto-stop, as the server might close the EventSource when audio stops.
      // this.stopRecordingLocalWhisper(); 
      if (this.transcriptionEventSource) {
          if (this.transcriptionEventSource.readyState === EventSource.CLOSED) {
              console.log("EventSource was closed by server or due to error.");
          }
          this.transcriptionEventSource.close(); // Ensure it's closed on error
          this.transcriptionEventSource = null;
      }
    };

    this.transcriptionEventSource.onopen = () => {
        console.log("Transcription EventSource connection opened.");
        this.recordingStatus.textContent = "Transcription stream connected.";
    };
  }
  // private async startRecordingLocalWhisper(): Promise<void> { // OLD WebSocket version
  //    if (this.hasContentInCurrentNote && !this.editorTitle.classList.contains('placeholder-active') && this.editorTitle.textContent !== (this.editorTitle.getAttribute('placeholder') || 'Untitled Note')) { // OLD WebSocket version
  //       if (!confirm("Starting a new recording will clear the current note and title. Continue?")) { // OLD WebSocket version
  //           return;
  //       }
  //   }
  //   this.createNewNote('localWhisper');
  //   const date = new Date();
  //   const defaultTitle = `Recording (Local) ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  //   this.editorTitle.textContent = defaultTitle;
  //   this.editorTitle.classList.remove('placeholder-active');
  //
  //
  //   try {
  //     this.audioChunks = [];
  //      if (this.stream) { 
  //       this.stream.getTracks().forEach(track => track.stop());
  //       this.stream = null;
  //     }
  //     if (this.audioContext && this.audioContext.state !== 'closed') { 
  //         await this.audioContext.close();
  //         this.audioContext = null;
  //     }
  //     this.recordingStatus.textContent = 'Requesting microphone access...';
  //     
  //     try {
  //       this.stream = await navigator.mediaDevices.getUserMedia({audio: true});
  //     } catch (err) {
  //        console.warn("Standard getUserMedia failed, trying fallbacks:", err);
  //       this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }});
  //     }
  //
  //     this.recordingStatus.textContent = 'Connecting to local Whisper...';
  //     this.localWhisperSocket = new WebSocket(LOCAL_WHISPER_URL);
  //
  //     this.localWhisperSocket.onopen = () => {
  //       this.recordingStatus.textContent = 'Connected to local Whisper. Recording...';
  //       this.isRecording = true;
  //       this.recordButton.classList.add('recording', 'local-recording');
  //       this.recordButton.setAttribute('title', 'Stop Local Recording');
  //       this.recordButton.setAttribute('aria-pressed', 'true');
  //       
  //       // Configure MediaRecorder to send data to WebSocket
  //       // The local server needs to handle these chunks.
  //       // This might need adjustment based on how realtime-transcription-fastrtc expects audio.
  //       // For this example, sending base64 encoded chunks.
  //       try {
  //           this.mediaRecorder = new MediaRecorder(this.stream!, { mimeType: 'audio/webm; codecs=opus', audioBitsPerSecond: 48000 });
  //       } catch (e) {
  //           console.warn("audio/webm; codecs=opus, 48kbps not supported, trying default webm for MediaRecorder for local:", e);
  //           try {
  //               this.mediaRecorder = new MediaRecorder(this.stream!, { mimeType: 'audio/webm' });
  //           } catch (e2) {
  //               console.warn("audio/webm not supported, trying default MediaRecorder for local:", e2);
  //               this.mediaRecorder = new MediaRecorder(this.stream!);
  //           }
  //       }
  //
  //
  //       this.mediaRecorder.ondataavailable = async (event) => {
  //         if (event.data.size > 0 && this.localWhisperSocket && this.localWhisperSocket.readyState === WebSocket.OPEN) {
  //           this.audioChunks.push(event.data); // Save for full export
  //           // Send audio data to local whisper. Format may need to be raw PCM or specific encoding.
  //           // For now, sending base64 string of the blob.
  //           const base64AudioChunk = await this.fileToBase64(event.data);
  //           this.localWhisperSocket.send(JSON.stringify({audio_data: base64AudioChunk, mime_type: event.data.type || 'audio/webm'}));
  //         }
  //       };
  //       // Start media recorder with a small timeslice to stream frequently
  //       this.mediaRecorder.start(1000); // Send data every 1 second. Adjust as needed.
  //       this.startLiveDisplay();
  //       this.updateHasContent();
  //     };
  //
  //     this.localWhisperSocket.onmessage = (event) => {
  //       // Assuming server sends back JSON with a 'transcript' field
  //       try {
  //         const data = JSON.parse(event.data as string);
  //         if (data.transcript) {
  //           // Append to cumulative, but for local real-time, often it's better to replace or smartly append.
  //           // For simplicity now, append.
  //           this.cumulativeRawTranscription += data.transcript + ' ';
  //           this.rawTranscription.textContent = this.cumulativeRawTranscription;
  //           this.rawTranscription.scrollTop = this.rawTranscription.scrollHeight;
  //           // If local, polished initially shows raw
  //           this.polishedNote.textContent = this.cumulativeRawTranscription; 
  //           if(this.currentNote) this.currentNote.rawTranscription = this.cumulativeRawTranscription;
  //           if(this.currentNote) this.currentNote.polishedNote = this.cumulativeRawTranscription; // raw until polished by Gemini
  //           this.updateHasContent();
  //         }
  //       } catch (e) {
  //         console.warn('Non-JSON message from local Whisper or parse error:', event.data, e);
  //         // It could be plain text transcript
  //          if (typeof event.data === 'string') {
  //            this.cumulativeRawTranscription += event.data + ' ';
  //            this.rawTranscription.textContent = this.cumulativeRawTranscription;
  //            this.rawTranscription.scrollTop = this.rawTranscription.scrollHeight;
  //            this.polishedNote.textContent = this.cumulativeRawTranscription;
  //            if(this.currentNote) this.currentNote.rawTranscription = this.cumulativeRawTranscription;
  //            if(this.currentNote) this.currentNote.polishedNote = this.cumulativeRawTranscription;
  //            this.updateHasContent();
  //          }
  //       }
  //     };
  //
  //     this.localWhisperSocket.onerror = (error) => {
  //       console.error('Local Whisper WebSocket error:', error);
  //       this.recordingStatus.textContent = 'Local Whisper connection error. Is it running?';
  //       this.isRecording = false;
  //       this.recordButton.classList.remove('recording', 'local-recording');
  //       this.recordButton.setAttribute('title', 'Start Local Recording');
  //       this.stopLiveDisplay();
  //       if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
  //           this.mediaRecorder.stop();
  //       }
  //        if (this.stream) {
  //         this.stream.getTracks().forEach(track => track.stop());
  //         this.stream = null;
  //       }
  //     };
  //
  //     this.localWhisperSocket.onclose = () => {
  //       if (this.isRecording) { // If closed unexpectedly during recording
  //         this.recordingStatus.textContent = 'Local Whisper disconnected.';
  //       }
  //       // Finalize recording if it was ongoing
  //       this.isRecording = false;
  //       this.recordButton.classList.remove('recording', 'local-recording');
  //       this.recordButton.setAttribute('title', 'Start Local Recording');
  //       this.stopLiveDisplay();
  //       if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
  //           this.mediaRecorder.stop();
  //       }
  //        if (this.stream) {
  //         this.stream.getTracks().forEach(track => track.stop());
  //         this.stream = null;
  //       }
  //       this.updateHasContent(); // Update save buttons etc.
  //     };
  //
  //   } catch (error) {
  //     this.handleRecordingError(error);
  //   }
  // }

  // private async stopRecordingLocalWhisper(): Promise<void> {
  //   if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
  //     this.mediaRecorder.stop();
  //   }
  //   if (this.localWhisperSocket) {
  //     if (this.localWhisperSocket.readyState === WebSocket.OPEN) {
  //       this.localWhisperSocket.send(JSON.stringify({command: "stop"})); // Optional: send stop command
  //       this.localWhisperSocket.close();
  //     }
  //     this.localWhisperSocket = null;
  //   }
  //   this.isRecording = false;
  //   this.recordButton.classList.remove('recording', 'local-recording');
  //   this.recordButton.setAttribute('title', 'Start Local Recording');
  //   this.stopLiveDisplay();
  //
  //   this.recordingStatus.textContent = 'Local recording finished.';
  //    if (this.stream) {
  //       this.stream.getTracks().forEach(track => track.stop());
  //       this.stream = null;
  //   }
  //   this.updateHasContent();
  // } // OLD WebSocket version

  private async stopRecordingLocalWhisper(): Promise<void> {
    this.recordingStatus.textContent = 'Stopping local WebRTC recording...';

    if (this.transcriptionEventSource) {
      this.transcriptionEventSource.close();
      this.transcriptionEventSource = null;
      console.log('Transcription EventSource closed.');
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.getTransceivers().forEach(transceiver => {
          if (transceiver.stop) { // Check if stop method exists
            transceiver.stop();
          }
        });
        this.peerConnection.close();
        console.log('WebRTC PeerConnection closed.');
      } catch (e) {
        console.warn('Error while closing PeerConnection:', e);
      } finally {
        this.peerConnection = null;
      }
    }
    
    // Stop MediaRecorder if it was used for local chunk saving
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
        console.log('MediaRecorder stopped (local).');
    }
    // mediaRecorder will be set to null by stopLiveDisplay's audio context cleanup logic indirectly, 
    // or if it's part of a broader cleanup, ensure it's nulled here too.

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
      console.log('MediaStream tracks stopped.');
    }

    // AudioContext is typically closed by stopLiveDisplay, ensure if not it's handled
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
      this.audioContext = null;
      console.log('AudioContext closed.');
    }

    this.isRecording = false;
    this.recordButton.classList.remove('recording', 'local-recording');
    this.recordButton.setAttribute('title', 'Start Local Recording');
    this.recordButton.setAttribute('aria-pressed', 'false');
    
    this.stopLiveDisplay(); // This also handles AudioContext cleanup if it was started by it

    this.recordingStatus.textContent = 'Local recording finished.';
    this.updateHasContent();
    this.webrtcId = null; // Clear the WebRTC ID
  }

  private handleLocalWebRTCConnectionFailure(): void {
    console.error('Local WebRTC connection failed or disconnected.');
    this.recordingStatus.textContent = 'Local WebRTC connection failed. Please check server and network.';
    // Call stopRecordingLocalWhisper to ensure everything is cleaned up
    // This will also reset UI states.
    this.stopRecordingLocalWhisper(); 
  }
  
  private handleRecordingError(error: any): void {
    console.error('Error starting recording:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'Unknown';

    if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
      this.recordingStatus.textContent = 'Microphone permission denied. Check browser settings & reload.';
    } else if (errorName === 'NotFoundError' || (errorName === 'DOMException' && errorMessage.includes('Requested device not found'))) {
      this.recordingStatus.textContent = 'No microphone found. Connect a microphone and try again.';
    } else if (errorName === 'NotReadableError' || errorName === 'TrackStartError') {
        this.recordingStatus.textContent = 'Mic in use or cannot be accessed. Check other apps/settings.';
    } else {
      this.recordingStatus.textContent = `Error: ${errorName}. Try again or check console.`;
    }
    this.isRecording = false;
    this.recordButton.classList.remove('recording', 'local-recording');
    this.recordButton.setAttribute('title', this.currentInferenceEngine === 'gemini' ? 'Start Cloud Recording' : 'Start Local Recording');
    this.recordButton.setAttribute('aria-pressed', 'false');
    this.stopLiveDisplay(); 
    this.updateHasContent(); 
  }

  // --- Note Management & Saving ---
  private createNewNote(engine: InferenceEngine = this.currentInferenceEngine): void {
    const newId = `note-${Date.now()}`;
    this.currentNote = {
      id: newId,
      rawTranscription: '',
      polishedNote: '',
      timestamp: Date.now(),
      sourceEngine: engine,
    };
    this.cumulativeRawTranscription = '';
    this.audioChunks = []; // Clear audio chunks for new note

    [this.rawTranscription, this.polishedNote, this.editorTitle].forEach(el => {
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) {
            el.textContent = placeholder; 
            el.classList.add('placeholder-active');
        } else {
            el.textContent = ''; 
        }
        if (el === this.polishedNote) el.innerHTML = ''; 
    });
    
    if (this.polishedNote.getAttribute('placeholder') && !this.polishedNote.textContent) {
        this.polishedNote.textContent = this.polishedNote.getAttribute('placeholder');
        this.polishedNote.classList.add('placeholder-active');
    }
    this.updateHasContent(); 
  }

  private saveContent(content: string, filename: string, mimeType: string = 'text/plain'): void {
    if (!content.trim() && !this.polishedNote.querySelector('img, video, audio, iframe, object, embed')) { 
      alert('There is no content to save.');
      return;
    }
    const blob = new Blob([content], { type: mimeType + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private getNoteTitleForSave(): string {
    let noteTitle = this.editorTitle.textContent?.trim() || 'Untitled Note';
    const placeholderTitle = this.editorTitle.getAttribute('placeholder');
    if (!noteTitle || (placeholderTitle && noteTitle === placeholderTitle) || this.editorTitle.classList.contains('placeholder-active')) {
        noteTitle = 'Untitled Note';
    }
    return noteTitle.replace(/[<>:"/\\|?*.,!\s]+/g, '_'); // Sanitize filename more aggressively
  }

  private savePolishedContent(): void {
    const noteTitle = this.getNoteTitleForSave();
    let contentToSave = this.polishedNote.innerHTML;
    let fileExtension = 'html';

    if (this.currentNote?.sourceEngine === 'localWhisper' && this.currentNote.polishedNote === this.currentNote.rawTranscription) {
        // If it's local and not yet polished by Gemini, save raw as text
        contentToSave = this.cumulativeRawTranscription;
        fileExtension = 'txt';
         alert("Saving raw transcript from local engine. Use 'Polish with Gemini' for a polished version.");
    }
    this.saveContent(contentToSave, `${noteTitle}_polished.${fileExtension}`, fileExtension === 'html' ? 'text/html' : 'text/plain');
  }

  private saveRawTranscript(): void {
    const noteTitle = this.getNoteTitleForSave();
    this.saveContent(this.cumulativeRawTranscription, `${noteTitle}_raw.txt`);
  }

  private async polishLocalTranscriptWithGemini(): Promise<void> {
    if (this.currentNote?.sourceEngine !== 'localWhisper' || !this.cumulativeRawTranscription.trim()) {
      alert("No local transcript available to polish with Gemini.");
      return;
    }
    if (!this.genAI) {
        alert("Gemini AI client not initialized. Cannot polish.");
        return;
    }
    // Temporarily set sourceEngine to gemini for polishing logic or adapt getPolishedNoteGemini
    // For now, directly call getPolishedNoteGemini as it uses this.cumulativeRawTranscription
    this.recordingStatus.textContent = "Sending local transcript to Gemini for polishing...";
    await this.getPolishedNoteGemini(); // This will update currentNote.polishedNote and the UI
    if (this.currentNote) this.currentNote.sourceEngine = 'gemini'; // Mark as now Gemini polished
    this.updatePolishWithGeminiButtonVisibility(); // Should hide the button now
    this.updateHasContent();
  }

  private async exportVideoWithCaptions(): Promise<void> {
    if (this.currentNote?.sourceEngine !== 'localWhisper' || this.audioChunks.length === 0) {
      alert("Video/caption export is only available for completed local recordings with audio.");
      return;
    }

    const noteTitle = this.getNoteTitleForSave();

    // 1. Save combined audio
    const audioBlob = new Blob(this.audioChunks, { type: this.audioChunks[0]?.type || 'audio/webm' });
    const audioFilename = `${noteTitle}_audio.webm`; // Default to webm, could try to be more specific
    this.saveContent(audioBlob as any, audioFilename, audioBlob.type); // saveContent expects string, need to adapt or use similar logic for blob

    // Create a temporary anchor to download the blob
    const audioUrl = URL.createObjectURL(audioBlob);
    const a = document.createElement('a');
    a.href = audioUrl;
    a.download = audioFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(audioUrl);

    // 2. Save raw transcript as basic SRT or TXT
    // For a basic SRT, we'd need to segment. For now, just TXT.
    // To make a VEEEERY basic SRT, with one caption for the whole duration:
    const totalDurationSeconds = this.audioChunks.reduce((acc, chunk) => acc + (chunk.size / (48000 * 2)), 0); // Rough estimate, not accurate
    // This needs to be replaced by actual duration from MediaRecorder or metadata
    const srtContent = `1
00:00:00,000 --> ${this.formatTimestampSRT(this.recordingStartTime ? (Date.now() - this.recordingStartTime)/1000 : 60)}
${this.cumulativeRawTranscription.trim()}
`;
    const captionsFilename = `${noteTitle}_captions.srt`;
    this.saveContent(srtContent, captionsFilename);

    // 3. Provide FFmpeg instructions
    alert(
`Files downloaded:
1. ${audioFilename} (Audio)
2. ${captionsFilename} (Captions)

To combine them into a video with burned-in captions using FFmpeg (if installed locally), run a command like this in your terminal:

ffmpeg -i ${audioFilename} -vf "subtitles=${captionsFilename}:force_style='Fontsize=24,PrimaryColour=&H00FFFFFF&,BorderStyle=3,Outline=1,Shadow=0.5'" -c:a copy ${noteTitle}_video_with_captions.mp4

(You may need to adjust paths and FFmpeg parameters for your setup.)`
    );
  }

  private formatTimestampSRT(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const milliseconds = Math.floor((totalSeconds * 1000) % 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
  }


} // End of VoiceNotesApp class

document.addEventListener('DOMContentLoaded', () => {
  // API Key check is done in constructor now.
  // If key is missing, constructor handles UI and prevents app init.
  const app = new VoiceNotesApp();

  // Initialize toggle switch indicator position
  const initialEngineInput = document.querySelector('input[name="inferenceEngine"]:checked') as HTMLInputElement;
  if (initialEngineInput && (app as any).updateToggleSwitchUI) {
      requestAnimationFrame(() => {
        (app as any).updateToggleSwitchUI(initialEngineInput.value as InferenceEngine);
      });
  }
});
