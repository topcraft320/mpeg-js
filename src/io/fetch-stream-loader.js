import {assert} from 'assert';
import {BaseLoader, LoaderStatus, LoaderError} from './loader.js';

let context = global || window;

class FetchStreamLoader extends BaseLoader {

    static isSupported() {
        return (context.fetch && context.ReadableByteStream);
    }

    constructor() {
        super('fetch-stream');
        this._requestAbort = false;
        this._receivedLength = 0;
    }

    destroy() {
        super.destroy();
    }

    open(url, range) {
        this._url = url;
        this._range = range;

        let headers = new context.Headers();

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
        context.fetch(this._url, params).then(function (res) {
            if (this._requestAbort) {
                this._requestAbort = false;
                this._status = LoaderStatus.kIdle;
                return;
            }
            if (res.ok && (res.status === 200 || res.status === 206)) {
                console.log('Content-Length: ' + res.headers.get('Content-Length'));
                return this._pump.bind(this, res.body.getReader()).call();
            } else {
                this._status = LoaderStatus.kError;
                if (this._onError) {
                    this._onError(LoaderError.kHttpStatusCodeInvalid, {code: res.status, msg: res.statusText});
                } else {
                    throw 'Http code invalid, ' + res.statusText;
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
                // TODO: check Content-Length, if mismatch, set status to kEarlyEof
                console.log('fetch: done');
                this._status = LoaderStatus.kComplete;
                if (this._onComplete) {
                    this._onComplete(this._range.from, this._range.from + this._receivedLength);
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
        }.bind(this));
    }

}

export default FetchStreamLoader;