// script.js - YouTube Web DJ Application Logic

// --- Constants ---
const AUTO_CROSSFADE_END_SECONDS = 8;
const STUTTER_RATES = [2, 4, 8, 16]; // Hz - Available rates for cycling
const DEFAULT_STUTTER_RATE = STUTTER_RATES[0]; // Default rate is the first in the array (2Hz)
const STUTTER_SHORT_PLAY_DURATION_MS = 100; // How long each stutter plays for
const TAP_TEMPO_MIN_TAPS = 4;
const TAP_TEMPO_TIMEOUT = 2000; // ms to reset tap sequence
const MAX_DECKS = 4;
const LOCAL_STORAGE_CONSENT_KEY = 'ytDjConsentStatus';
const LOCAL_STORAGE_PLAYLISTS_KEY = 'ytDjPlaylists';
const LOCAL_STORAGE_TRACK_SETTINGS_PREFIX = 'ytDjTrackSettings_';
const PREFERENCES_CONSENT_ID = 'preferences'; // Matches checkbox ID part
const MAX_CUE_POINTS = 3;

// --- Global State ---
let ytApiReady = false;
// players array is removed as player instances are managed within Deck objects
let deckObjects = [];
let mixer;
let uiManager;
let playlistManager;
let consentManager;
let storageManager;

// A list to queue deck initializations if onYouTubeIframeAPIReady hasn't fired yet
let deckInitializationQueue = [];

// --- Utility Functions ---

/**
 * Formats time in seconds to mm:ss string.
 * @param {number} timeInSeconds
 * @returns {string} Formatted time string
 */
function formatTime(timeInSeconds) {
    if (isNaN(timeInSeconds) || timeInSeconds < 0) {
        return "0:00";
    }
    const minutes = Math.floor(timeInSeconds / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/**
 * Parses a time string (mm:ss or seconds) into seconds.
 * @param {string} timeString - The time string to parse.
 * @returns {number|null} Time in seconds, or null if invalid.
 */
function parseTimeInput(timeString) {
    if (typeof timeString !== 'string' || timeString.trim() === '') return null;
    if (timeString.includes(':')) {
        const parts = timeString.split(':');
        if (parts.length === 2) {
            const minutes = parseInt(parts[0], 10);
            const seconds = parseFloat(parts[1]);
            if (!isNaN(minutes) && !isNaN(seconds) && minutes >= 0 && seconds >= 0 && seconds < 60) {
                return (minutes * 60) + seconds;
            }
        }
    } else {
        const seconds = parseFloat(timeString);
        if (!isNaN(seconds) && seconds >= 0) {
            return seconds;
        }
    }
    return null; // Invalid format
}


/**
 * Extracts YouTube Video ID from various URL formats or if ID is passed directly.
 * @param {string} urlOrId - The YouTube URL or Video ID.
 * @returns {string|null} The Video ID or null if invalid.
 */
function parseYouTubeUrl(urlOrId) {
    if (!urlOrId) return null;
    // Check if it's a raw 11-character ID
    if (urlOrId.length === 11 && !urlOrId.includes(' ') && !urlOrId.includes('/')) {
        return urlOrId;
    }
    const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = urlOrId.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

/**
 * Displays a toast notification.
 * @param {string} message - The message to display.
 * @param {'info'|'success'|'warning'|'error'} type - Notification type.
 * @param {number} duration - How long to display in ms.
 */
function showNotification(message, type = 'info', duration = 3000) {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `notification-toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('show');
    }, 10); // Small delay to allow CSS transition

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            if (toast.parentNode === container) { // Check if still child before removing
                 container.removeChild(toast);
            }
        }, 500); // Allow fade out transition
    }, duration);
}


// --- Consent Manager ---
class ConsentManager {
    constructor() {
        this.consentBanner = document.getElementById('consent-banner');
        this.consentModal = document.getElementById('consent-modal');
        this.consentPreferencesCheckbox = document.getElementById('consent-preferences');
        this.consentStatus = { essential: true }; // Essential consent is always true

        this.initListeners();
        this.loadConsentStatus();
    }

    initListeners() {
        document.getElementById('consent-accept-all')?.addEventListener('click', () => this.handleAcceptAll(true));
        document.getElementById('consent-reject-all')?.addEventListener('click', () => this.handleRejectAll(true));
        document.getElementById('consent-customize')?.addEventListener('click', () => this.showModal());
        document.getElementById('manage-consent-button')?.addEventListener('click', () => this.showModal());
        document.getElementById('consent-modal-close')?.addEventListener('click', () => this.hideModal());
        document.getElementById('consent-save')?.addEventListener('click', () => this.saveModalChoices());
        document.getElementById('consent-modal-reject-all')?.addEventListener('click', () => this.handleRejectAll(false));
        document.getElementById('consent-modal-accept-all')?.addEventListener('click', () => this.handleAcceptAll(false));
    }

    loadConsentStatus() {
        const storedConsent = localStorage.getItem(LOCAL_STORAGE_CONSENT_KEY);
        if (storedConsent) {
            try {
                const consent = JSON.parse(storedConsent);
                this.consentStatus = {...consent, essential: true}; // Ensure essential is always true
                if (this.consentPreferencesCheckbox) {
                    this.consentPreferencesCheckbox.checked = !!this.consentStatus[PREFERENCES_CONSENT_ID];
                }
            } catch (e) {
                console.error("Error parsing consent status from localStorage:", e);
                this.consentStatus = { essential: true }; // Reset to default
                 if (this.consentPreferencesCheckbox) {
                    this.consentPreferencesCheckbox.checked = false; // Default for preferences
                 }
                 localStorage.removeItem(LOCAL_STORAGE_CONSENT_KEY); // Clear invalid entry
                 this.showBanner(); // Show banner as consent is now unknown/default
                 return;
            }
            this.hideBanner(); // Hide banner if consent was successfully loaded
        } else {
            // No stored consent, show banner and default preferences checkbox
            if (this.consentPreferencesCheckbox) {
                 this.consentPreferencesCheckbox.checked = false; // Default for preferences
            }
            this.showBanner();
        }
    }


    saveConsentStatus() {
        localStorage.setItem(LOCAL_STORAGE_CONSENT_KEY, JSON.stringify(this.consentStatus));
        this.applyConsentToUI();
        if (playlistManager) playlistManager.refreshPlaylistsAfterConsentChange();
    }

    hasConsent(type = PREFERENCES_CONSENT_ID) {
        return !!this.consentStatus[type];
    }

    showBanner() {
        this.consentBanner?.classList.remove('hidden');
    }

    hideBanner() {
        this.consentBanner?.classList.add('hidden');
    }

    showModal() {
        this.hideBanner();
        if (this.consentPreferencesCheckbox) {
            this.consentPreferencesCheckbox.checked = this.hasConsent(PREFERENCES_CONSENT_ID);
        }
        this.consentModal?.classList.remove('hidden');
    }

    hideModal() {
        this.consentModal?.classList.add('hidden');
    }

    handleAcceptAll(fromBanner) {
        this.consentStatus[PREFERENCES_CONSENT_ID] = true;
        if (this.consentPreferencesCheckbox) this.consentPreferencesCheckbox.checked = true;
        this.saveConsentStatus();
        if (fromBanner) this.hideBanner();
        this.hideModal();
        showNotification('All preferences accepted.', 'success');
    }

    handleRejectAll(fromBanner) {
        this.consentStatus[PREFERENCES_CONSENT_ID] = false;
        if (this.consentPreferencesCheckbox) this.consentPreferencesCheckbox.checked = false;
        this.saveConsentStatus(); // Save the rejection
        if (fromBanner) this.hideBanner();
        this.hideModal();
        showNotification('Non-essential preferences rejected.', 'info');
    }

    saveModalChoices() {
        this.consentStatus[PREFERENCES_CONSENT_ID] = this.consentPreferencesCheckbox?.checked || false;
        this.saveConsentStatus();
        this.hideModal();
        showNotification('Preferences saved.', 'success');
    }

    applyConsentToUI() {
        const hasPrefsConsent = this.hasConsent(PREFERENCES_CONSENT_ID);
        document.getElementById('save-playlist-button')?.setAttribute('aria-disabled', String(!hasPrefsConsent));
        const playlistSaveNotice = document.getElementById('playlist-save-notice');
        if (playlistSaveNotice) playlistSaveNotice.style.display = hasPrefsConsent ? 'none' : 'block';

        // Update UI for each deck based on consent
        deckObjects.forEach(deck => {
            if (deck) deck.updateConsentUI(hasPrefsConsent);
        });
    }
}

// --- Storage Manager ---
class StorageManager {
    constructor(consentMgr) {
        this.consentManager = consentMgr;
    }

    savePlaylists(playlists) {
        if (this.consentManager.hasConsent(PREFERENCES_CONSENT_ID)) {
            try {
                localStorage.setItem(LOCAL_STORAGE_PLAYLISTS_KEY, JSON.stringify(playlists));
                return true;
            } catch (e) { // Handle potential storage errors (e.g., quota exceeded)
                 console.error("Error saving playlists to localStorage:", e);
                 showNotification("Error saving playlists. Storage might be full.", "error");
                 return false;
            }
        }
        return false;
    }

    loadPlaylists() {
        if (this.consentManager.hasConsent(PREFERENCES_CONSENT_ID)) {
            const data = localStorage.getItem(LOCAL_STORAGE_PLAYLISTS_KEY);
            try {
                return data ? JSON.parse(data) : {};
            } catch (e) {
                console.error("Error parsing playlists from localStorage:", e);
                return {}; // Return empty object on error
            }
        }
        return {}; // Return empty if no consent
    }

    saveTrackSettings(videoId, settings) {
        if (this.consentManager.hasConsent(PREFERENCES_CONSENT_ID) && videoId) {
             try {
                localStorage.setItem(`${LOCAL_STORAGE_TRACK_SETTINGS_PREFIX}${videoId}`, JSON.stringify(settings));
                return true;
             } catch (e) {
                 console.error(`Error saving settings for video ${videoId}:`, e);
                 showNotification("Error saving track settings. Storage might be full.", "error");
                 return false;
             }
        }
        return false;
    }

    loadTrackSettings(videoId) {
        if (this.consentManager.hasConsent(PREFERENCES_CONSENT_ID) && videoId) {
            const data = localStorage.getItem(`${LOCAL_STORAGE_TRACK_SETTINGS_PREFIX}${videoId}`);
             try {
                return data ? JSON.parse(data) : null;
            } catch (e) {
                console.error(`Error parsing settings for video ${videoId}:`, e);
                return null; // Return null on error
            }
        }
        return null; // Return null if no consent
    }
}


// --- Deck Class ---
class Deck {
    constructor(deckId, onPlayerReadyCallback) {
        this.deckId = deckId;
        this.deckNumber = parseInt(deckId.replace('deck', ''), 10);
        this.player = null;
        this.playerReady = false; // This will be true ONLY after YT.Player's onReady event
        this.playerApiReadyAndPlayerInitialized = false; // Helper to know if YT.Player construction was called
        this.onPlayerReadyCallback = onPlayerReadyCallback; // General callback for app logic
        this.currentVideoId = null;
        this.queuedVideoId = null; // For videos loaded before player is ready
        this.trackInfo = { title: '', duration: 0, currentTime: 0 };
        this.playbackState = -1; // YT.PlayerState
        this.playbackTimeBeforeSeek = 0; // Store time before user starts dragging seek slider

        this.intendedVolume = 80; // Volume set by user on this deck's slider
        this.effectiveVolume = 0; // Actual volume after master/crossfader adjustments

        this.cuePoints = new Array(MAX_CUE_POINTS).fill(null); // Store cue point times in seconds

        this.loop = { in: null, out: null, active: false, timer: null, selectedBeatLoopLength: null };
        this.bpm = null;
        this.tapTempoData = { taps: [], lastTapTime: 0 };

        this.stutterFx = {
            activeFxType: null, // 'step' or 'loop'
            rate: DEFAULT_STUTTER_RATE, // Current stutter rate in Hz
            intervalId: null, // For the stutter effect interval
            originalPlayerState: null, // Player state before stutter started
            stutterLoopStartTime: null, // For 'loop' type, the time to loop back to
            stutterTimeoutId: null // Timeout for the short play duration in stutter
        };
        this.updateInterval = null; // For regularly updating time display and seek bar
        this.isDraggingSlider = false; // True if user is currently dragging the seek slider
        this.isLoading = false; // True if a track is currently being loaded

        // DOM Element references
        this.dom = {
            deckElement: document.getElementById(this.deckId),
            playerContainer: document.querySelector(`#${this.deckId} .player-container`),
            playerDivId: `player${this.deckNumber}`,
            youtubeUrlInput: document.querySelector(`#${this.deckId} .youtube-url`),
            loadButton: document.querySelector(`#${this.deckId} .load-button`),
            trackTitleDisplay: document.querySelector(`#${this.deckId} .track-title-display`),
            videoToggleButton: document.querySelector(`#${this.deckId} .video-toggle-button`),
            playPauseToggleButton: document.querySelector(`#${this.deckId} .play-pause-toggle`),
            currentTimeDisplay: document.querySelector(`#${this.deckId} .current-time`),
            durationDisplay: document.querySelector(`#${this.deckId} .duration`),
            seekSlider: document.querySelector(`#${this.deckId} .seek-slider`),
            cuePointMarkers: [],
            cueSetButtons: [],
            cueJumpButtons: [],
            cueTimeInputs: [],
            loopRangeMarker: document.querySelector(`#${this.deckId} .loop-range-marker`),
            loopInMarkerOnSeek: document.querySelector(`#${this.deckId} .loop-in-marker-on-seek`),
            loopOutMarkerOnSeek: document.querySelector(`#${this.deckId} .loop-out-marker-on-seek`),
            volumeSlider: document.getElementById(`volume-${this.deckId}`),
            vuMeterBar: document.getElementById(`vu-meter-${this.deckId}`),
            bpmInput: document.getElementById(`bpm-${this.deckId}`),
            tapTempoButton: document.querySelector(`#${this.deckId} .tap-tempo-button`),
            loopInInput: document.getElementById(`loop-in-${this.deckId}`),
            loopInButton: document.querySelector(`#${this.deckId} .loop-in-button`),
            loopOutInput: document.getElementById(`loop-out-${this.deckId}`),
            loopOutButton: document.querySelector(`#${this.deckId} .loop-out-button`),
            loopToggleButton: document.querySelector(`#${this.deckId} .loop-toggle-button`),
            beatLoopButtons: document.querySelectorAll(`#${this.deckId} .beat-loop-length-button`),
            stutterStepButton: document.querySelector(`#${this.deckId} .stutter-step-button`),
            stutterLoopButton: document.querySelector(`#${this.deckId} .stutter-loop-button`),
            stutterRateButton: document.getElementById(`stutter-fx-rate-button-${this.deckId}`),
            settingsSaveNotice: document.getElementById(`deck-settings-save-notice-${this.deckId}`),
            playWithDeckButtons: document.querySelectorAll(`#${this.deckId} .play-with-deck-button`)
        };

        // Populate cue point related DOM elements
        for (let i = 0; i < MAX_CUE_POINTS; i++) {
            this.dom.cueSetButtons.push(document.querySelector(`#${this.deckId} .cue-set-button-${i + 1}`));
            this.dom.cueJumpButtons.push(document.querySelector(`#${this.deckId} .cue-jump-button-${i + 1}`));
            this.dom.cuePointMarkers.push(document.getElementById(`cue-marker-${i + 1}-deck${this.deckNumber}`));
            this.dom.cueTimeInputs.push(document.getElementById(`cue-time-input-${i + 1}-deck${this.deckNumber}`));
        }

        if (this.dom.volumeSlider) {
            this.intendedVolume = parseInt(this.dom.volumeSlider.value, 10);
        }
        this.updateStutterRateButtonText();
        // Player initialization is now deferred to onYouTubeIframeAPIReady or when deck becomes visible
        this.initEventListeners();
        this.updatePlaybackUI();
    }

    // MODIFIED: This method is now called ONLY when ytApiReady is true.
    initPlayer() {
        // Check if player already exists or if API isn't ready (redundant check, but good for safety)
        if (this.player || !ytApiReady) {
            if (!ytApiReady) console.warn(`${this.deckId}: initPlayer called, but YT API still not ready. Should not happen if logic is correct.`);
            if (this.player) console.log(`${this.deckId}: initPlayer called, but player object already exists.`);
            return;
        }

        console.log(`Attempting to create YT.Player for ${this.dom.playerDivId}.`);
        try {
            this.player = new YT.Player(this.dom.playerDivId, {
                height: '100%',
                width: '100%',
                playerVars: {
                    'playsinline': 1,
                    'controls': 0,
                    'disablekb': 1,
                    'modestbranding': 1,
                    'rel': 0,
                    'fs': 0
                },
                events: {
                    'onReady': (event) => this.onPlayerReady(event),
                    'onStateChange': (event) => this.onPlayerStateChange(event),
                    'onError': (event) => this.onPlayerError(event)
                }
            });
            this.playerApiReadyAndPlayerInitialized = true; // Mark that YT.Player constructor was called
            console.log(`YT.Player constructor called for ${this.dom.playerDivId}. Waiting for onReady event.`);
        } catch (e) {
            console.error(`Error creating YT Player for ${this.dom.playerDivId}:`, e);
            showNotification(`Failed to initialize player for ${this.deckId}. See console.`, 'error');
            this.playerApiReadyAndPlayerInitialized = false; // Explicitly mark as failed
        }
    }

    // MODIFIED: Logic for handling player readiness and queued videos
    onPlayerReady(event) {
        // It's crucial that `this.player` is the instance that fired this event.
        // The 'event.target' IS the player instance.
        if(event.target !== this.player) {
            console.warn(`${this.deckId}: onPlayerReady event target does not match this.player. This is unexpected.`);
            // Potentially re-assign, though this indicates a deeper issue if it happens.
            // this.player = event.target;
        }

        this.playerReady = true; // Player instance is now ready for commands
        console.log(`${this.deckId} player instance is ready (onReady event fired).`);
        this.updateVolume();
        if (this.onPlayerReadyCallback) {
            this.onPlayerReadyCallback(this);
        }

        // If there's a video queued for this deck, load it now.
        if (this.queuedVideoId) {
            console.log(`${this.deckId}: Player is ready, attempting to load queued video: ${this.queuedVideoId}`);
            const videoToLoad = this.queuedVideoId;
            this.queuedVideoId = null; // Clear queue before loading
            this.loadVideoById(videoToLoad); // This will now use the ready player
        }
    }


    onPlayerStateChange(event) {
        const previousState = this.playbackState;
        this.playbackState = event.data;

        if (this.isLoading && (event.data === YT.PlayerState.CUED || (event.data === YT.PlayerState.PLAYING && previousState !== YT.PlayerState.PLAYING))) {
            this.isLoading = false;
            if (this.dom.loadButton && this.dom.loadButton.querySelector('i.fa-spinner')) {
                const loadButtonIcon = this.dom.loadButton.querySelector('i');
                if (loadButtonIcon) {
                    loadButtonIcon.classList.remove('fa-spinner', 'fa-spin');
                    loadButtonIcon.classList.add('fa-plus-circle');
                }
                if (this.dom.youtubeUrlInput) {
                    this.dom.loadButton.disabled = this.dom.youtubeUrlInput.value.trim() === '';
                } else {
                    this.dom.loadButton.disabled = true;
                }
            }
        }


        if (event.data === YT.PlayerState.PLAYING) {
            if (previousState !== YT.PlayerState.PLAYING) {
                if (this.player && typeof this.player.getDuration === 'function') {
                    this.trackInfo.duration = this.player.getDuration();
                    if(this.dom.durationDisplay) this.dom.durationDisplay.textContent = formatTime(this.trackInfo.duration);
                    if(this.dom.seekSlider) this.dom.seekSlider.max = this.trackInfo.duration;
                    this.updateCueMarkers();
                    this.updateLoopRangeMarker();
                }
            }
            this.startUpdateTimeLoop();
            this.checkAutoCrossfade();
        } else {
            this.stopUpdateTimeLoop();
            if (this.stutterFx.activeFxType === 'loop' && event.data === YT.PlayerState.ENDED) {
                 this.stopStutterFx();
            }
        }
         this.updateVUMeter();

        if (event.data === YT.PlayerState.ENDED) {
            if (this.loop.active && this.loop.in !== null && this.loop.out !== null && this.loop.in < this.loop.out) {
                this.player.seekTo(this.loop.in, true);
            } else {
                this.resetLoop();
            }
            this.stopStutterFx();
        }

         if (event.data === YT.PlayerState.CUED) {
             this.playbackState = YT.PlayerState.PAUSED; // Treat CUED as PAUSED for UI consistency
            if (this.player && typeof this.player.getVideoData === 'function' && typeof this.player.getDuration === 'function') {
                const videoData = this.player.getVideoData();
                this.trackInfo.title = videoData?.title || 'Track Loaded';
                this.trackInfo.duration = this.player.getDuration();
                if(this.dom.trackTitleDisplay) {
                    this.dom.trackTitleDisplay.textContent = this.trackInfo.title;
                    this.dom.trackTitleDisplay.title = this.trackInfo.title;
                }
                if(this.dom.durationDisplay) this.dom.durationDisplay.textContent = formatTime(this.trackInfo.duration);
                if(this.dom.seekSlider) this.dom.seekSlider.max = this.trackInfo.duration;
                this.updateCueMarkers();
                this.updateLoopRangeMarker();
            }
         }
         this.updatePlaybackUI();
    }

    onPlayerError(event) {
        console.error(`${this.deckId} player error:`, event.data);
        let errorMessage = `Error on ${this.deckId}: `;
        switch (event.data) {
            case 2: errorMessage += "Invalid video ID."; break;
            case 5: errorMessage += "HTML5 player error."; break;
            case 100: errorMessage += "Video not found."; break;
            case 101: case 150: errorMessage += "Playback disabled by owner."; break;
            default: errorMessage += "Unknown error.";
        }
        showNotification(errorMessage, 'error');
        this.resetDeckState();
        if (this.isLoading) {
            this.isLoading = false;
            if (this.dom.loadButton && this.dom.loadButton.querySelector('i.fa-spinner')) {
                const loadButtonIcon = this.dom.loadButton.querySelector('i');
                 if (loadButtonIcon) {
                    loadButtonIcon.classList.remove('fa-spinner', 'fa-spin');
                    loadButtonIcon.classList.add('fa-plus-circle');
                }
                if (this.dom.youtubeUrlInput) {
                     this.dom.loadButton.disabled = this.dom.youtubeUrlInput.value.trim() === '';
                } else {
                    this.dom.loadButton.disabled = true;
                }
            }
        }
    }

    // MODIFIED: Queuing logic refined
    loadVideoById(videoId) {
        if (!videoId) {
            showNotification(`Invalid video ID for ${this.deckId}.`, 'error');
            if (this.dom.youtubeUrlInput) this.dom.youtubeUrlInput.value = '';
            return;
        }

        this.isLoading = true;
        const loadButtonIcon = this.dom.loadButton?.querySelector('i');
        if (loadButtonIcon) {
            loadButtonIcon.classList.remove('fa-plus-circle');
            loadButtonIcon.classList.add('fa-spinner', 'fa-spin');
        }
        if (this.dom.loadButton) this.dom.loadButton.disabled = true;


        // Condition: YT API must be globally ready, AND this deck's player instance must exist AND be ready
        if (ytApiReady && this.player && this.playerReady && typeof this.player.cueVideoById === 'function') {
            this.currentVideoId = videoId;
            console.log(`${this.deckId}: Player ready, calling cueVideoById for ${videoId}.`);
            this.player.cueVideoById(videoId);
            if(this.dom.deckElement) this.dom.deckElement.classList.add('track-loaded-flash');
            setTimeout(() => this.dom.deckElement?.classList.remove('track-loaded-flash'), 700);
            this.resetDeckState(false); // Reset some state but keep video ID
            this.loadTrackSettings();
        } else {
            console.warn(`${this.deckId} player not ready, API not ready, or cueVideoById not available. Queuing ${videoId}. YT API Ready: ${ytApiReady}, Player Exists: ${!!this.player}, Player Ready: ${this.playerReady}`);
            this.queuedVideoId = videoId;
            // If the API is ready but this specific player instance hasn't been created yet (e.g. for decks 3 & 4 initially),
            // AND it hasn't been marked as initialization attempted, try to initialize it.
            // onYouTubeIframeAPIReady will handle initial player creations.
            // This case is more for players created on demand (e.g. toggle to 4-deck view if API already ready)
            if (ytApiReady && !this.player && !this.playerApiReadyAndPlayerInitialized) {
                 console.log(`${this.deckId}: YT API is ready, but this player object doesn't exist yet. Triggering initPlayer.`);
                 this.initPlayer(); // Attempt to create the YT.Player instance
            } else if (!ytApiReady) {
                console.log(`${this.deckId}: YT API not globally ready. Video queued. Player will be initialized by onYouTubeIframeAPIReady.`);
                // Add to global queue if not already there, for onYouTubeIframeAPIReady to pick up
                if (!deckInitializationQueue.find(d => d.deckId === this.deckId)) {
                    deckInitializationQueue.push(this);
                }
            }
        }
        if (this.dom.youtubeUrlInput) this.dom.youtubeUrlInput.value = '';
    }


    resetDeckState(fullReset = true) {
        this.stopUpdateTimeLoop();
        this.stopStutterFx();
        this.resetLoop();

        this.trackInfo = { title: '', duration: 0, currentTime: 0 };
        this.playbackState = -1;

        if (fullReset || !this.currentVideoId) {
            this.cuePoints = new Array(MAX_CUE_POINTS).fill(null);
        }
        this.dom.cueTimeInputs.forEach(input => {
            if (input) input.value = ''; input.placeholder = '-:--';
        });
        this.updateCueMarkers();

        if(this.dom.trackTitleDisplay) {
            this.dom.trackTitleDisplay.textContent = 'No track loaded';
            this.dom.trackTitleDisplay.title = 'No track loaded';
        }
        if(this.dom.currentTimeDisplay) this.dom.currentTimeDisplay.textContent = '0:00';
        if(this.dom.durationDisplay) this.dom.durationDisplay.textContent = '0:00';
        if(this.dom.seekSlider) {
            this.dom.seekSlider.value = 0;
            this.dom.seekSlider.max = 100;
        }
        if (this.dom.loopInInput) this.dom.loopInInput.value = '';
        if (this.dom.loopOutInput) this.dom.loopOutInput.value = '';

        if (fullReset) {
            if (this.dom.bpmInput) this.dom.bpmInput.value = '';
            this.bpm = null;
            this.loop.selectedBeatLoopLength = null;
            this.currentVideoId = null;
            // this.queuedVideoId = null; // Do not clear queuedVideoId here, loadVideoById might need it
            if (this.dom.youtubeUrlInput) this.dom.youtubeUrlInput.value = '';
            if (this.dom.loadButton && !this.isLoading) {
                 this.dom.loadButton.disabled = this.dom.youtubeUrlInput ? this.dom.youtubeUrlInput.value.trim() === '' : true;
            }
        }
        this.updatePlaybackUI();
        this.updateLoopRangeMarker();
        this.updateActiveBeatLoopButton();
        this.updateVUMeter(0);
    }


    startUpdateTimeLoop() {
        this.stopUpdateTimeLoop();
        this.updateInterval = setInterval(() => {
            if (!this.playerReady || !this.player || typeof this.player.getCurrentTime !== 'function') {
                this.stopUpdateTimeLoop();
                return;
            }

            const currentTime = this.player.getCurrentTime();
            const currentState = this.player.getPlayerState();

            if (!this.isDraggingSlider) {
                if (this.stutterFx.activeFxType !== 'loop') {
                    this.trackInfo.currentTime = currentTime;
                    if(this.dom.currentTimeDisplay) this.dom.currentTimeDisplay.textContent = formatTime(currentTime);
                    if(this.dom.seekSlider) this.dom.seekSlider.value = currentTime;
                }
            }

            if (this.loop.active && this.loop.out !== null && currentTime >= this.loop.out && !this.stutterFx.activeFxType) {
                if (this.player && typeof this.player.seekTo === 'function') {
                    this.player.seekTo(this.loop.in, true);
                }
            }

            this.updateVUMeter();

            if (currentState === YT.PlayerState.PLAYING && !this.stutterFx.activeFxType) {
                this.checkAutoCrossfade();
            }

        }, 250);
    }


    stopUpdateTimeLoop() {
        clearInterval(this.updateInterval);
        this.updateInterval = null;
    }

    updatePlaybackUI() {
        if (this.playerReady && this.player && typeof this.player.getVideoData === 'function') {
            const videoData = this.player.getVideoData();
            this.trackInfo.title = videoData?.title ? videoData.title : (this.currentVideoId ? 'Loading...' : 'No track loaded');
        } else {
             this.trackInfo.title = this.currentVideoId ? 'Loading...' : (this.queuedVideoId ? 'Queued...' : 'No track loaded');
        }
        if(this.dom.trackTitleDisplay) {
            this.dom.trackTitleDisplay.textContent = this.trackInfo.title;
            this.dom.trackTitleDisplay.title = this.trackInfo.title;
        }

        if (this.dom.playPauseToggleButton) {
            const playIconElement = this.dom.playPauseToggleButton.querySelector('i');
            if (!playIconElement) return;

            let showAsPlaying;

            if (this.stutterFx.activeFxType) {
                showAsPlaying = this.stutterFx.originalPlayerState === YT.PlayerState.PLAYING;
            } else {
                showAsPlaying = this.playbackState === YT.PlayerState.PLAYING;
            }

            if (showAsPlaying) {
                playIconElement.classList.remove('fa-play');
                playIconElement.classList.add('fa-pause');
                this.dom.playPauseToggleButton.setAttribute('aria-pressed', 'true');
                this.dom.playPauseToggleButton.title = 'Pause Track';
            } else {
                playIconElement.classList.remove('fa-pause');
                playIconElement.classList.add('fa-play');
                this.dom.playPauseToggleButton.setAttribute('aria-pressed', 'false');
                this.dom.playPauseToggleButton.title = 'Play Track';
            }
            // Enable play/pause if a video is current, or queued and player is ready to load it
            this.dom.playPauseToggleButton.disabled = (!this.currentVideoId && !this.queuedVideoId) || !this.playerReady;
        }
    }


    updateVolume() {
        if (this.playerReady && this.player && typeof this.player.setVolume === 'function') {
            this.player.setVolume(Math.round(this.effectiveVolume));
        }
        this.updateVUMeter();
    }

    setEffectiveVolume(volume) {
        this.effectiveVolume = Math.max(0, Math.min(100, volume));
        this.updateVolume();
    }

    updateVolumeFromSlider() {
        this.intendedVolume = parseInt(this.dom.volumeSlider.value, 10);
        if (mixer) {
            mixer.updateAllDeckVolumes();
        }
    }

    updateVUMeter(levelOverride = null) {
        if (!this.dom.vuMeterBar) return;
        let levelPercentage;
        if (levelOverride !== null) {
            levelPercentage = levelOverride;
        } else {
            levelPercentage = (this.playerReady && (this.playbackState === YT.PlayerState.PLAYING || this.stutterFx.activeFxType))
                              ? this.effectiveVolume
                              : 0;
        }
        this.dom.vuMeterBar.style.setProperty('--vu-level', `${levelPercentage}%`);
    }

    /**
     * Sets a cue point at the given index.
     * @param {number} cueIndex - The index of the cue point (0-2).
     * @param {number|null} time - Optional time in seconds. If null, uses current player time.
     */
    setCuePoint(cueIndex, time = null) {
        if (cueIndex < 0 || cueIndex >= MAX_CUE_POINTS) {
            console.error(`Invalid cueIndex: ${cueIndex} for ${this.deckId}`);
            showNotification('Invalid cue point index.', 'error');
            return;
        }
        if (!this.playerReady || !this.currentVideoId || typeof this.player.getCurrentTime !== 'function') {
            showNotification(`Load a track first on ${this.deckId} to set cue point ${cueIndex + 1}.`, 'warning');
            return;
        }

        let newCueTime;
        if (time === null) {
            newCueTime = this.player.getCurrentTime();
        } else {
            newCueTime = time;
        }

        if (isNaN(newCueTime) || newCueTime < 0 || (this.trackInfo.duration > 0 && newCueTime > this.trackInfo.duration)) {
            showNotification(`Invalid time for cue point ${cueIndex + 1}.`, 'error');
            const prevCueTime = this.cuePoints[cueIndex];
            if (this.dom.cueTimeInputs[cueIndex]) {
                this.dom.cueTimeInputs[cueIndex].value = prevCueTime !== null ? formatTime(prevCueTime) : '';
                 if(prevCueTime === null) this.dom.cueTimeInputs[cueIndex].placeholder = '-:--';
            }
            return;
        }

        this.cuePoints[cueIndex] = this.snapToBeat(newCueTime);

        if (this.dom.cueTimeInputs[cueIndex]) {
            this.dom.cueTimeInputs[cueIndex].value = formatTime(this.cuePoints[cueIndex]);
        }

        this.updateCueMarkers();
        this.saveCurrentTrackSettings();
        showNotification(`Cue point ${cueIndex + 1} set to ${formatTime(this.cuePoints[cueIndex])} on ${this.deckId}`, 'success');
    }

    /**
     * Jumps to the cue point at the given index.
     * @param {number} cueIndex - The index of the cue point (0-2).
     */
    jumpToCuePoint(cueIndex) {
        if (cueIndex < 0 || cueIndex >= MAX_CUE_POINTS) {
            console.error(`Invalid cueIndex: ${cueIndex} for ${this.deckId}`);
            showNotification('Invalid cue point index.', 'error');
            return;
        }
        if (!this.playerReady || typeof this.player.seekTo !== 'function') {
            showNotification(`Player not ready on ${this.deckId}.`, 'warning');
            return;
        }
        const cueTime = this.cuePoints[cueIndex];
        if (cueTime === null) {
            showNotification(`Cue point ${cueIndex + 1} is not set on ${this.deckId}.`, 'warning');
            return;
        }

        const wasPlaying = this.playbackState === YT.PlayerState.PLAYING;
        this.stopStutterFx(false);

        this.player.seekTo(cueTime, true);

        if (wasPlaying || this.playbackState === YT.PlayerState.PAUSED || this.playbackState === YT.PlayerState.CUED) {
            this.player.playVideo();
        }
        this.resetLoop();
    }

    /**
     * Updates the visual markers for all cue points on the seek slider.
     */
    updateCueMarkers() {
        if (!this.dom.cuePointMarkers || this.dom.cuePointMarkers.length !== MAX_CUE_POINTS) return;

        for (let i = 0; i < MAX_CUE_POINTS; i++) {
            const marker = this.dom.cuePointMarkers[i];
            const cueTime = this.cuePoints[i];
            if (!marker) continue;

            if (cueTime !== null && this.trackInfo.duration > 0) {
                const percentage = (cueTime / this.trackInfo.duration) * 100;
                marker.style.left = `${percentage}%`;
                marker.style.display = 'block';
                marker.title = `Cue ${i + 1}: ${formatTime(cueTime)}`;
            } else {
                marker.style.display = 'none';
            }
        }
    }


    setLoopIn(time = null) {
        if (!this.playerReady || !this.currentVideoId || typeof this.player.getCurrentTime !== 'function') {
             showNotification('Load a track first to set loop points.', 'warning');
             return;
        }
        const newLoopInTime = time !== null ? parseFloat(time) : this.player.getCurrentTime();
        if (isNaN(newLoopInTime) || newLoopInTime < 0 || (this.trackInfo.duration > 0 && newLoopInTime > this.trackInfo.duration)) {
            showNotification('Invalid loop-in time.', 'error');
            if(this.dom.loopInInput) this.dom.loopInInput.value = this.loop.in !== null ? this.loop.in.toFixed(1) : '';
            return;
        }
        this.loop.in = this.snapToBeat(newLoopInTime);
        if(this.dom.loopInInput) this.dom.loopInInput.value = this.loop.in.toFixed(1);
        this.updateLoopRangeMarker();
        this.saveCurrentTrackSettings();
        showNotification(`Loop In set to ${formatTime(this.loop.in)} on ${this.deckId}`, 'info');
    }

    setLoopOut(time = null) {
        if (!this.playerReady || !this.currentVideoId || typeof this.player.getCurrentTime !== 'function') {
            showNotification('Load a track first to set loop points.', 'warning');
            return;
        }
        const newLoopOutTime = time !== null ? parseFloat(time) : this.player.getCurrentTime();
         if (isNaN(newLoopOutTime) || newLoopOutTime < 0 || (this.trackInfo.duration > 0 && newLoopOutTime > this.trackInfo.duration)) {
            showNotification('Invalid loop-out time.', 'error');
            if(this.dom.loopOutInput) this.dom.loopOutInput.value = this.loop.out !== null ? this.loop.out.toFixed(1) : '';
            return;
        }
        const snappedLoopOutTime = this.snapToBeat(newLoopOutTime);
        if (this.loop.in !== null && snappedLoopOutTime <= this.loop.in) {
            showNotification('Loop Out must be after Loop In.', 'warning');
            if(this.dom.loopOutInput) this.dom.loopOutInput.value = this.loop.out !== null ? this.loop.out.toFixed(1) : '';
        } else {
            this.loop.out = snappedLoopOutTime;
            if(this.dom.loopOutInput) this.dom.loopOutInput.value = this.loop.out.toFixed(1);
            this.saveCurrentTrackSettings();
            showNotification(`Loop Out set to ${formatTime(this.loop.out)} on ${this.deckId}`, 'info');
        }
        this.updateLoopRangeMarker();
    }

    toggleLoop() {
        if (this.loop.in === null || this.loop.out === null || this.loop.in >= this.loop.out) {
            if (this.loop.in !== null && this.loop.selectedBeatLoopLength && this.bpm) {
                const beats = this.loop.selectedBeatLoopLength;
                const beatDuration = 60 / this.bpm;
                const loopDuration = beats * beatDuration;
                let calculatedLoopOut = this.snapToBeat(this.loop.in + loopDuration);
                if (this.trackInfo.duration > 0 && calculatedLoopOut > this.trackInfo.duration) calculatedLoopOut = this.trackInfo.duration;

                if (calculatedLoopOut > this.loop.in) {
                    this.loop.out = calculatedLoopOut;
                    if(this.dom.loopOutInput) this.dom.loopOutInput.value = this.loop.out.toFixed(1);
                    showNotification(`Loop Out auto-set to ${formatTime(this.loop.out)} for ${beats} beats.`, 'info');
                } else {
                     showNotification('Cannot auto-set loop out. Check BPM or Loop In.', 'warning');
                     return;
                }
            } else {
                showNotification('Set valid Loop In & Out, or select beat loop with BPM.', 'warning');
                return;
            }
        }

        this.loop.active = !this.loop.active;
        if(this.dom.loopToggleButton) {
            this.dom.loopToggleButton.innerHTML = `<i class="fas fa-redo"></i> Loop ${this.loop.active ? 'ON' : 'OFF'}`;
            this.dom.loopToggleButton.classList.toggle('loop-active', this.loop.active);
        }
        this.updateLoopRangeMarker();
        this.saveCurrentTrackSettings();

        if (this.loop.active && this.playerReady && typeof this.player.getCurrentTime === 'function' && this.player.getCurrentTime() >= this.loop.out) {
            if (!this.stutterFx.activeFxType) {
                if (this.player && typeof this.player.seekTo === 'function') {
                    this.player.seekTo(this.loop.in, true);
                }
            }
        }
         showNotification(`Loop ${this.loop.active ? 'activated' : 'deactivated'} on ${this.deckId}`, 'info');
    }

    resetLoop() {
        this.loop.active = false;
        if (this.dom.loopToggleButton) {
            this.dom.loopToggleButton.innerHTML = '<i class="fas fa-redo"></i> Loop OFF';
            this.dom.loopToggleButton.classList.remove('loop-active');
        }
        this.updateLoopRangeMarker();
    }

    setBeatLoop(beats) {
        if (!this.playerReady || !this.currentVideoId || typeof this.player.getCurrentTime !== 'function') {
             showNotification('Load a track first.', 'warning');
             return;
        }
        if (!this.bpm) {
            showNotification('Set BPM first to use beat loops.', 'warning');
            return;
        }

        if (this.loop.in === null) {
            this.setLoopIn();
        }
        if (this.loop.in === null) return;

        const beatDuration = 60 / this.bpm;
        const loopDuration = parseInt(beats, 10) * beatDuration;
        this.loop.out = this.snapToBeat(this.loop.in + loopDuration);

        if (this.trackInfo.duration > 0 && this.loop.out > this.trackInfo.duration) {
            this.loop.out = this.trackInfo.duration;
        }

        if (this.loop.out <= this.loop.in) {
            showNotification(`Calculated ${beats}-beat loop out point is not after loop in. Adjust BPM or loop in point.`, 'warning');
            this.loop.out = null;
        }


        if(this.dom.loopOutInput) this.dom.loopOutInput.value = this.loop.out !== null ? this.loop.out.toFixed(1) : '';
        this.loop.selectedBeatLoopLength = parseInt(beats, 10);

        this.updateActiveBeatLoopButton();
        this.updateLoopRangeMarker();
        this.saveCurrentTrackSettings();

        showNotification(`${beats}-Beat Loop points set on ${this.deckId}. Use 'Loop' button to activate.`, 'success');
    }

    updateActiveBeatLoopButton() {
        this.dom.beatLoopButtons.forEach(btn => {
            btn.classList.remove('active');
            if (this.loop.selectedBeatLoopLength && parseInt(btn.dataset.beats) === this.loop.selectedBeatLoopLength) {
                btn.classList.add('active');
            }
        });
    }

    updateLoopRangeMarker() {
        if (this.loop.in !== null && this.loop.out !== null && this.loop.out > this.loop.in && this.trackInfo.duration > 0) {
            const inPercent = (this.loop.in / this.trackInfo.duration) * 100;
            const outPercent = (this.loop.out / this.trackInfo.duration) * 100;
            if(this.dom.loopRangeMarker) {
                this.dom.loopRangeMarker.style.left = `${inPercent}%`;
                this.dom.loopRangeMarker.style.width = `${Math.max(0, outPercent - inPercent)}%`;
                this.dom.loopRangeMarker.style.display = 'block';
            }
            if(this.dom.loopInMarkerOnSeek) this.dom.loopInMarkerOnSeek.style.display = 'block';
            if(this.dom.loopOutMarkerOnSeek) this.dom.loopOutMarkerOnSeek.style.display = 'block';
        } else {
            if(this.dom.loopRangeMarker) this.dom.loopRangeMarker.style.display = 'none';
            if(this.dom.loopInMarkerOnSeek) this.dom.loopInMarkerOnSeek.style.display = 'none';
            if(this.dom.loopOutMarkerOnSeek) this.dom.loopOutMarkerOnSeek.style.display = 'none';
        }
    }

    setBPM(newBpm) {
        const parsedBpm = parseFloat(newBpm);
        if (!isNaN(parsedBpm) && parsedBpm > 0) {
            this.bpm = parsedBpm;
            if(this.dom.bpmInput) this.dom.bpmInput.value = this.bpm.toFixed(1);
            this.saveCurrentTrackSettings();
             showNotification(`BPM for ${this.deckId} set to ${this.bpm.toFixed(1)}`, 'info');
        } else if (newBpm === '') {
            this.bpm = null;
            if(this.dom.bpmInput) this.dom.bpmInput.value = '';
            this.saveCurrentTrackSettings();
        }
    }

    tapTempo() {
        const now = Date.now();
        if (this.tapTempoData.lastTapTime && (now - this.tapTempoData.lastTapTime > TAP_TEMPO_TIMEOUT)) {
            this.tapTempoData.taps = [];
        }

        this.tapTempoData.taps.push(now);
        this.tapTempoData.lastTapTime = now;

        if (this.tapTempoData.taps.length >= TAP_TEMPO_MIN_TAPS) {
            let intervals = [];
            for (let i = 1; i < this.tapTempoData.taps.length; i++) {
                intervals.push(this.tapTempoData.taps[i] - this.tapTempoData.taps[i-1]);
            }
            intervals.sort((a, b) => a - b);
            const  medianIntervals = intervals.slice(Math.floor(intervals.length * 0.25), Math.ceil(intervals.length * 0.75));
            if(medianIntervals.length === 0 && intervals.length > 0) medianIntervals.push(intervals[Math.floor(intervals.length/2)]);


            const averageInterval = medianIntervals.reduce((sum, val) => sum + val, 0) / medianIntervals.length;
            if (averageInterval > 0) {
                const calculatedBpm = 60000 / averageInterval;
                this.setBPM(calculatedBpm.toFixed(1));
                if (this.tapTempoData.taps.length > TAP_TEMPO_MIN_TAPS + 4) {
                    this.tapTempoData.taps.shift();
                }
            }
        }
    }

    snapToBeat(time) {
        if (!this.bpm || !this.playerReady || this.bpm <=0) return time;

        const beatDuration = 60 / this.bpm;
        if (beatDuration <= 0) return time;

        const currentBeatNumber = Math.round(time / beatDuration);
        let snappedTime = currentBeatNumber * beatDuration;

        snappedTime = Math.max(0, snappedTime);
        if (this.trackInfo.duration > 0) {
            snappedTime = Math.min(this.trackInfo.duration, snappedTime);
        }
        return snappedTime;
    }

    playWithDeck(targetDeckId) {
        const targetDeck = deckObjects.find(d => d.deckId === targetDeckId);
        if (!targetDeck || !this.playerReady || typeof this.player.playVideo !== 'function') {
            showNotification(`Target deck ${targetDeckId} not found or this deck not ready.`, 'warning');
            return;
        }

        if (targetDeck.playerReady && typeof targetDeck.player.playVideo === 'function') {
            if (targetDeck.currentVideoId) {
                if (targetDeck.playbackState === YT.PlayerState.PLAYING) {
                    this.player.playVideo();
                } else if (targetDeck.playbackState === YT.PlayerState.PAUSED || targetDeck.playbackState === YT.PlayerState.CUED || targetDeck.playbackState === YT.PlayerState.UNSTARTED) {
                    this.player.playVideo();
                    targetDeck.player.playVideo();
                }
                 showNotification(`Playing ${this.deckId} with ${targetDeckId}`, 'info');
            } else {
                showNotification(`Target deck ${targetDeckId} has no track loaded.`, 'warning');
            }
        } else {
             showNotification(`Target deck ${targetDeckId} player not ready.`, 'warning');
        }
    }

    cycleStutterRate() {
        const currentIndex = STUTTER_RATES.indexOf(this.stutterFx.rate);
        const nextIndex = (currentIndex + 1) % STUTTER_RATES.length;
        const newRate = STUTTER_RATES[nextIndex];

        this.stutterFx.rate = newRate;
        this.updateStutterRateButtonText();

        if (this.stutterFx.activeFxType) {
            console.log(`${this.deckId}: Stutter FX rate changed to ${newRate}Hz while active. Restarting interval.`);
            this.startStutterFxInterval();
        }
        showNotification(`Stutter Rate set to ${newRate}Hz on ${this.deckId}`, 'info');
    }

    updateStutterRateButtonText() {
        if (this.dom.stutterRateButton) {
            this.dom.stutterRateButton.textContent = `Rate: ${this.stutterFx.rate}Hz`;
        }
    }

    toggleStutterFx(fxType) {
        if (!this.playerReady || !this.currentVideoId) {
            showNotification(`Load a track on ${this.deckId} first.`, 'warning');
            return;
        }

        const isCurrentlyActiveAndSameType = this.stutterFx.activeFxType === fxType;

        if (isCurrentlyActiveAndSameType) {
            this.stopStutterFx(true);
        } else {
            if (this.stutterFx.activeFxType) {
                this.stopStutterFx(false);
            }
            this.stutterFx.activeFxType = fxType;
            this.startStutterFx();
        }
    }


    startStutterFx() {
        if (!this.playerReady || !this.currentVideoId || !this.player ||
            typeof this.player.getCurrentTime !== 'function' ||
            typeof this.player.seekTo !== 'function' ||
            typeof this.player.playVideo !== 'function' ||
            typeof this.player.pauseVideo !== 'function') {
            console.warn(`${this.deckId}: Player not ready/available for Stutter FX.`);
            this.stopStutterFx(false);
            return;
        }
        const validPlayerStates = [YT.PlayerState.PLAYING, YT.PlayerState.PAUSED, YT.PlayerState.CUED];
        const currentPlayerState = this.player.getPlayerState();

        if (!validPlayerStates.includes(currentPlayerState) && currentPlayerState !== YT.PlayerState.BUFFERING) {
            console.warn(`${this.deckId}: Stutter FX cannot start, player state is ${currentPlayerState}.`);
            this.stopStutterFx(false);
            return;
        }
        if (!this.stutterFx.activeFxType) {
             console.warn(`${this.deckId}: No active Stutter FX type selected for start.`);
             return;
        }

        if(this.stutterFx.originalPlayerState === null) {
             this.stutterFx.originalPlayerState = currentPlayerState;
             console.log(`${this.deckId}: Stored original player state for stutter: ${this.stutterFx.originalPlayerState}`);
        } else {
             console.log(`${this.deckId}: Stutter starting, originalPlayerState already set to: ${this.stutterFx.originalPlayerState}.`);
        }

        clearInterval(this.stutterFx.intervalId);

        if (this.stutterFx.activeFxType === 'loop') {
             if (this.stutterFx.stutterLoopStartTime === null) {
                 this.stutterFx.stutterLoopStartTime = this.player.getCurrentTime();
                 console.log(`${this.deckId}: Stutter Loop start time set to ${this.stutterFx.stutterLoopStartTime}`);
             }
        } else {
            this.stutterFx.stutterLoopStartTime = null;
        }

        this.startStutterFxInterval();
        this.updateActiveStutterButton();
        this.updatePlaybackUI();
        showNotification(`Stutter ${this.stutterFx.activeFxType === 'step' ? 'Step' : 'Loop'} ON (${this.stutterFx.rate}Hz) for ${this.deckId}`, 'info');
        console.log(`${this.deckId}: Stutter ${this.stutterFx.activeFxType} started at ${this.stutterFx.rate}Hz. Original state: ${this.stutterFx.originalPlayerState}`);
    }

    startStutterFxInterval() {
        clearInterval(this.stutterFx.intervalId);
        this.stutterFx.intervalId = null;

        clearTimeout(this.stutterFx.stutterTimeoutId);
        this.stutterFx.stutterTimeoutId = null;

        const performStutterAction = () => {
            if (!this.stutterFx.activeFxType || !this.playerReady || !this.player ||
                typeof this.player.seekTo !== 'function' ||
                typeof this.player.playVideo !== 'function' ||
                typeof this.player.pauseVideo !== 'function' ||
                typeof this.player.getCurrentTime !== 'function') {
                this.stopStutterFx(false);
                return;
            }

            const currentFreshState = this.player.getPlayerState();
            if (currentFreshState === YT.PlayerState.ENDED || currentFreshState === YT.PlayerState.UNSTARTED || currentFreshState === -1) {
                 console.log(`${this.deckId}: Stutter FX stopping because player ended or is unstarted.`);
                 this.stopStutterFx(true);
                 return;
            }

            let seekTime;
            if (this.stutterFx.activeFxType === 'loop') {
                if (this.stutterFx.stutterLoopStartTime === null) {
                     console.warn(`${this.deckId}: Stutter loop active but start time is null. Using current time.`);
                     this.stutterFx.stutterLoopStartTime = this.player.getCurrentTime();
                }
                seekTime = this.stutterFx.stutterLoopStartTime;
            } else {
                seekTime = this.player.getCurrentTime();
            }

            try {
                this.player.seekTo(seekTime, true);
                this.player.playVideo();
            } catch (e) {
                console.error(`${this.deckId}: Error during stutter seek/play:`, e);
                this.stopStutterFx(false);
                return;
            }

            clearTimeout(this.stutterFx.stutterTimeoutId);
            this.stutterFx.stutterTimeoutId = setTimeout(() => {
                if (this.player && this.stutterFx.activeFxType && typeof this.player.pauseVideo === 'function') {
                     try {
                        this.player.pauseVideo();
                     } catch (e) {
                        console.error(`${this.deckId}: Error pausing video during stutter timeout:`, e);
                     }
                }
            }, STUTTER_SHORT_PLAY_DURATION_MS);
        };

        performStutterAction();

        const intervalDuration = 1000 / this.stutterFx.rate;
        if (intervalDuration > 0 && Number.isFinite(intervalDuration)) {
            this.stutterFx.intervalId = setInterval(performStutterAction, intervalDuration);
        } else {
            console.error(`${this.deckId}: Invalid interval duration for stutter FX: ${intervalDuration}. Rate: ${this.stutterFx.rate}. Stopping FX.`);
            this.stopStutterFx(false);
        }
    }


    stopStutterFx(restorePlayer = true) {
        const wasActiveType = this.stutterFx.activeFxType;

        clearInterval(this.stutterFx.intervalId);
        this.stutterFx.intervalId = null;
        clearTimeout(this.stutterFx.stutterTimeoutId);
        this.stutterFx.stutterTimeoutId = null;

        const originalStateToRestore = this.stutterFx.originalPlayerState;
        this.stutterFx.activeFxType = null;
        this.stutterFx.stutterLoopStartTime = null;
        this.stutterFx.originalPlayerState = null;

        this.updateActiveStutterButton();

        if (restorePlayer && this.playerReady && this.player &&
            typeof this.player.playVideo === 'function' && typeof this.player.pauseVideo === 'function') {

            const currentActualState = this.player.getPlayerState();
            console.log(`${this.deckId}: Stopping stutter. Original state to restore was ${originalStateToRestore}. Current actual state is ${currentActualState}. RestorePlayer: ${restorePlayer}`);

            if (currentActualState !== YT.PlayerState.ENDED &&
                currentActualState !== YT.PlayerState.UNSTARTED &&
                currentActualState !== -1 ) {

                if (originalStateToRestore === YT.PlayerState.PLAYING) {
                    console.log(`${this.deckId}: Restoring to PLAYING state after stutter.`);
                    if (currentActualState !== YT.PlayerState.ENDED) {
                        try {
                             this.player.playVideo();
                             this.playbackState = YT.PlayerState.PLAYING;
                        } catch(e) { console.warn("Error playing video during stopStutterFx restore:", e); }
                    }
                } else if (originalStateToRestore === YT.PlayerState.PAUSED || originalStateToRestore === YT.PlayerState.CUED) {
                     console.log(`${this.deckId}: Restoring to PAUSED/CUED state after stutter.`);
                     if (currentActualState === YT.PlayerState.PLAYING || currentActualState === YT.PlayerState.BUFFERING) {
                        try { this.player.pauseVideo(); } catch(e) { console.warn("Error pausing video during stopStutterFx restore:", e); }
                     }
                     this.playbackState = YT.PlayerState.PAUSED;
                } else {
                    console.log(`${this.deckId}: Original stutter state was null or unexpected (${originalStateToRestore}). Pausing if currently playing/buffering.`);
                    if (currentActualState === YT.PlayerState.PLAYING || currentActualState === YT.PlayerState.BUFFERING) {
                        try { this.player.pauseVideo(); } catch(e) { console.warn("Error pausing video during stopStutterFx (default case):", e); }
                    }
                    this.playbackState = YT.PlayerState.PAUSED;
                }
                 this.updatePlaybackUI();
            } else {
                 console.log(`${this.deckId}: Not restoring player state as current state (${currentActualState}) is not controllable (e.g. ended, unstarted).`);
                 this.updatePlaybackUI();
            }
        } else {
             console.log(`${this.deckId}: Stutter stopped, restorePlayer=${restorePlayer}. Player state remains as is. Original state was ${originalStateToRestore}.`);
             this.updatePlaybackUI();
        }


        if (wasActiveType) {
            showNotification(`Stutter ${wasActiveType === 'step' ? 'Step' : 'Loop'} OFF for ${this.deckId}`, 'info');
            console.log(`${this.deckId}: Stutter ${wasActiveType} stopped. Player state after stop logic: ${this.player ? this.player.getPlayerState() : 'N/A'}`);
        }
    }


    updateActiveStutterButton() {
         if (this.dom.stutterStepButton) {
            this.dom.stutterStepButton.classList.toggle('active', this.stutterFx.activeFxType === 'step');
            this.dom.stutterStepButton.setAttribute('aria-pressed', String(this.stutterFx.activeFxType === 'step'));
         }
         if (this.dom.stutterLoopButton) {
            this.dom.stutterLoopButton.classList.toggle('active', this.stutterFx.activeFxType === 'loop');
            this.dom.stutterLoopButton.setAttribute('aria-pressed', String(this.stutterFx.activeFxType === 'loop'));
         }
    }

    saveCurrentTrackSettings() {
        if (!this.currentVideoId || !storageManager) return;
        const settings = {
            cuePoints: this.cuePoints,
            loopIn: this.loop.in,
            loopOut: this.loop.out,
            bpm: this.bpm,
            selectedBeatLoopLength: this.loop.selectedBeatLoopLength,
            intendedVolume: this.intendedVolume
        };
        storageManager.saveTrackSettings(this.currentVideoId, settings);
    }

    loadTrackSettings() {
        if (!this.currentVideoId || !storageManager) return;
        const settings = storageManager.loadTrackSettings(this.currentVideoId);
        if (settings) {
            if (settings.cuePoints && Array.isArray(settings.cuePoints) && settings.cuePoints.length === MAX_CUE_POINTS) {
                this.cuePoints = settings.cuePoints;
            } else if (settings.cuePoint !== undefined) {
                this.cuePoints = new Array(MAX_CUE_POINTS).fill(null);
                this.cuePoints[0] = settings.cuePoint;
            } else {
                this.cuePoints = new Array(MAX_CUE_POINTS).fill(null);
            }

            this.cuePoints.forEach((cueTime, index) => {
                if (this.dom.cueTimeInputs[index]) {
                    this.dom.cueTimeInputs[index].value = cueTime !== null ? formatTime(cueTime) : '';
                    if(cueTime === null) this.dom.cueTimeInputs[index].placeholder = '-:--';
                }
            });
            this.updateCueMarkers();

            this.loop.in = settings.loopIn !== undefined ? settings.loopIn : null;
            if(this.dom.loopInInput) this.dom.loopInInput.value = this.loop.in !== null ? this.loop.in.toFixed(1) : '';

            this.loop.out = settings.loopOut !== undefined ? settings.loopOut : null;
            if(this.dom.loopOutInput) this.dom.loopOutInput.value = this.loop.out !== null ? this.loop.out.toFixed(1) : '';

            this.updateLoopRangeMarker();

            this.bpm = settings.bpm !== undefined ? settings.bpm : null;
            if(this.dom.bpmInput) this.dom.bpmInput.value = this.bpm !== null ? this.bpm.toFixed(1) : '';

            this.loop.selectedBeatLoopLength = settings.selectedBeatLoopLength !== undefined ? settings.selectedBeatLoopLength : null;
            this.updateActiveBeatLoopButton();

            if (settings.intendedVolume !== undefined) {
                this.intendedVolume = settings.intendedVolume;
                if(this.dom.volumeSlider) this.dom.volumeSlider.value = this.intendedVolume;
                if (mixer) mixer.updateAllDeckVolumes();
            }
            showNotification(`Settings loaded for track on ${this.deckId}`, 'info');
        } else {
            this.cuePoints = new Array(MAX_CUE_POINTS).fill(null);
            this.dom.cueTimeInputs.forEach(input => {
                if (input) input.value = ''; input.placeholder = '-:--';
            });
            this.updateCueMarkers();
        }
    }

    updateConsentUI(hasPrefsConsent) {
        const elementsToToggle = [
            this.dom.bpmInput,
            this.dom.loopInInput,
            this.dom.loopOutInput,
            this.dom.loopInButton,
            this.dom.loopOutButton,
            this.dom.loopToggleButton,
            this.dom.tapTempoButton,
            ...(this.dom.beatLoopButtons || []),
            ...(this.dom.cueSetButtons || []),
            ...(this.dom.cueTimeInputs || [])
        ];

        elementsToToggle.forEach(el => {
            if (el) {
                if (Array.isArray(el)) {
                    el.forEach(subEl => {
                        if (subEl) subEl.setAttribute('aria-disabled', String(!hasPrefsConsent));
                    });
                } else {
                    el.setAttribute('aria-disabled', String(!hasPrefsConsent));
                }
            }
        });


        if (this.dom.settingsSaveNotice) {
            this.dom.settingsSaveNotice.style.display = hasPrefsConsent ? 'none' : 'block';
        }
    }


    checkAutoCrossfade() {
        if (mixer && this.playerReady && this.playbackState === YT.PlayerState.PLAYING &&
            this.trackInfo.duration > 0 && typeof this.player.getCurrentTime === 'function') {
            if (!this.stutterFx.activeFxType) {
                const remainingTime = this.trackInfo.duration - this.player.getCurrentTime();
                mixer.checkAutoCrossfade(this.deckId, remainingTime);
            }
        }
    }


    initEventListeners() {
        this.dom.youtubeUrlInput?.addEventListener('input', () => {
            if (this.dom.loadButton && !this.isLoading) {
                 this.dom.loadButton.disabled = this.dom.youtubeUrlInput.value.trim() === '';
            }
        });
        this.dom.loadButton?.addEventListener('click', () => {
            if (this.isLoading) return;
            const videoId = parseYouTubeUrl(this.dom.youtubeUrlInput.value);
            this.loadVideoById(videoId);
        });

        this.dom.videoToggleButton?.addEventListener('click', () => {
            const playerContainer = this.dom.playerContainer;
            const eyeIcon = this.dom.videoToggleButton?.querySelector('.fa-eye');
            const eyeSlashIcon = this.dom.videoToggleButton?.querySelector('.fa-eye-slash');
            playerContainer?.classList.toggle('hidden-player');
            const isHidden = playerContainer?.classList.contains('hidden-player');
            if(eyeIcon) eyeIcon.style.display = isHidden ? 'inline-block' : 'none';
            if(eyeSlashIcon) eyeSlashIcon.style.display = isHidden ? 'none' : 'inline-block';
            if (this.dom.videoToggleButton) this.dom.videoToggleButton.setAttribute('aria-pressed', String(!isHidden));
        });

        this.dom.playPauseToggleButton?.addEventListener('click', () => {
            if (!this.playerReady || !this.player) return; // Check if player object exists and is ready
            this.stopStutterFx(false);
            const currentState = this.player.getPlayerState();
            if (currentState === YT.PlayerState.PLAYING) {
                if (typeof this.player.pauseVideo === 'function') this.player.pauseVideo();
            } else {
                if (typeof this.player.playVideo === 'function') this.player.playVideo();
            }
        });


        this.dom.seekSlider?.addEventListener('mousedown', (e) => {
            if (!this.playerReady || !this.player || typeof this.player.getCurrentTime !== 'function') return;
            this.isDraggingSlider = true;
            this.playbackTimeBeforeSeek = this.player.getCurrentTime();
        });

        this.dom.seekSlider?.addEventListener('input', (e) => {
            if (!this.playerReady || !this.player) return;
            const seekTime = parseFloat(e.target.value);
            if (this.dom.currentTimeDisplay) {
                this.dom.currentTimeDisplay.textContent = formatTime(seekTime);
            }
        });

        this.dom.seekSlider?.addEventListener('mouseup', (e) => {
            if (!this.playerReady || !this.player || typeof this.player.seekTo !== 'function') {
                this.isDraggingSlider = false;
                return;
            }
            this.isDraggingSlider = false;
            const seekTime = parseFloat(e.target.value);

            this.player.seekTo(seekTime, true);

            if (this.loop.active && (seekTime < this.loop.in || seekTime >= this.loop.out)) {
                this.resetLoop();
            }
            this.trackInfo.currentTime = seekTime;
            if(this.dom.currentTimeDisplay) this.dom.currentTimeDisplay.textContent = formatTime(seekTime);
        });

        this.dom.volumeSlider?.addEventListener('input', () => this.updateVolumeFromSlider());

        for (let i = 0; i < MAX_CUE_POINTS; i++) {
            if (this.dom.cueSetButtons[i]) {
                this.dom.cueSetButtons[i].addEventListener('click', () => this.setCuePoint(i));
            }
            if (this.dom.cueJumpButtons[i]) {
                this.dom.cueJumpButtons[i].addEventListener('click', () => this.jumpToCuePoint(i));
            }
            if (this.dom.cueTimeInputs[i]) {
                const inputField = this.dom.cueTimeInputs[i];
                const cueIndex = i;

                const handleCueTimeChange = () => {
                    if (inputField.getAttribute('aria-disabled') === 'true') return;
                    const parsedTime = parseTimeInput(inputField.value);
                    if (parsedTime !== null) {
                        this.setCuePoint(cueIndex, parsedTime);
                    } else if (inputField.value.trim() === '') {
                        this.cuePoints[cueIndex] = null;
                        inputField.placeholder = '-:--';
                        this.updateCueMarkers();
                        this.saveCurrentTrackSettings();
                        showNotification(`Cue point ${cueIndex + 1} cleared on ${this.deckId}`, 'info');
                    } else {
                        showNotification(`Invalid time format for Cue ${cueIndex + 1}. Use mm:ss or seconds.`, 'warning');
                        const prevCueTime = this.cuePoints[cueIndex];
                        inputField.value = prevCueTime !== null ? formatTime(prevCueTime) : '';
                        if(prevCueTime === null) inputField.placeholder = '-:--';
                    }
                };

                inputField.addEventListener('change', handleCueTimeChange);
                inputField.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        handleCueTimeChange();
                        inputField.blur();
                    }
                });
            }
        }

        this.dom.loopInButton?.addEventListener('click', () => { if(this.dom.loopInButton.getAttribute('aria-disabled') !== 'true') this.setLoopIn()});
        this.dom.loopInInput?.addEventListener('change', (e) => {if(this.dom.loopInInput.getAttribute('aria-disabled') !== 'true') this.setLoopIn(e.target.value)});
        this.dom.loopOutButton?.addEventListener('click', () => {if(this.dom.loopOutButton.getAttribute('aria-disabled') !== 'true') this.setLoopOut()});
        this.dom.loopOutInput?.addEventListener('change', (e) => {if(this.dom.loopOutInput.getAttribute('aria-disabled') !== 'true') this.setLoopOut(e.target.value)});
        this.dom.loopToggleButton?.addEventListener('click', () => {if(this.dom.loopToggleButton.getAttribute('aria-disabled') !== 'true') this.toggleLoop()});
        this.dom.beatLoopButtons.forEach(button => {
            button.addEventListener('click', () => {if(button.getAttribute('aria-disabled') !== 'true') this.setBeatLoop(button.dataset.beats)});
        });

        this.dom.bpmInput?.addEventListener('change', (e) => {if(this.dom.bpmInput.getAttribute('aria-disabled') !== 'true') this.setBPM(e.target.value)});
        this.dom.tapTempoButton?.addEventListener('click', () => {if(this.dom.tapTempoButton.getAttribute('aria-disabled') !== 'true') this.tapTempo()});

        this.dom.playWithDeckButtons.forEach(button => {
            button.addEventListener('click', () => this.playWithDeck(button.dataset.targetDeck));
        });

        this.dom.stutterStepButton?.addEventListener('click', () => this.toggleStutterFx('step'));
        this.dom.stutterLoopButton?.addEventListener('click', () => this.toggleStutterFx('loop'));
        this.dom.stutterRateButton?.addEventListener('click', () => this.cycleStutterRate());
    }
}


// --- Mixer Class ---
class Mixer {
    constructor() {
        this.masterVolumeSlider = document.getElementById('master-volume');
        this.masterVuMeterBar = document.getElementById('vu-meter-master');
        this.crossfaders = {
            'crossfader12': { el: document.getElementById('crossfader12'), deckLeft: 1, deckRight: 2, auto: false, beats: 4, isFading: false },
            'crossfader23': { el: document.getElementById('crossfader23'), deckLeft: 2, deckRight: 3, auto: false, beats: 4, isFading: false },
            'crossfader34': { el: document.getElementById('crossfader34'), deckLeft: 3, deckRight: 4, auto: false, beats: 4, isFading: false },
            'crossfader41': { el: document.getElementById('crossfader41'), deckLeft: 4, deckRight: 1, auto: false, beats: 4, isFading: false },
        };
        this.isFourDeckView = false;

        this.initEventListeners();
        this.updateMasterVUMeter();
    }

    initEventListeners() {
        this.masterVolumeSlider?.addEventListener('input', () => {
            this.updateAllDeckVolumes();
            this.updateMasterVUMeter();
        });

        Object.keys(this.crossfaders).forEach(faderId => {
            const faderConfig = this.crossfaders[faderId];
            if (!faderConfig.el) {
                console.warn(`Crossfader element ${faderId} not found.`);
                return;
            }
            faderConfig.el.addEventListener('input', () => this.updateAllDeckVolumes());

            document.querySelectorAll(`.crossfade-beats-button[data-fader-id="${faderId}"]`).forEach(btn => {
                btn.addEventListener('click', () => {
                    faderConfig.beats = parseInt(btn.dataset.beats);
                    document.querySelectorAll(`.crossfade-beats-button[data-fader-id="${faderId}"]`).forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                     showNotification(`${faderConfig.beats}-Beat crossfade selected for ${faderId}.`, 'info');
                });
            });
            document.querySelector(`.auto-crossfade-toggle[data-fader-id="${faderId}"]`)?.addEventListener('click', (e) => {
                faderConfig.auto = !faderConfig.auto;
                e.currentTarget.classList.toggle('active', faderConfig.auto);
                e.currentTarget.setAttribute('aria-pressed', String(faderConfig.auto));
                showNotification(`Auto-crossfade ${faderConfig.auto ? 'ON' : 'OFF'} for ${faderId}.`, 'info');
            });
            document.querySelector(`.trigger-immediate-crossfade-button[data-fader-id="${faderId}"]`)?.addEventListener('click', () => {
                this.triggerCrossfade(faderId);
            });
        });
    }

    updateMasterVUMeter() {
        if (!this.masterVuMeterBar || !this.masterVolumeSlider) return;
        const masterLevel = parseInt(this.masterVolumeSlider.value, 10);
        this.masterVuMeterBar.style.setProperty('--vu-level', `${masterLevel}%`);
    }

    getCrossfaderValue(faderId) {
        const fader = this.crossfaders[faderId];
        return fader && fader.el ? parseInt(fader.el.value, 10) : 50;
    }

    calculateEffectiveVolume(deckNumber) {
        const deck = deckObjects[deckNumber - 1];
        if (!deck || !this.masterVolumeSlider) return 0;

        const masterVolFactor = parseInt(this.masterVolumeSlider.value, 10) / 100;
        let combinedCrossfaderFactor = 1.0;

        if (deckNumber === 1) {
            combinedCrossfaderFactor *= (100 - this.getCrossfaderValue('crossfader12')) / 100;
            if (this.isFourDeckView) {
                combinedCrossfaderFactor *= this.getCrossfaderValue('crossfader41') / 100;
            }
        }
        else if (deckNumber === 2) {
            combinedCrossfaderFactor *= this.getCrossfaderValue('crossfader12') / 100;
            if (this.isFourDeckView) {
                combinedCrossfaderFactor *= (100 - this.getCrossfaderValue('crossfader23')) / 100;
            }
        }
        else if (deckNumber === 3 && this.isFourDeckView) {
            combinedCrossfaderFactor *= this.getCrossfaderValue('crossfader23') / 100;
            combinedCrossfaderFactor *= (100 - this.getCrossfaderValue('crossfader34')) / 100;
        }
        else if (deckNumber === 4 && this.isFourDeckView) {
            combinedCrossfaderFactor *= this.getCrossfaderValue('crossfader34') / 100;
            combinedCrossfaderFactor *= (100 - this.getCrossfaderValue('crossfader41')) / 100;
        } else if (deckNumber > 2 && !this.isFourDeckView) {
                return 0;
        }

        const finalVolume = deck.intendedVolume * masterVolFactor * combinedCrossfaderFactor;
        return Math.round(Math.max(0, Math.min(100, finalVolume)));
    }

    updateAllDeckVolumes() {
        deckObjects.forEach((deck, index) => {
            if (deck) {
                const deckNumber = index + 1;
                const effectiveVol = this.calculateEffectiveVolume(deckNumber);
                deck.setEffectiveVolume(effectiveVol);
            }
        });
        this.updateMasterVUMeter();
    }

    setDeckViewMode(isFourDeck) {
        const oldViewIsFourDeck = this.isFourDeckView;
        this.isFourDeckView = isFourDeck;

        if (this.isFourDeckView && !oldViewIsFourDeck) {
            if (deckObjects[2]) {
                deckObjects[2].intendedVolume = 0;
                if (deckObjects[2].dom.volumeSlider) deckObjects[2].dom.volumeSlider.value = 0;
            }
            if (deckObjects[3]) {
                deckObjects[3].intendedVolume = 0;
                if (deckObjects[3].dom.volumeSlider) deckObjects[3].dom.volumeSlider.value = 0;
            }

            if (this.crossfaders['crossfader23'] && this.crossfaders['crossfader23'].el) {
                this.crossfaders['crossfader23'].el.value = 0;
            }
            if (this.crossfaders['crossfader34'] && this.crossfaders['crossfader34'].el) {
                this.crossfaders['crossfader34'].el.value = 50;
            }
            if (this.crossfaders['crossfader41'] && this.crossfaders['crossfader41'].el) {
                this.crossfaders['crossfader41'].el.value = 100;
            }
        }

        if (!isFourDeck) {
            ['crossfader23', 'crossfader34', 'crossfader41'].forEach(faderId => {
                if (this.crossfaders[faderId] && this.crossfaders[faderId].el) {
                    this.crossfaders[faderId].el.value = 50;
                }
                if (this.crossfaders[faderId]) {
                    this.crossfaders[faderId].auto = false;
                }
                const autoToggleButton = document.querySelector(`.auto-crossfade-toggle[data-fader-id="${faderId}"]`);
                if (autoToggleButton) {
                    autoToggleButton.classList.remove('active');
                    autoToggleButton.setAttribute('aria-pressed', 'false');
                }
            });
        }
        this.updateAllDeckVolumes();
    }

    triggerCrossfade(faderId, toRight = null) {
        const faderConfig = this.crossfaders[faderId];
        if (!faderConfig || faderConfig.isFading || !faderConfig.el) return;

        const deckLeft = deckObjects[faderConfig.deckLeft - 1];
        const deckRight = deckObjects[faderConfig.deckRight - 1];

        if (!deckLeft || !deckRight || !deckLeft.playerReady || !deckRight.playerReady ||
            !deckLeft.player || typeof deckLeft.player.playVideo !== 'function' ||
            !deckRight.player || typeof deckRight.player.playVideo !== 'function') {
            showNotification("Both decks on crossfader must be loaded and players ready.", "warning");
            return;
        }

        let fadeOutDeck, fadeInDeck, targetFaderValue;
        const currentFaderValue = parseInt(faderConfig.el.value, 10);

        if (toRight === null) {
            if (currentFaderValue > 50) {
                 toRight = false;
            } else if (currentFaderValue < 50) {
                 toRight = true;
            } else {
                toRight = deckLeft.playbackState === YT.PlayerState.PLAYING ? true : (deckRight.playbackState === YT.PlayerState.PLAYING ? false : true);
            }
        }

        if (toRight) {
            fadeOutDeck = deckLeft; fadeInDeck = deckRight; targetFaderValue = 100;
        } else {
            fadeOutDeck = deckRight; fadeInDeck = deckLeft; targetFaderValue = 0;
        }


        if (!fadeOutDeck.bpm) {
            showNotification(`Set BPM on ${fadeOutDeck.deckId} for beat-matched crossfade. Using 2s fade.`, "warning");
        }
        if (!fadeInDeck.currentVideoId) {
            showNotification(`Load a track on ${fadeInDeck.deckId}.`, "warning");
            return;
        }

        const fadeDurationSeconds = fadeOutDeck.bpm ? (faderConfig.beats / fadeOutDeck.bpm) * 60 : 2;
        const steps = 50;
        const stepDuration = (fadeDurationSeconds * 1000) / steps;
        const valueChangePerStep = (targetFaderValue - currentFaderValue) / steps;

        faderConfig.isFading = true;

        if (fadeInDeck.playbackState !== YT.PlayerState.PLAYING) {
            fadeInDeck.player.playVideo();
        }

        let currentStep = 0;
        const fadeInterval = setInterval(() => {
            currentStep++;
            const newFaderValue = currentFaderValue + (valueChangePerStep * currentStep);
            faderConfig.el.value = newFaderValue;
            this.updateAllDeckVolumes();

            if (currentStep >= steps) {
                clearInterval(fadeInterval);
                faderConfig.el.value = targetFaderValue;
                this.updateAllDeckVolumes();
                faderConfig.isFading = false;
                 showNotification(`Crossfade on ${faderId} complete.`, 'success');
            }
        }, stepDuration);
         showNotification(`Crossfading on ${faderId} over ${faderConfig.beats} beats...`, 'info');
    }


    checkAutoCrossfade(endingDeckId, remainingTime) {
        Object.entries(this.crossfaders).forEach(([faderId, faderConfig]) => {
            if (!faderConfig.auto || faderConfig.isFading || !faderConfig.el) return;
            if (!this.isFourDeckView && (faderId === 'crossfader23' || faderId === 'crossfader34' || faderId === 'crossfader41')) return;

            const deckLeftNum = faderConfig.deckLeft;
            const deckRightNum = faderConfig.deckRight;
            const endingDeckNum = parseInt(endingDeckId.replace('deck', ''));
            const faderValue = parseInt(faderConfig.el.value);
            let isDominant = false;
            let fadeToRight = false;

            if (endingDeckNum === deckLeftNum && faderValue < 50) {
                isDominant = true; fadeToRight = true;
            } else if (endingDeckNum === deckRightNum && faderValue > 50) {
                isDominant = true; fadeToRight = false;
            }

            if (isDominant && remainingTime <= AUTO_CROSSFADE_END_SECONDS) {
                const targetDeck = fadeToRight ? deckObjects[deckRightNum - 1] : deckObjects[deckLeftNum - 1];
                if (targetDeck && targetDeck.currentVideoId && targetDeck.playerReady) {
                    showNotification(`Auto-crossfading from ${endingDeckId} on ${faderId}...`, 'info');
                    this.triggerCrossfade(faderId, fadeToRight);
                    faderConfig.auto = false;
                    const autoToggleButton = document.querySelector(`.auto-crossfade-toggle[data-fader-id="${faderId}"]`);
                    if(autoToggleButton) {
                        autoToggleButton.classList.remove('active');
                        autoToggleButton.setAttribute('aria-pressed', 'false');
                    }
                } else {
                     console.log(`Auto-crossfade for ${faderId} skipped: Target deck ${targetDeck?.deckId || 'N/A'} not ready.`);
                }
            }
        });
    }
}

// --- Playlist Manager ---
class PlaylistManager {
    constructor(storageMgr, uiMgrInstance) {
        this.storageManager = storageMgr;
        this.uiManagerInstance = uiMgrInstance;
        this.playlists = this.storageManager.loadPlaylists() || {};

        this.playlistNameInput = document.getElementById('playlist-name');
        this.savePlaylistButton = document.getElementById('save-playlist-button');
        this.playlistListUl = document.getElementById('playlist-list');

        this.initEventListeners();
        this.renderPlaylistList();
    }

    initEventListeners() {
        this.savePlaylistButton?.addEventListener('click', () => this.saveCurrentPlaylist());
        this.playlistListUl?.addEventListener('click', (event) => {
            const target = event.target.closest('button');
            if (!target) return;

            if (target.classList.contains('load-playlist-button')) {
                this.loadPlaylist(target.dataset.playlistName);
            } else if (target.classList.contains('delete-playlist-button')) {
                if (confirm(`Are you sure you want to delete playlist "${target.dataset.playlistName}"?`)) {
                    this.deletePlaylist(target.dataset.playlistName);
                }
            }
        });
    }

    saveCurrentPlaylist() {
        if (!this.storageManager.consentManager.hasConsent(PREFERENCES_CONSENT_ID)) {
            showNotification('Cannot save playlist. Preferences consent not given.', 'warning');
            return;
        }
        const name = this.playlistNameInput.value.trim();
        if (!name) {
            showNotification('Please enter a playlist name.', 'warning');
            return;
        }

        const playlistDataToSave = []; // This will be an array of video IDs
        const activeDeckCount = this.uiManagerInstance.isFourDeckView ? MAX_DECKS : 2;

        for (let i = 0; i < activeDeckCount; i++) {
            const deck = deckObjects[i];
            playlistDataToSave.push(deck && deck.currentVideoId ? deck.currentVideoId : null);
        }

        this.playlists[name] = playlistDataToSave; // Saving as a direct array
        if (this.storageManager.savePlaylists(this.playlists)) {
            showNotification(`Playlist "${name}" saved.`, 'success');
            this.renderPlaylistList();
            this.playlistNameInput.value = '';
        } else {
            showNotification('Failed to save playlist due to consent or storage issue.', 'error');
        }
    }

    // MODIFIED: To handle potential object structure {videoIds: []} from old localStorage data
    loadPlaylist(name) {
        let playlistData = this.playlists[name];

        if (!playlistData) {
            showNotification(`Playlist "${name}" not found.`, 'error');
            return;
        }

        // Check if playlistData is an object with a videoIds property (old format)
        if (typeof playlistData === 'object' && playlistData !== null && Array.isArray(playlistData.videoIds)) {
            console.log(`Playlist "${name}" found with old object structure. Using videoIds array.`);
            playlistData = playlistData.videoIds; // Use the inner array
        } else if (!Array.isArray(playlistData)) {
            // If it's neither the old object format nor the new array format, it's corrupted
            showNotification(`Playlist data for "${name}" is corrupted or in an unknown format. Cannot load.`, 'error');
            console.error(`Corrupted or unknown playlist data format for "${name}":`, this.playlists[name]);
            return;
        }

        // At this point, playlistData should be an array of video IDs
        const activeDeckCount = this.uiManagerInstance.isFourDeckView ? MAX_DECKS : 2;

        playlistData.forEach((videoId, index) => {
            if (index < activeDeckCount) {
                const deck = deckObjects[index];
                if (deck) {
                    if (videoId) {
                        deck.loadVideoById(videoId);
                    } else {
                        // If videoId is null or empty, clear the deck
                        if (deck.player && deck.playerReady && typeof deck.player.stopVideo === 'function') {
                            try { deck.player.stopVideo(); } catch(e) { console.warn(`Error stopping video on ${deck.deckId}`, e); }
                        }
                        deck.resetDeckState(true);
                    }
                }
            }
        });
        showNotification(`Playlist "${name}" loaded.`, 'success');
    }

    deletePlaylist(name) {
         if (!this.storageManager.consentManager.hasConsent(PREFERENCES_CONSENT_ID)) {
            showNotification('Cannot delete playlist. Preferences consent not given.', 'warning');
            return;
        }
        if (this.playlists[name]) {
            delete this.playlists[name];
            if(this.storageManager.savePlaylists(this.playlists)) {
                showNotification(`Playlist "${name}" deleted.`, 'success');
                this.renderPlaylistList();
            } else {
                 showNotification('Failed to delete playlist due to consent or storage issue.', 'error');
            }
        }
    }

    renderPlaylistList() {
        if (!this.playlistListUl) return;
        this.playlistListUl.innerHTML = '';
        const names = Object.keys(this.playlists);
        if (names.length === 0) {
            this.playlistListUl.innerHTML = '<li>No playlists saved yet.</li>';
            return;
        }
        names.forEach(name => {
            const li = document.createElement('li');
            const nameSpan = document.createElement('span');
            nameSpan.textContent = name;

            let currentPlaylistTracks = this.playlists[name];
            // Adapt to check for the old structure {videoIds: []} for display purposes as well
            if (typeof currentPlaylistTracks === 'object' && currentPlaylistTracks !== null && Array.isArray(currentPlaylistTracks.videoIds)) {
                currentPlaylistTracks = currentPlaylistTracks.videoIds;
            }

            if (Array.isArray(currentPlaylistTracks)) {
                const trackSnippets = currentPlaylistTracks
                    .filter(id => typeof id === 'string' && id)
                    .map(id => id.substring(0, 5) + '...')
                    .join(', ');
                nameSpan.title = `Tracks: ${trackSnippets || 'Empty'}`;
            } else {
                console.warn(`Playlist data for "${name}" is not an array during render:`, this.playlists[name]);
                nameSpan.title = `Tracks: Invalid or empty playlist data`;
            }

            const buttonsDiv = document.createElement('div');
            const loadButton = document.createElement('button');
            loadButton.innerHTML = '<i class="fas fa-upload"></i> Load';
            loadButton.className = 'load-playlist-button small-button';
            loadButton.dataset.playlistName = name;
            loadButton.title = `Load playlist: ${name}`;

            const deleteButton = document.createElement('button');
            deleteButton.innerHTML = '<i class="fas fa-trash"></i> Delete';
            deleteButton.className = 'delete-playlist-button small-button';
            deleteButton.dataset.playlistName = name;
            deleteButton.title = `Delete playlist: ${name}`;


            buttonsDiv.appendChild(loadButton);
            buttonsDiv.appendChild(deleteButton);
            li.appendChild(nameSpan);
            li.appendChild(buttonsDiv);
            this.playlistListUl.appendChild(li);
        });
    }

    refreshPlaylistsAfterConsentChange() {
        this.playlists = this.storageManager.loadPlaylists() || {};
        this.renderPlaylistList();
    }
}

// --- UI Manager ---
class UIManager {
    constructor() {
        this.toggleDeckViewButton = document.getElementById('toggle-deck-view-button');
        this.toggleDeckViewButtonSpan = this.toggleDeckViewButton?.querySelector('span');
        this.decksContainer = document.querySelector('.decks-container');
        this.crossfadersGrid = document.querySelector('.crossfaders-grid');

        this.deckElements = [document.getElementById('deck1'), document.getElementById('deck2'), document.getElementById('deck3'), document.getElementById('deck4')];
        this.crossfaderSections = {
            cf23: document.getElementById('cf-section-23'),
            cf34: document.getElementById('cf-section-34'),
            cf41: document.getElementById('cf-section-41'),
        };
        this.isFourDeckView = false;

        this.initEventListeners();
        this.updateDeckViewUI();
    }

    initEventListeners() {
        this.toggleDeckViewButton?.addEventListener('click', () => this.toggleDeckView());
    }

    toggleDeckView() {
        this.isFourDeckView = !this.isFourDeckView;
        this.updateDeckViewUI();

        if (mixer) {
            mixer.setDeckViewMode(this.isFourDeckView);
        }
        showNotification(`${this.isFourDeckView ? '4-Deck' : '2-Deck'} view activated.`, 'info');
    }

    updateDeckViewUI() {
        if (this.toggleDeckViewButtonSpan) {
            this.toggleDeckViewButtonSpan.textContent = this.isFourDeckView ? 'Show 2 Decks' : 'Show 4 Decks';
            this.toggleDeckViewButton.title = this.isFourDeckView ? 'Switch to 2 deck view' : 'Switch to 4 deck view';
        }
        this.decksContainer?.classList.toggle('four-deck-view', this.isFourDeckView);
        this.crossfadersGrid?.classList.toggle('four-deck-view', this.isFourDeckView);

        this.deckElements[2]?.classList.toggle('hidden-by-default', !this.isFourDeckView);
        this.deckElements[3]?.classList.toggle('hidden-by-default', !this.isFourDeckView);

        // MODIFIED: Player initialization for newly visible decks
        if (this.isFourDeckView && ytApiReady) {
            for (let i = 2; i < MAX_DECKS; i++) { // Iterate for decks 3 and 4
                const deck = deckObjects[i];
                if (deck && !deck.player && !deck.playerApiReadyAndPlayerInitialized) {
                    // If API is ready, and player doesn't exist, and we haven't tried to init it yet
                    console.log(`Deck ${deck.deckId} is now visible and API is ready. Initializing player.`);
                    deck.initPlayer(); // This will create the YT.Player
                } else if (deck && deck.playerApiReadyAndPlayerInitialized && !deck.playerReady && deck.queuedVideoId){
                    // If YT.Player() was called, but onReady event hasn't fired,
                    // and there's a queued video, onPlayerReady for this deck will handle it.
                     console.log(`Deck ${deck.deckId} player construction called, onReady will handle queued video.`);
                } else if (deck && deck.playerReady && deck.queuedVideoId) {
                    // If player is fully ready and has a queued video (e.g. from a previous state)
                    console.log(`Deck ${deck.deckId} is visible, player ready. Processing queued video.`);
                    const videoToLoad = deck.queuedVideoId;
                    deck.queuedVideoId = null;
                    deck.loadVideoById(videoToLoad);
                }
            }
        }

        this.crossfaderSections.cf23?.classList.toggle('hidden-by-default', !this.isFourDeckView);
        this.crossfaderSections.cf34?.classList.toggle('hidden-by-default', !this.isFourDeckView);
        this.crossfaderSections.cf41?.classList.toggle('hidden-by-default', !this.isFourDeckView);
    }
}


// --- YouTube Iframe API Ready Callback ---
// MODIFIED: Centralized player initialization logic
function onYouTubeIframeAPIReady() {
    console.log("YouTube Iframe API Ready (onYouTubeIframeAPIReady called).");
    ytApiReady = true;

    // Process any decks that were queued for initialization
    // or are default visible (Deck 1 and 2)
    deckInitializationQueue.forEach(deck => {
        if (deck && !deck.player && !deck.playerApiReadyAndPlayerInitialized) {
            console.log(`API is ready. Initializing player for queued/default deck: ${deck.deckId}`);
            deck.initPlayer();
        }
    });
    deckInitializationQueue = []; // Clear the queue

    // Ensure initially visible decks (1 & 2) are initialized if not already
    for (let i = 0; i < 2; i++) { // Decks 1 and 2
        const deck = deckObjects[i];
        if (deck && !deck.player && !deck.playerApiReadyAndPlayerInitialized) {
            console.log(`API is ready. Initializing player for default visible deck: ${deck.deckId}`);
            deck.initPlayer();
        }
    }

    // If UI manager shows 4 decks are already visible (e.g. due to prior state or rapid toggle)
    // and API becomes ready, ensure decks 3 & 4 are also initialized.
    if (uiManager && uiManager.isFourDeckView) {
        for (let i = 2; i < MAX_DECKS; i++) { // Decks 3 and 4
            const deck = deckObjects[i];
            if (deck && !deck.player && !deck.playerApiReadyAndPlayerInitialized) {
                console.log(`API is ready. Four deck view active. Initializing player for deck: ${deck.deckId}`);
                deck.initPlayer();
            }
        }
    }
}


// --- Application Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Content Loaded. Initializing DJ App.");

    consentManager = new ConsentManager();
    storageManager = new StorageManager(consentManager);
    mixer = new Mixer();
    uiManager = new UIManager(); // Must be initialized before decks if it affects visibility

    deckObjects = [];
    for (let i = 1; i <= MAX_DECKS; i++) {
        const deckId = `deck${i}`;
        const deck = new Deck(deckId, (readyDeck) => { // This is the onPlayerReadyCallback
            if (mixer) mixer.updateAllDeckVolumes();
             console.log(`Deck.onPlayerReadyCallback executed for ${readyDeck.deckId}. Mixer volumes updated.`);
        });
        deckObjects.push(deck);

        // MODIFIED: Queue initial decks for initialization by onYouTubeIframeAPIReady
        // Only decks 1 and 2 are initially visible by default HTML/CSS.
        // Decks 3 and 4 players will be initialized if/when they become visible
        // and ytApiReady is true.
        if (i <= 2) { // Queue decks 1 and 2
            if (!ytApiReady) { // If API not ready yet, add to queue
                console.log(`DOM ready: Queuing initial deck ${deckId} for player initialization once API is ready.`);
                if (!deckInitializationQueue.find(d => d.deckId === deck.deckId)) {
                    deckInitializationQueue.push(deck);
                }
            } else { // If API is somehow already ready (e.g. script loaded late)
                console.log(`DOM ready: YT API already ready. Initializing player for ${deckId} directly.`);
                if (!deck.player && !deck.playerApiReadyAndPlayerInitialized) {
                    deck.initPlayer();
                }
            }
        }
    }

    playlistManager = new PlaylistManager(storageManager, uiManager);

    consentManager.applyConsentToUI();
    playlistManager.refreshPlaylistsAfterConsentChange();

    if (mixer && uiManager) {
        mixer.updateAllDeckVolumes();
    }

    // If onYouTubeIframeAPIReady was already called before DOMContentLoaded,
    // we need to manually trigger the logic that it would have performed.
    // This is unlikely with standard script loading but good for robustness.
    if (ytApiReady) {
        console.log("DOM Content Loaded, and YT API was already ready. Re-evaluating player initializations.");
        onYouTubeIframeAPIReady(); // Call it again to process any decks that might need init.
    }
});