// ARKAA STUDIO | SAWERIA -> ROBLOX BRIDGE
// Node.js 20+
// Required environment variables:
//   SAWERIA_STREAM_KEY = stream key used by Saweria webhook signature
//   BRIDGE_SECRET      = separate random secret shared with Roblox server
// Optional:
//   PORT               = hosting port (Render supplies this)
//   DB_PATH            = SQLite file path (Render persistent disk example: /var/data/saweria.sqlite)

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 3000);
const SAWERIA_STREAM_KEY = process.env.SAWERIA_STREAM_KEY;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
const DB_PATH = process.env.DB_PATH || "./data/saweria.sqlite";
const MAX_BODY_BYTES = "32kb";
const MAX_BATCH_SIZE = 20;

if (!SAWERIA_STREAM_KEY || SAWERIA_STREAM_KEY.length < 8) {
    throw new Error("Missing/invalid SAWERIA_STREAM_KEY environment variable.");
}
if (!BRIDGE_SECRET || Buffer.byteLength(BRIDGE_SECRET, "utf8") < 32) {
    throw new Error("BRIDGE_SECRET is required and must be at least 32 UTF-8 bytes.");
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT is invalid.");
}

// Ensure the database directory exists. On Render, set DB_PATH to /var/data/saweria.sqlite
// and attach a persistent disk mounted at /var/data.
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(`
    CREATE TABLE IF NOT EXISTS donations (
        id TEXT PRIMARY KEY,
        donor TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount > 0),
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_donations_pending
        ON donations (acknowledged, received_at);
`);

const app = express();
app.disable("x-powered-by");
app.disable("etag");

// Parse JSON before the webhook route so the exact fields can be validated.
// Saweria's documented signature is HMAC-SHA256 over the concatenation of:
// version, id, amount_raw, donator_name, donator_email (in this exact order).
app.use(express.json({ limit: MAX_BODY_BYTES, strict: true }));

function safeString(value, maxLength) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, maxLength);
}

function verifySaweriaSignature(req, res, next) {
    const provided = req.get("Saweria-Callback-Signature") || "";
    if (!/^[a-f0-9]{64}$/i.test(provided)) {
        return res.status(401).json({ error: "Invalid callback signature" });
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "Invalid JSON payload" });
    }

    const version = body.version;
    const id = body.id;
    const amountRaw = body.amount_raw;
    const donatorName = body.donator_name;
    const donatorEmail = body.donator_email;

    // Reject missing or unexpected field types before signature verification.
    if (
        (typeof version !== "string" && typeof version !== "number") ||
        typeof id !== "string" ||
        (typeof amountRaw !== "number" && typeof amountRaw !== "string") ||
        typeof donatorName !== "string" ||
        typeof donatorEmail !== "string"
    ) {
        return res.status(400).json({ error: "Missing or invalid signature fields" });
    }

    const amountText = String(amountRaw);
    if (!/^\d+$/.test(amountText)) {
        return res.status(400).json({ error: "Invalid amount_raw" });
    }

    const signedMessage = [
        String(version),
        id,
        amountText,
        donatorName,
        donatorEmail
    ].join("");

    const expected = crypto
        .createHmac("sha256", SAWERIA_STREAM_KEY)
        .update(signedMessage, "utf8")
        .digest();

    const supplied = Buffer.from(provided, "hex");
    if (supplied.length !== expected.length ||
        !crypto.timingSafeEqual(supplied, expected)) {
        return res.status(401).json({ error: "Invalid callback signature" });
    }

    next();
}

function requireBridgeSecret(req, res, next) {
    const supplied = req.get("x-bridge-secret") || "";
    const suppliedBytes = Buffer.from(supplied, "utf8");
    const expectedBytes = Buffer.from(BRIDGE_SECRET, "utf8");

    if (
        suppliedBytes.length !== expectedBytes.length ||
        !crypto.timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    next();
}

const insertDonation = db.prepare(`
    INSERT OR IGNORE INTO donations
        (id, donor, amount, message, created_at)
    VALUES
        (@id, @donor, @amount, @message, @created_at)
`);

const selectPending = db.prepare(`
    SELECT id, donor, amount, message, created_at
    FROM donations
    WHERE acknowledged = 0
    ORDER BY received_at ASC, id ASC
    LIMIT ?
`);

const acknowledgeOne = db.prepare(`
    UPDATE donations
    SET acknowledged = 1
    WHERE id = ?
`);

const insertDonationTransaction = db.transaction((donation) => {
    const result = insertDonation.run(donation);
    return result.changes === 1;
});

app.get("/health", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ ok: true });
});

app.post("/saweria/webhook", verifySaweriaSignature, (req, res) => {
    try {
        const body = req.body;
        const id = safeString(body.id, 100);
        const amount = Number(body.amount_raw);
        const donor = safeString(body.donator_name, 60) || "Anonim";
        const message = safeString(body.message, 200);
        const createdAt = safeString(body.created_at, 64) || new Date().toISOString();

        if (!id || !Number.isSafeInteger(amount) || amount <= 0) {
            return res.status(400).json({ error: "Invalid donation ID or amount" });
        }

        // The transaction ID is the primary key. Duplicate callbacks do not
        // create a second queue entry.
        const inserted = insertDonationTransaction({
            id,
            donor,
            amount,
            message,
            created_at: createdAt
        });

        return res.status(200).json({ ok: true, duplicate: !inserted });
    } catch (error) {
        console.error("[webhook] Failed to store verified callback:", error.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/roblox/poll", requireBridgeSecret, (req, res) => {
    try {
        const donations = selectPending.all(MAX_BATCH_SIZE);
        res.set("Cache-Control", "no-store");
        return res.status(200).json({ donations });
    } catch (error) {
        console.error("[poll] Database error:", error.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/roblox/ack", requireBridgeSecret, (req, res) => {
    const ids = req.body && req.body.ids;

    if (
        !Array.isArray(ids) ||
        ids.length > MAX_BATCH_SIZE ||
        !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100)
    ) {
        return res.status(400).json({ error: "ids must be an array of at most 20 valid IDs" });
    }

    try {
        const acknowledgeTransaction = db.transaction((items) => {
            for (const id of items) acknowledgeOne.run(id);
        });
        acknowledgeTransaction([...new Set(ids)]);

        return res.status(200).json({ ok: true, acknowledged: [...new Set(ids)].length });
    } catch (error) {
        console.error("[ack] Database error:", error.message);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// Do not expose stack traces or secret values to callers.
app.use((error, _req, res, _next) => {
    if (error && error.type === "entity.too.large") {
        return res.status(413).json({ error: "Payload too large" });
    }
    if (error instanceof SyntaxError && "body" in error) {
        return res.status(400).json({ error: "Invalid JSON" });
    }
    console.error("[http] Unhandled request error:", error && error.message);
    return res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[bridge] Listening on port ${PORT}`);
});

function shutdown(signal) {
    console.log(`[bridge] ${signal} received; shutting down`);
    server.close(() => {
        try {
            db.close();
        } finally {
            process.exit(0);
        }
    });
    setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
