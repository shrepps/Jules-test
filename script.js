document.addEventListener('DOMContentLoaded', () => {
    const videoUpload = document.getElementById('videoUpload');
    const videoPlayer = document.getElementById('videoPlayer');
    const bassHitsList = document.getElementById('bassHitsList');
    const downloadButton = document.getElementById('downloadButton');

    let audioContext;
    let analyser;
    let sourceNode;
    let lowPassFilter;
    
    // Store detected bass hit timestamps and their processed state for shake
    let bassHits = []; // Array of objects: { time: number, shaken: boolean }

    const BASS_FREQ_MIN = 20; // Hz
    const BASS_FREQ_MAX = 140; // Hz, broadened slightly
    const PEAK_THRESHOLD = 190; // Threshold for peak detection (0-255 for byte data), made more sensitive
    const SHAKE_DURATION_MS = 180; // How long the shake effect lasts, slightly shorter
    let lastPeakTime = 0;
    const MIN_PEAK_INTERVAL = 0.12; // Minimum seconds between detected peaks (debouncing), slightly shorter for faster beats

    videoUpload.addEventListener('change', function(event) {
        const file = event.target.files[0];
        if (file) {
            // Revoke previous object URL to free up memory
            if (videoPlayer.src) {
                URL.revokeObjectURL(videoPlayer.src);
            }
            const fileURL = URL.createObjectURL(file);
            videoPlayer.src = fileURL;
            bassHitsList.innerHTML = '<li>Loading video...</li>'; // Clear previous results and indicate loading
            bassHits = [];
            lastPeakTime = 0;

            videoPlayer.onloadedmetadata = () => {
                console.log("Video metadata loaded. Duration:", videoPlayer.duration);
                bassHitsList.innerHTML = '<li>Processing audio...</li>';
                setupAudioProcessing();
            };

            videoPlayer.oncanplay = () => {
                // This ensures audio context is resumed if it was suspended by browser policy
                if (audioContext && audioContext.state === 'suspended') {
                    audioContext.resume().then(() => {
                        console.log("AudioContext resumed on 'canplay'.");
                    });
                }
            };

            videoPlayer.onplay = () => {
                if (audioContext && audioContext.state === 'suspended') {
                    audioContext.resume().then(() => {
                         console.log("AudioContext resumed on 'play'.");
                         analyseAudio(); // Start analysis after resume if it wasn't already
                    });
                } else if (audioContext && audioContext.state === 'running') {
                     analyseAudio(); 
                } else {
                    console.warn("AudioContext not ready or in an unexpected state on 'play'. State:", audioContext ? audioContext.state : 'null');
                }
            };
            
            videoPlayer.onended = () => {
                console.log("Video ended. Detected timestamps:", bassHits.map(b => b.time));
                bassHitsList.innerHTML = ''; // Clear "Processing" message
                if (bassHits.length === 0) {
                    bassHitsList.innerHTML = '<li>No bass hits detected. Consider different audio or adjust parameters (not yet implemented in UI).</li>';
                } else {
                    bassHits.forEach(hit => {
                        const li = document.createElement('li');
                        li.textContent = hit.time.toFixed(3) + 's';
                        bassHitsList.appendChild(li);
                    });
                }
            };

            videoPlayer.onerror = (e) => {
                console.error("Video Error:", e);
                bassHitsList.innerHTML = '<li>Error loading video. Please try a different file.</li>';
            };

            // Use timeupdate to trigger shakes precisely
            videoPlayer.ontimeupdate = () => {
                triggerShakeForCurrentTime();
            };
        }
    });

    function setupAudioProcessing() {
        if (audioContext) {
            audioContext.close().then(() => console.log("Previous AudioContext closed."));
        }
        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        if (sourceNode) {
            try {
                sourceNode.disconnect();
            } catch (e) {
                console.warn("Error disconnecting previous source node:", e);
            }
        }

        try {
            sourceNode = audioContext.createMediaElementSource(videoPlayer);

            lowPassFilter = audioContext.createBiquadFilter();
            lowPassFilter.type = 'lowpass';
            lowPassFilter.frequency.setValueAtTime(BASS_FREQ_MAX, audioContext.currentTime);
            // For a steeper rolloff, you could chain another filter or adjust Q factor if needed
            // lowPassFilter.Q.setValueAtTime(1, audioContext.currentTime);


            analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048; // Powers of 2, e.g., 256, 512, 1024, 2048.
                                     // Larger FFT size means more frequency bins (detail) but less time resolution.
            analyser.smoothingTimeConstant = 0.7; // Default 0.8. Lower is more responsive, higher is smoother.

            sourceNode.connect(lowPassFilter);
            lowPassFilter.connect(analyser);
            // To hear the audio:
            analyser.connect(audioContext.destination);
            
            console.log("Audio processing pipeline set up.");
            if (bassHitsList.innerHTML.includes('Processing audio...')) {
                bassHitsList.innerHTML = '<li>Audio ready. Play video to start detection.</li>';
            }

        } catch (e) {
            console.error("Error setting up audio processing:", e);
            bassHitsList.innerHTML = '<li>Error setting up audio. Please ensure the video has an audio track.</li>';
        }
    }

    let animationFrameId = null;
    function analyseAudio() {
        if (animationFrameId) { // Cancel previous frame if any, to avoid multiple loops if play/pause rapidly
            cancelAnimationFrame(animationFrameId);
        }

        function processFrame() {
            if (!analyser || !videoPlayer || videoPlayer.paused || videoPlayer.ended || audioContext.state !== 'running') {
                animationFrameId = null; // Stop the loop
                return;
            }

            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            analyser.getByteFrequencyData(dataArray);

            const nyquist = audioContext.sampleRate / 2;
            const minBin = Math.max(0, Math.floor(BASS_FREQ_MIN / (nyquist / bufferLength)));
            const maxBin = Math.min(bufferLength - 1, Math.ceil(BASS_FREQ_MAX / (nyquist / bufferLength)));

            let bassEnergy = 0;
            if (maxBin > minBin) {
                for (let i = minBin; i <= maxBin; i++) {
                    bassEnergy += dataArray[i];
                }
                const averageBassEnergy = bassEnergy / (maxBin - minBin + 1);
                const currentTime = videoPlayer.currentTime;

                if (averageBassEnergy > PEAK_THRESHOLD && (currentTime - lastPeakTime) > MIN_PEAK_INTERVAL) {
                    const alreadyExists = bassHits.some(hit => Math.abs(hit.time - currentTime) < MIN_PEAK_INTERVAL / 2);
                    if (!alreadyExists) {
                        // console.log(`Bass hit detected at ${currentTime.toFixed(3)}s, Energy: ${averageBassEnergy.toFixed(2)}`);
                        bassHits.push({ time: currentTime, shaken: false });
                        bassHits.sort((a, b) => a.time - b.time);
                        lastPeakTime = currentTime;
                    }
                }
            }
            animationFrameId = requestAnimationFrame(processFrame);
        }
        processFrame(); // Start the loop
    }

    function applyScreenShake() {
        if (!videoPlayer.classList.contains('shake')) {
            videoPlayer.classList.add('shake');
            setTimeout(() => {
                videoPlayer.classList.remove('shake');
            }, SHAKE_DURATION_MS);
        }
    }

    function triggerShakeForCurrentTime() {
        if (!videoPlayer || videoPlayer.paused || videoPlayer.seeking) return;

        const currentTime = videoPlayer.currentTime;
        // A small window to catch the event
        const timeWindow = Math.max(0.05, SHAKE_DURATION_MS / 1000); // Window based on shake duration or min 50ms

        for (let i = 0; i < bassHits.length; i++) {
            const hit = bassHits[i];
            // Check if current time is within [hit.time, hit.time + timeWindow]
            // and the hit hasn't been processed for shaking yet.
            if (!hit.shaken && currentTime >= hit.time && currentTime < hit.time + timeWindow) {
                applyScreenShake();
                hit.shaken = true; 
                // console.log(`Shake applied for hit at ${hit.time.toFixed(3)}s (current: ${currentTime.toFixed(3)}s)`);
            }
            // If video has played past a hit time by more than the window,
            // and it wasn't shaken (e.g. due to lag or seeking past it quickly),
            // mark it as shaken to prevent it from triggering if the user seeks back to just before it.
            // This behavior can be adjusted based on desired outcome when seeking.
            else if (!hit.shaken && currentTime >= hit.time + timeWindow) {
                // hit.shaken = true; // Optional: Mark as "missed"
            }
             // Optimization: if current time is way past earliest non-shaken hits,
             // we could potentially break early if bassHits is always sorted.
             // But for simplicity and small arrays, iterating through all is fine.
        }
    }
    
    // Expose for potential use if other modules need it (e.g. for debugging from console)
    window.bassShakeDebug = {
        getBassHits: () => bassHits,
        getAudioContext: () => audioContext,
        getAnalyser: () => analyser,
        getVideoPlayer: () => videoPlayer,
        PEAK_THRESHOLD,
        MIN_PEAK_INTERVAL,
        BASS_FREQ_MAX,
        BASS_FREQ_MIN
    };

    downloadButton.addEventListener('click', async () => {
        if (!videoPlayer.src || bassHits.length === 0) {
            alert("Please upload a video and ensure bass hits are detected before downloading.");
            return;
        }

        downloadButton.disabled = true;
        downloadButton.textContent = "Processing video...";

        const originalMuted = videoPlayer.muted;
        const originalTime = videoPlayer.currentTime;
        const originalPlaybackRate = videoPlayer.playbackRate;

        videoPlayer.muted = true; // Mute main player to avoid double audio if canvas also plays audio
        videoPlayer.currentTime = 0;
        videoPlayer.playbackRate = 1; // Ensure normal speed for recording

        const canvas = document.createElement('canvas');
        canvas.width = videoPlayer.videoWidth;
        canvas.height = videoPlayer.videoHeight;
        const ctx = canvas.getContext('2d');

        const recordedChunks = [];
        // Attempt to capture audio directly from the original video source for the recording
        let audioStream = null;
        let mixedStream = null;
        const canvasStream = canvas.captureStream(30); // 30 FPS for video

        if (videoPlayer.captureStream) { // Standard
            audioStream = videoPlayer.captureStream().getAudioTracks()[0];
        } else if (videoPlayer.mozCaptureStream) { // Firefox
            audioStream = videoPlayer.mozCaptureStream().getAudioTracks()[0];
        }

        if (audioStream) {
            mixedStream = new MediaStream([...canvasStream.getVideoTracks(), audioStream]);
        } else {
            mixedStream = canvasStream; // No audio track from video, proceed with video only
            console.warn("Could not capture audio track from video. Downloaded video might be silent.");
        }

        const mediaRecorder = new MediaRecorder(mixedStream, {
            mimeType: 'video/webm; codecs=vp9,opus' // VP9 for video, Opus for audio
        });

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'video_with_shake.webm';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            // Restore video player state
            videoPlayer.muted = originalMuted;
            videoPlayer.currentTime = originalTime;
            videoPlayer.playbackRate = originalPlaybackRate;
            downloadButton.disabled = false;
            downloadButton.textContent = "Download Video with Shake";
            console.log("Video processing complete and download triggered.");
        };

        mediaRecorder.onerror = (event) => {
            console.error("MediaRecorder error:", event.error);
            alert("Error during video recording. Check console for details.");
            videoPlayer.muted = originalMuted;
            videoPlayer.currentTime = originalTime;
            videoPlayer.playbackRate = originalPlaybackRate;
            downloadButton.disabled = false;
            downloadButton.textContent = "Download Video with Shake";
        };

        mediaRecorder.start();
        console.log("MediaRecorder started. Canvas dimensions:", canvas.width, "x", canvas.height);


        // Reset shaken state for all hits before processing
        bassHits.forEach(hit => hit.shakenForDownload = false);

        function processFrameForDownload() {
            if (videoPlayer.paused || videoPlayer.ended) {
                // If video ends or is paused externally, attempt to finalize.
                if (mediaRecorder.state === "recording") {
                    mediaRecorder.stop();
                }
                return;
            }

            ctx.clearRect(0, 0, canvas.width, canvas.height); // Clear canvas

            // Apply shake if needed
            const currentTime = videoPlayer.currentTime;
            const timeWindow = Math.max(0.05, SHAKE_DURATION_MS / 1000);
            let isShakingThisFrame = false;

            for (let i = 0; i < bassHits.length; i++) {
                const hit = bassHits[i];
                 // Check if current time is within [hit.time, hit.time + SHAKE_DURATION_MS/1000]
                if (currentTime >= hit.time && currentTime < hit.time + (SHAKE_DURATION_MS / 1000)) {
                    isShakingThisFrame = true;
                    break;
                }
            }

            if (isShakingThisFrame) {
                const shakeIntensity = 5; // pixels for translation, degrees for rotation
                const dx = (Math.random() - 0.5) * 2 * shakeIntensity;
                const dy = (Math.random() - 0.5) * 2 * shakeIntensity;
                const dAngle = (Math.random() - 0.5) * 2 * (shakeIntensity / 2); // Smaller rotation

                ctx.save();
                ctx.translate(canvas.width / 2, canvas.height / 2);
                ctx.translate(dx, dy);
                ctx.rotate(dAngle * Math.PI / 180);
                ctx.drawImage(videoPlayer, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
                ctx.restore();
            } else {
                ctx.drawImage(videoPlayer, 0, 0, canvas.width, canvas.height);
            }

            // Request next frame. Using requestVideoFrameCallback if available for better sync.
            if ('requestVideoFrameCallback' in videoPlayer) {
                videoPlayer.requestVideoFrameCallback(processFrameForDownload);
            } else {
                // Fallback for browsers that don't support requestVideoFrameCallback
                // This might be less perfectly synced.
                requestAnimationFrame(processFrameForDownload);
            }
        }

        videoPlayer.onseeked = () => {
            // Ensure processing starts after seek is complete
            if (videoPlayer.currentTime === 0 && mediaRecorder.state === "recording") {
                 console.log("Video seeked to beginning, starting frame processing for download.");
                if ('requestVideoFrameCallback' in videoPlayer) {
                    videoPlayer.requestVideoFrameCallback(processFrameForDownload);
                } else {
                    requestAnimationFrame(processFrameForDownload);
                }
            }
        };

        // Listen for the 'ended' event on the video player to stop the MediaRecorder
        const onVideoEndedForDownload = () => {
            console.log("Video ended during download process.");
            if (mediaRecorder.state === "recording") {
                mediaRecorder.stop();
            }
            videoPlayer.removeEventListener('ended', onVideoEndedForDownload); // Clean up listener
            videoPlayer.removeEventListener('pause', onVideoPausedForDownload);
        };
        const onVideoPausedForDownload = () => {
            // If user manually pauses, or something else pauses it.
             console.log("Video paused during download process.");
            if (mediaRecorder.state === "recording" && !videoPlayer.ended) {
                // Consider if we should stop or wait. For now, stop.
                // mediaRecorder.stop();
                // This might be problematic if it's a temporary pause.
                // For now, we let processFrameForDownload handle this.
            }
        };

        videoPlayer.addEventListener('ended', onVideoEndedForDownload);
        videoPlayer.addEventListener('pause', onVideoPausedForDownload);


        // Start playback to trigger frame processing
        try {
            await videoPlayer.play(); // Play to start generating frames
             console.log("Video playback started for recording.");
             if (videoPlayer.currentTime === 0 && mediaRecorder.state === "recording") {
                // If already at the start and play() doesn't immediately trigger a frame, kickstart it.
                if ('requestVideoFrameCallback' in videoPlayer) {
                    videoPlayer.requestVideoFrameCallback(processFrameForDownload);
                } else {
                    requestAnimationFrame(processFrameForDownload);
                }
            }
        } catch (err) {
            console.error("Error playing video for recording:", err);
            alert("Could not start video playback for recording. See console.");
            mediaRecorder.stop(); // Stop recorder if play fails
            videoPlayer.muted = originalMuted; // Restore
            downloadButton.disabled = false;
            downloadButton.textContent = "Download Video with Shake";
        }
    });
});
