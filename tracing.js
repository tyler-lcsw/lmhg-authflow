const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_LOG_DIR = path.join(__dirname, 'logs');
const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, 'auth-forms-trace.log');

function redactHeaders(headers = {}) {
    const redacted = {};
    for (const [key, value] of Object.entries(headers)) {
        if (/authorization|cookie|token|key|password|pwd|secret/i.test(key)) {
            redacted[key] = '[REDACTED]';
        } else {
            redacted[key] = value;
        }
    }
    return redacted;
}

function createFileSink(logFile = process.env.AUTH_FORMS_TRACE_LOG || DEFAULT_LOG_FILE) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    return entry => {
        fs.appendFile(logFile, `${JSON.stringify(entry)}\n`, err => {
            if (err) console.error('[trace] failed to write log entry:', err.message);
        });
    };
}

function baseEntry(event, fields = {}) {
    return {
        ts: new Date().toISOString(),
        event,
        ...fields
    };
}

function createRequestTracer({ sink = createFileSink() } = {}) {
    return (req, res, next) => {
        const started = process.hrtime.bigint();
        const traceId = req.get('x-trace-id') || crypto.randomUUID();

        req.traceId = traceId;
        res.setHeader('x-trace-id', traceId);

        res.on('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
            sink(baseEntry('request.complete', {
                trace_id: traceId,
                method: req.method,
                path: req.originalUrl || req.url,
                status: res.statusCode,
                duration_ms: Math.round(durationMs * 100) / 100,
                ip: req.ip,
                user_agent: req.get('user-agent') || null
            }));
        });

        next();
    };
}

function createErrorLogger({ sink = createFileSink() } = {}) {
    return (err, req, res, next) => {
        const traceId = req.traceId || crypto.randomUUID();
        sink(baseEntry('request.error', {
            trace_id: traceId,
            method: req.method,
            path: req.originalUrl || req.url,
            status: err.status || err.statusCode || 500,
            message: err.message,
            stack: err.stack,
            headers: redactHeaders(req.headers)
        }));

        if (res.headersSent) return next(err);
        res.status(err.status || err.statusCode || 500).json({
            error: err.message || 'Internal Server Error',
            traceId
        });
    };
}

function installProcessErrorLogging({ sink = createFileSink() } = {}) {
    process.on('uncaughtException', err => {
        sink(baseEntry('process.uncaughtException', {
            message: err.message,
            stack: err.stack
        }));
        console.error('[process] uncaught exception:', err);
    });

    process.on('unhandledRejection', reason => {
        sink(baseEntry('process.unhandledRejection', {
            message: reason && reason.message ? reason.message : String(reason),
            stack: reason && reason.stack ? reason.stack : undefined
        }));
        console.error('[process] unhandled rejection:', reason);
    });
}

module.exports = {
    createErrorLogger,
    createFileSink,
    createRequestTracer,
    installProcessErrorLogging,
    DEFAULT_LOG_FILE
};
