import EventEmitter from 'events';
import Log from '../utils/logger.js';
import Transmuxer from '../core/transmuxer.js';
import MSEController from '../core/mse-controller.js';
import Browser from '../utils/browser.js';
import {createDefaultConfig} from '../config.js';
import {InvalidArgumentException, IllegalStateException} from '../utils/exception.js';

class FlvPlayer {

    constructor(mediaDataSource, config) {
        this.TAG = this.constructor.name;
        this._type = 'FlvPlayer';
        this._emitter = new EventEmitter();

        this._config = createDefaultConfig();
        if (typeof config === 'object') {
            Object.assign(this._config, config);
        }

        if (mediaDataSource.type.toLowerCase() !== 'flv') {
            throw new InvalidArgumentException('FlvPlayer requires an flv MediaDataSource input!');
        }

        if (mediaDataSource.isLive === true) {
            this._config.isLive = true;
        }

        this.e = {
            onvSeeking: this._onvSeeking.bind(this),
            onvTimeUpdate: this._onvTimeUpdate.bind(this)
        };

        this._pendingSeekTime = null;  // in seconds
        this._requestSetTime = false;
        this._seekpointRecord = null;
        this._progressCheckId = 0;

        this._mediaDataSource = mediaDataSource;
        this._mediaElement = null;
        this._msectl = null;
        this._transmuxer = null;

        this._mediaInfo = null;
        this._statisticsInfo = null;

        let chromeNeedIDRFix = (Browser.chrome &&
                               (Browser.version.major < 50 ||
                               (Browser.version.major === 50 && Browser.version.build < 2661)));
        this._alwaysSeekKeyframe = (chromeNeedIDRFix || Browser.msedge || Browser.msie) ? true : false;
    }

    destroy() {
        if (this._progressCheckId !== 0) {
            window.clearInterval(this._progressCheckId);
            this._progressCheckId = 0;
        }
        if (this._transmuxer) {
            this.unload();
        }
        if (this._mediaElement) {
            this.detachMediaElement();
        }
        this.e = null;
        this._mediaDataSource = null;

        this._emitter.removeAllListeners();
        this._emitter = null;
    }

    on(event, listener) {
        if (event === 'media_info') {
            if (this._mediaInfo != null) {
                Promise.resolve().then(() => {
                    this._emitter.emit('media_info', this.mediaInfo);
                });
            }
        } else if (event === 'statistics_info') {
            if (this._statisticsInfo != null) {
                Promise.resolve().then(() => {
                    this._emitter.emit('statistics_info', this.statisticsInfo);
                });
            }
        }
        this._emitter.addListener(event, listener);
    }

    off(event, listener) {
        this._emitter.removeListener(event, listener);
    }

    attachMediaElement(mediaElement) {
        this._mediaElement = mediaElement;
        mediaElement.addEventListener('seeking', this.e.onvSeeking);
        if (this._config.lazyLoad) {
            mediaElement.addEventListener('timeupdate', this.e.onvTimeUpdate);
        }

        this._msectl = new MSEController();
        this._msectl.attachMediaElement(mediaElement);
        this._msectl.on('buffer_full', this._onmseBufferFull.bind(this));

        if (this._pendingSeekTime != null) {
            mediaElement.currentTime = this._pendingSeekTime;
            this._pendingSeekTime = null;
        }
    }

    detachMediaElement() {
        if (this._mediaElement) {
            this._msectl.detachMediaElement();
            this._mediaElement.removeEventListener('seeking', this.e.onvSeeking);
            if (this._config.lazyLoad) {
                this._mediaElement.removeEventListener('timeupdate', this.e.onvTimeUpdate);
            }
            this._mediaElement = null;
        }
        if (this._msectl) {
            this._msectl.destroy();
            this._msectl = null;
        }
    }

    load() {
        if (!this._mediaElement) {
            throw new IllegalStateException('HTMLMediaElement must be attached before load()!');
        }

        this._transmuxer = new Transmuxer(this._mediaDataSource, this._config);
        this._transmuxer.on('init_segment', (type, is) => {
            this._msectl.appendInitSegment(is);
        });
        this._transmuxer.on('media_segment', (type, ms) => {
            this._msectl.appendMediaSegment(ms);
        });
        this._transmuxer.on('media_info', (mediaInfo) => {
            this._mediaInfo = mediaInfo;
            this._emitter.emit('media_info', mediaInfo);
        });
        this._transmuxer.on('statistics_info', (statInfo) => {
            this._statisticsInfo = this._fillStatisticsInfo(statInfo);
            this._emitter.emit('statistics_info', statInfo);
        });
        this._transmuxer.on('recommend_seekpoint', (milliseconds) => {
            if (this._mediaElement) {
                this._requestSetTime = true;
                this._mediaElement.currentTime = milliseconds / 1000;
            }
        });

        this._transmuxer.open();
    }

    unload() {
        if (this._mediaElement) {
            this._mediaElement.pause();
            this._requestSetTime = true;
            this._mediaElement.currentTime = 0;
        }
        if (this._transmuxer) {
            this._transmuxer.close();
            this._transmuxer.destroy();
            this._transmuxer = null;
        }
    }

    play() {
        this._mediaElement.play();
    }

    pause() {
        this._mediaElement.pause();
    }

    get type() {
        return this._type;
    }

    get buffered() {
        return this._mediaElement.buffered;
    }

    get duration() {
        return this._mediaElement.duration;
    }

    get volume() {
        return this._mediaElement.volume;
    }

    set volume(value) {
        this._mediaElement.volume = value;
    }

    get muted() {
        return this._mediaElement.muted;
    }

    set muted(muted) {
        this._mediaElement.muted = muted;
    }

    get currentTime() {
        if (this._mediaElement) {
            return this._mediaElement.currentTime;
        }
        return 0;
    }

    set currentTime(seconds) {
        if (this._mediaElement) {
            this._internalSeek(seconds);
        } else {
            this._pendingSeekTime = seconds;
        }
    }

    get mediaInfo() {
        return Object.assign({}, this._mediaInfo);
    }

    get statisticsInfo() {
        if (this._statisticsInfo == null) {
            this._statisticsInfo = {};
        }
        this._statisticsInfo = this._fillStatisticsInfo(this._statisticsInfo);
        return Object.assign({}, this._statisticsInfo);
    }

    _fillStatisticsInfo(statInfo) {
        statInfo.playerType = this._type;

        let hasQualityInfo = true;
        let decoded = 0;
        let dropped = 0;

        if (this._mediaElement.getVideoPlaybackQuality) {
            let quality = this._mediaElement.getVideoPlaybackQuality();
            decoded = quality.totalVideoFrames;
            dropped = quality.droppedVideoFrames;
        } else if (this._mediaElement.webkitDecodedFrameCount != undefined) {
            decoded = this._mediaElement.webkitDecodedFrameCount;
            dropped = this._mediaElement.webkitDroppedFrameCount;
        } else {
            hasQualityInfo = false;
        }

        if (hasQualityInfo) {
            statInfo.decodedFrames = decoded;
            statInfo.droppedFrames = dropped;
        }

        return statInfo;
    }

    _onmseBufferFull() {
        Log.v(this.TAG, 'MSE SourceBuffer is full, suspend transmuxing task');
        if (this._progressCheckId === 0) {
            this._suspendTransmuxer();
        }
    }

    _suspendTransmuxer() {
        if (this._transmuxer) {
            this._transmuxer.pause();

            if (this._progressCheckId === 0) {
                this._progressCheckId = window.setInterval(this._checkProgressAndResume.bind(this), 2000);
            }
        }
    }

    _checkProgressAndResume() {
        let currentTime = this._mediaElement.currentTime;
        let buffered = this._mediaElement.buffered;

        let to = 0;
        let needResume = false;
        let inBufferedRange = false;

        for (let i = 0; i < buffered.length; i++) {
            let from = buffered.start(i);
            to = buffered.end(i);
            if (currentTime >= from && currentTime < to) {
                inBufferedRange = true;
                if (currentTime >= to - 30) {
                    needResume = true;
                }
                break;
            }
        }

        if (needResume || !inBufferedRange) {
            window.clearInterval(this._progressCheckId);
            this._progressCheckId = 0;
            if (needResume) {
                Log.v(this.TAG, 'Continue loading from paused position');
                this._transmuxer.resume();
            }
        }
    }

    _isTimepointBuffered(seconds) {
        let buffered = this._mediaElement.buffered;

        for (let i = 0; i < buffered.length; i++) {
            let from = buffered.start(i);
            let to = buffered.end(i);
            if (seconds >= from && seconds < to) {
                return true;
            }
        }
        return false;
    }

    _internalSeek(seconds) {
        let directSeek = this._isTimepointBuffered(seconds);

        if (directSeek) {  // buffered position
            if (!this._alwaysSeekKeyframe) {
                this._mediaElement.currentTime = seconds;
            } else {
                let idr = this._msectl.getNearestKeyframe(Math.floor(seconds * 1000));
                this._requestSetTime = true;
                this._mediaElement.currentTime = idr.dts / 1000;
            }
        } else {
            if (this._progressCheckId !== 0) {
                window.clearInterval(this._progressCheckId);
                this._progressCheckId = 0;
            }
            this._msectl.seek(seconds);
            this._transmuxer.seek(Math.floor(seconds * 1000));  // in milliseconds
            // no need to set mediaElement.currentTime,
            // just wait for the recommend_seekpoint callback
        }
    }

    _checkAndApplyUnbufferedSeekpoint() {
        if (this._seekpointRecord) {
            if (this._seekpointRecord.recordTime <= self.performance.now() - 200) {
                let target = this._mediaElement.currentTime;
                this._seekpointRecord = null;
                if (!this._isTimepointBuffered(target)) {
                    if (this._progressCheckId !== 0) {
                        window.clearTimeout(this._progressCheckId);
                        this._progressCheckId = 0;
                    }
                    // .currentTime is consists with .buffered timestamp
                    // Chrome/Edge use DTS, while FireFox/Safari use PTS
                    this._msectl.seek(target);
                    this._transmuxer.seek(Math.floor(target * 1000));
                }
            } else {
                window.setTimeout(this._checkAndApplyUnbufferedSeekpoint.bind(this), 50);
            }
        }
    }

    _onvSeeking(e) {  // handle seeking request from browser's progress bar
        let target = this._mediaElement.currentTime;
        if (this._requestSetTime) {
            this._requestSetTime = false;
            return;
        }
        if (this._isTimepointBuffered(target)) {
            if (this._alwaysSeekKeyframe) {
                let idr = this._msectl.getNearestKeyframe(Math.floor(target * 1000));
                this._requestSetTime = true;
                this._mediaElement.currentTime = idr.dts / 1000;
            }
            return;
        }

        this._seekpointRecord = {
            seekPoint: target,
            recordTime: self.performance.now()
        };
        window.setTimeout(this._checkAndApplyUnbufferedSeekpoint.bind(this), 50);
    }

    _onvTimeUpdate(e) {
        if (!this._config.lazyLoad) {
            return;
        }

        let buffered = this._mediaElement.buffered;
        let currentTime = this._mediaElement.currentTime;
        let currentRangeStart = 0;
        let currentRangeEnd = 0;

        for (let i = 0; i < buffered.length; i++) {
            let start = buffered.start(i);
            let end = buffered.end(i);
            if (start <= currentTime && currentTime < end) {
                currentRangeStart = start;
                currentRangeEnd = end;
                break;
            }
        }

        if (currentRangeEnd >= currentTime + this._config.lazyLoadMaxDuration && this._progressCheckId === 0) {
            Log.v(this.TAG, 'Maximum buffering duration exceeded, suspend transmuxing task');
            this._suspendTransmuxer();
        }
    }

}

export default FlvPlayer;