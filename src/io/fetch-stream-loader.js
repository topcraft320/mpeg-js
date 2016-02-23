import {BaseLoader, LoaderStatus, LoaderError} from './loader.js';

class FetchStreamLoader extends BaseLoader {

    static isSupported() {
        try {
            return (self.fetch && self.ReadableByteStream);
        } catch (e) {
            return false;
        }
    }

    constructor() {
        super('fetch-stream');
        this._requestAbort = false;
        this._contentLength = null;
        this._receivedLength = 0;
    }

    destroy() {
        if (this.isWorking()) {
            this.abort();
        }
        super.destroy();
    }

    open(url, range) {
        this._url = url;
        this._range = range;

        let headers = new self.Headers();

        if (range.from !== 0 || range.to !== -1) {
            let param;
            if (range.to !== -1) {
                param = 'bytes=' + range.from.toString() + '-' + range.to.toString();
            } else {
                param = 'bytes=' + range.from.toString() + '-';
            }
            headers.append('Range', param);
        }

        let params = {
            method: 'GET',
            headers: headers,
            mode: 'cors',
            cache: 'default'
        };

        this._status = LoaderStatus.kConnecting;
        self.fetch(this._url, params).then(function (res) {
            if (this._requestAbort) {
                this._requestAbort = false;
                this._status = LoaderStatus.kIdle;
                return;
            }
            if (res.ok && (res.status === 200 || res.status === 206)) {
                this._contentLength = parseInt(res.headers.get('Content-Length'));
                if (this._contentLength !== null) {
                    if (this._onContentLengthKnown) {
                        this._onContentLengthKnown(this._contentLength);
                    }
                }
                return this._pump.call(this, res.body.getReader());
            } else {
                this._status = LoaderStatus.kError;
                if (this._onError) {
                    this._onError(LoaderError.kHttpStatusCodeInvalid, {code: res.status, msg: res.statusText});
                } else {
                    throw 'FetchStreamLoader: Http code invalid, ' + res.status + ' ' + res.statusText;
                }
            }
        }.bind(this)).catch(function (e) {
            this._status = LoaderStatus.kError;
            if (this._onError) {
                this._onError(LoaderError.kException, {code: -1, msg: e.message});
            } else {
                throw e;
            }
        }.bind(this));
    }

    abort() {
        this._requestAbort = true;
    }

    _pump(reader) {  // ReadableStreamReader
        return reader.read().then(function (result) {
            if (result.done) {
                this._status = LoaderStatus.kComplete;
                if (this._onComplete) {
                    this._onComplete(this._range.from, this._range.from + this._receivedLength - 1);
                }
            } else {
                if (this._requestAbort === true) {
                    this._requestAbort = false;
                    this._status = LoaderStatus.kComplete;
                    return reader.cancel();
                }

                this._status = LoaderStatus.kBuffering;

                let chunk = result.value;
                let byteStart = this._range.from + this._receivedLength;
                this._receivedLength += chunk.byteLength;
                console.log('fetch: received chunk, size = ' + chunk.byteLength + ', total_received = ' + this._receivedLength);

                if (this._onDataArrival) {
                    this._onDataArrival(chunk, byteStart, this._receivedLength);
                }

                return this._pump(reader);
            }
        }.bind(this)).catch(function (e) {
            this._status = LoaderStatus.kError;
            let type = 0;
            let info = null;

            if (this._contentLength !== null && this._receivedLength < this._contentLength) {
                type = LoaderError.kEarlyEof;
                info = {code: e.code, msg: 'fetch stream meet Early-EOF'};
            } else {
                type = LoaderError.kException;
                info = {code: e.code, msg: e.message};
            }

            if (this._onError) {
                this._onError(type, info);
            }
        }.bind(this));
    }

}

export default FetchStreamLoader;