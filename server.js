"use strict";

const crypto = require("node:crypto");

const fs = require("node:fs");

const path = require("node:path");

const { promisify } = require("node:util");

const { DatabaseSync } = require("node:sqlite");

const express = require("express");

const helmet = require("helmet");

const scrypt = promisify(crypto.scrypt);

const app = express();

const port = Number(process.env.PORT) || 3000;

const host = process.env.HOST || "127.0.0.1";

const isProduction = process.env.NODE_ENV === "production";

const sessionCookie = "alidb_session";

const sessionDurationMs = 24 * 60 * 60 * 1000;

const rememberMeSessionDurationMs = 30 * 24 * 60 * 60 * 1000;

const passwordHashBytes = 64;

const sqliteUniqueConstraintCode = 2067;

const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const aiEngine = require("./ai-engine");

const databaseDirectory = process.env.ALIDB_PATH
  ? path.dirname(path.resolve(process.env.ALIDB_PATH))
  : path.join(__dirname, "data");

const databasePath = process.env.ALIDB_PATH
  ? path.resolve(process.env.ALIDB_PATH)
  : path.join(databaseDirectory, "AliDB.db");

fs.mkdirSync(databaseDirectory, { recursive: true });

const database = new DatabaseSync(databasePath);

database.exec(`

    PRAGMA foreign_keys = ON;

    PRAGMA journal_mode = WAL;

    PRAGMA busy_timeout = 5000;

    PRAGMA synchronous = NORMAL;



    CREATE TABLE IF NOT EXISTS users (

        id INTEGER PRIMARY KEY,

        username TEXT NOT NULL COLLATE NOCASE UNIQUE,

        password_hash BLOB NOT NULL,

        created_at INTEGER NOT NULL

    );



    CREATE TABLE IF NOT EXISTS sessions (

        token_hash TEXT PRIMARY KEY,

        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

        created_at INTEGER NOT NULL,

        expires_at INTEGER NOT NULL

    );



    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx

    ON sessions(expires_at);



    CREATE TABLE IF NOT EXISTS conversations (

        id INTEGER PRIMARY KEY,

        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

        title TEXT NOT NULL,

        created_at INTEGER NOT NULL,

        updated_at INTEGER NOT NULL

    );



    CREATE INDEX IF NOT EXISTS conversations_user_updated_idx

    ON conversations(user_id, updated_at DESC);



    CREATE TABLE IF NOT EXISTS messages (

        id INTEGER PRIMARY KEY,

        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),

        content TEXT NOT NULL,

        status TEXT,

        created_at INTEGER NOT NULL

    );



    CREATE INDEX IF NOT EXISTS messages_conversation_idx

    ON messages(conversation_id, id);

`);

const findUserByName = database.prepare(
  "SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE",
);

const insertUser = database.prepare(
  "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
);

const insertSession = database.prepare(
  "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
);

const findSession = database.prepare(`

    SELECT users.id, users.username, sessions.token_hash

    FROM sessions

    JOIN users ON users.id = sessions.user_id

    WHERE sessions.token_hash = ? AND sessions.expires_at > ?

`);

const deleteSession = database.prepare(
  "DELETE FROM sessions WHERE token_hash = ?",
);

const listConversations = database.prepare(`

    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt

    FROM conversations

    WHERE user_id = ?

    ORDER BY updated_at DESC, id DESC

`);

const findConversation = database.prepare(`

    SELECT id, user_id AS userId, title, created_at AS createdAt, updated_at AS updatedAt

    FROM conversations

    WHERE id = ? AND user_id = ?

`);

const insertConversation = database.prepare(`

    INSERT INTO conversations (user_id, title, created_at, updated_at)

    VALUES (?, ?, ?, ?)

`);

const renameConversation = database.prepare(
  "UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?",
);

const insertMessage = database.prepare(`

    INSERT INTO messages (conversation_id, role, content, status, created_at)

    VALUES (?, ?, ?, ?, ?)

`);

const listMessages = database.prepare(`

    SELECT id, role, content, status, created_at AS createdAt

    FROM messages

    WHERE conversation_id = ?

    ORDER BY id ASC

`);

const touchConversation = database.prepare(`

    UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?

`);

const deleteConversation = database.prepare(
  "DELETE FROM conversations WHERE id = ? AND user_id = ?",
);

const authAttempts = new Map();

const authWindowMs = 15 * 60 * 1000;

const authMaxAttempts = 10;

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],

        scriptSrc: ["'self'"],

        styleSrc: ["'self'", "https\://fonts.googleapis.com"],

        fontSrc: ["'self'", "https\://fonts.gstatic.com"],

        imgSrc: ["'self'", "data:"],

        connectSrc: ["'self'"],

        objectSrc: ["'none'"],

        baseUri: ["'self'"],

        formAction: ["'self'"],

        frameAncestors: ["'none'"],
      },
    },

    referrerPolicy: { policy: "no-referrer" },
  }),
);

app.use(express.json({ limit: "1mb", strict: true }));

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");

  next();
});

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;

  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");

    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }

    return part.slice(separator + 1).trim();
  }

  return null;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getSessionDurationMs(rememberMe) {
  return rememberMe ? rememberMeSessionDurationMs : sessionDurationMs;
}

function setSessionCookie(res, token, rememberMe = false) {
  const secure = isProduction ? "; Secure" : "";

  const maxAgeSeconds = Math.floor(getSessionDurationMs(rememberMe) / 1000);

  res.setHeader(
    "Set-Cookie",

    `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

function clearSessionCookie(res) {
  const secure = isProduction ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",

    `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

function rejectCrossOrigin(req, res, next) {
  const origin = req.get("origin");

  if (!origin) {
    return next();
  }

  try {
    const parsedOrigin = new URL(origin);

    if (
      !["http:", "https:"].includes(parsedOrigin.protocol) ||
      parsedOrigin.host !== req.get("host")
    ) {
      return res
        .status(403)
        .json({ error: "Bu istek kaynağına izin verilmiyor." });
    }
  } catch (error) {
    return res.status(403).json({ error: "Geçersiz istek kaynağı." });
  }

  return next();
}

function limitAuthAttempts(req, res, next) {
  const key = req.socket.remoteAddress || "unknown";

  const now = Date.now();

  const recentAttempts = (authAttempts.get(key) || []).filter(
    (timestamp) => now - timestamp < authWindowMs,
  );

  if (recentAttempts.length >= authMaxAttempts) {
    res.setHeader("Retry-After", String(Math.ceil(authWindowMs / 1000)));

    return res.status(429).json({
      error: "Çok fazla deneme yapıldı. 15 dakika sonra tekrar dene.",
    });
  }

  recentAttempts.push(now);

  authAttempts.set(key, recentAttempts);

  return next();
}

function authenticate(req, res, next) {
  const token = getCookie(req, sessionCookie);

  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    return res.status(401).json({ error: "Oturum açman gerekiyor." });
  }

  const tokenHash = hashSessionToken(token);

  const session = findSession.get(tokenHash, Date.now());

  if (!session) {
    deleteSession.run(tokenHash);

    clearSessionCookie(res);

    return res
      .status(401)
      .json({ error: "Oturumun sona erdi. Tekrar giriş yap." });
  }

  req.authUser = { id: session.id, username: session.username };

  req.sessionTokenHash = tokenHash;

  return next();
}

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validateCredentials(username, password) {
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return "Kullanıcı adı 3–32 karakter olmalı; harf, rakam, nokta, tire ve alt çizgi kullanılabilir.";
  }

  if (
    typeof password !== "string" ||
    password.length < 12 ||
    Buffer.byteLength(password, "utf8") > 128
  ) {
    return "Parola en az 12 karakter olmalı ve 128 baytı aşmamalı.";
  }

  return null;
}

async function hashPassword(password, salt) {
  return scrypt(password, salt, passwordHashBytes, scryptOptions);
}

function createSession(userId, rememberMe = false) {
  const token = crypto.randomBytes(32).toString("base64url");

  const now = Date.now();

  const expiresAt = now + getSessionDurationMs(rememberMe);

  insertSession.run(hashSessionToken(token), userId, now, expiresAt);

  return token;
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/style.css", (req, res) => {
  res.sendFile(path.join(__dirname, "style.css"));
});

app.get("/auth.css", (req, res) => {
  res.sendFile(path.join(__dirname, "auth.css"));
});

app.get("/fonts/:filename", (req, res) => {
    const allowedFonts = ["VCR_OSD_MONO.ttf"];

    if (!allowedFonts.includes(req.params.filename)) {
        return res.sendStatus(404);
    }

    res.type("font/ttf");
    res.sendFile(path.join(__dirname, "fonts", req.params.filename));
});

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "online",
        service: "PrismX"
    });
});

app.get("/script.js", (req, res) => {
  res.sendFile(path.join(__dirname, "script.js"));
});

app.get("/instructions.txt", (req, res) => {
  res.type("text/plain");
  res.sendFile(path.join(__dirname, "instructions.txt"));
});

app.get("/user_laws.txt", (req, res) => {
    res.type("text/plain");
    res.sendFile(path.join(__dirname, "user_laws.txt"));
});

app.get("/vendor/marked.umd.js", (req, res) => {
  res.sendFile(
    path.join(__dirname, "node_modules", "marked", "lib", "marked.umd.js"),
  );
});

app.get("/vendor/purify.min.js", (req, res) => {
  res.sendFile(
    path.join(__dirname, "node_modules", "dompurify", "dist", "purify.min.js"),
  );
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/register", (req, res) => {
  res.sendFile(path.join(__dirname, "register.html"));
});

app.get("/PrismX.png", (req, res) => {
  res.sendFile(path.join(__dirname, "PrismX.png"));
});

app.get("/api/auth/me", authenticate, (req, res) => {
  res.json({ user: req.authUser });
});

app.post("/api/ai/chat", rejectCrossOrigin, authenticate, async (req, res) => {
  const incomingMessages = req.body?.messages;
  if (
    !Array.isArray(incomingMessages) ||
    incomingMessages.length < 1 ||
    incomingMessages.length > 20
  ) {
    return res.status(400).json({
      error: "AI isteğinde 1–20 arası mesaj bulunmalı.",
      code: "INVALID_AI_MESSAGES",
      source: "PrismX",
    });
  }

  let totalCharacters = 0;
  const messages = [];
  for (const message of incomingMessages) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      !message.content.trim() ||
      message.content.length > 40_000
    ) {
      return res.status(400).json({
        error: "AI mesajı geçersiz veya çok uzun.",
        code: "INVALID_AI_MESSAGE",
        source: "PrismX",
      });
    }
    totalCharacters += message.content.length;
    if (totalCharacters > 40_000) {
      return res.status(400).json({
        error: "AI konuşma geçmişi çok uzun.",
        code: "AI_CONTEXT_TOO_LONG",
        source: "PrismX",
      });
    }
    messages.push({ role: message.role, content: message.content });
  }

  if (messages[messages.length - 1].role !== "user") {
    return res.status(400).json({
      error: "AI isteğinin son mesajı kullanıcıdan gelmeli.",
      code: "INVALID_AI_MESSAGES",
      source: "PrismX",
    });
  }

  try {
    const result = await aiEngine.chat(messages);
    return res.json({
      answer: result.answer,
      provider: result.provider,
      model: result.model,
      fallback: result.fallback,
      ...(result.primaryError
        ? {
            fallbackReason: {
              provider: result.primaryError.provider,
              code: result.primaryError.code,
              message: result.primaryError.message,
              httpStatus: result.primaryError.status || null,
            },
          }
        : {}),
    });
  } catch (error) {
    console.error("[PrismX AI] İstek başarısız:", {
      provider: error.provider || "PrismX",
      code: error.code || "AI_UNKNOWN_ERROR",
      status: error.status || null,
      message: error.message,
      details: error.details || null,
      primaryError: error.primaryError
        ? {
            code: error.primaryError.code,
            message: error.primaryError.message,
            details: error.primaryError.details || null,
          }
        : null,
      fallbackError: error.fallbackError
        ? {
            code: error.fallbackError.code,
            message: error.fallbackError.message,
            details: error.fallbackError.details || null,
          }
        : null,
    });

    const httpStatus =
      error.status === 429
        ? 429
        : error.status === 401 || error.status === 403
          ? 503
          : error.status === 504
            ? 504
            : 502;

    return res.status(httpStatus).json({
      error: error.userMessage || error.message || "AI isteği başarısız oldu.",
      code: error.code || "AI_UNKNOWN_ERROR",
      source: error.provider || "PrismX",
      fallbackAttempted: Boolean(error.fallbackError),
      ...(error.primaryError
        ? {
            primaryError: {
              provider: error.primaryError.provider,
              code: error.primaryError.code,
              message: error.primaryError.message,
              httpStatus: error.primaryError.status || null,
            },
          }
        : {}),
      ...(error.fallbackError
        ? {
            fallbackError: {
              provider: error.fallbackError.provider,
              code: error.fallbackError.code,
              message: error.fallbackError.message,
              httpStatus: error.fallbackError.status || null,
            },
          }
        : {}),
    });
  }
});

app.get("/api/conversations", authenticate, (req, res) => {
  res.json({ conversations: listConversations.all(req.authUser.id) });
});

app.post("/api/conversations", rejectCrossOrigin, authenticate, (req, res) => {
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() : "";

  if (!title || title.length > 80) {
    return res
      .status(400)
      .json({ error: "Sohbet başlığı 1–80 karakter olmalı." });
  }

  const now = Date.now();

  const result = insertConversation.run(req.authUser.id, title, now, now);

  const conversation = {
    id: Number(result.lastInsertRowid),

    title,

    createdAt: now,

    updatedAt: now,
  };

  return res.status(201).json({ conversation });
});

app.patch(
  "/api/conversations/:id",
  rejectCrossOrigin,
  authenticate,
  (req, res) => {
    const conversationId = Number(req.params.id);

    if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
      return res.status(404).json({ error: "Sohbet bulunamadı." });
    }

    const title =
      typeof req.body?.title === "string" ? req.body.title.trim() : "";

    if (!title || title.length > 80) {
      return res
        .status(400)
        .json({ error: "Sohbet adı 1–80 karakter olmalı." });
    }

    const existingConversation = findConversation.get(
      conversationId,
      req.authUser.id,
    );

    if (!existingConversation) {
      return res.status(404).json({ error: "Sohbet bulunamadı." });
    }

    renameConversation.run(title, conversationId, req.authUser.id);

    return res.json({
      conversation: {
        id: existingConversation.id,

        title,

        createdAt: existingConversation.createdAt,

        updatedAt: existingConversation.updatedAt,
      },
    });
  },
);

app.get("/api/conversations/:id/messages", authenticate, (req, res) => {
  const conversationId = Number(req.params.id);

  if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
    return res.status(404).json({ error: "Sohbet bulunamadı." });
  }

  const conversation = findConversation.get(conversationId, req.authUser.id);

  if (!conversation) {
    return res.status(404).json({ error: "Sohbet bulunamadı." });
  }

  return res.json({
    conversation,

    messages: listMessages.all(conversationId),
  });
});

app.post(
  "/api/conversations/:id/messages",
  rejectCrossOrigin,
  authenticate,
  (req, res) => {
    const conversationId = Number(req.params.id);

    if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
      return res.status(404).json({ error: "Sohbet bulunamadı." });
    }

    const conversation = findConversation.get(conversationId, req.authUser.id);

    if (!conversation) {
      return res.status(404).json({ error: "Sohbet bulunamadı." });
    }

    const role = req.body?.role;

    const content = req.body?.content;

    const status = req.body?.status;

    if (
      !["user", "assistant"].includes(role) ||
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 100_000 ||
      (status !== undefined &&
        status !== null &&
        (typeof status !== "string" || status.length > 120))
    ) {
      return res.status(400).json({ error: "Mesaj geçersiz veya çok uzun." });
    }

    const createdAt = Date.now();

    database.exec("BEGIN IMMEDIATE");

    let message;

    try {
      const result = insertMessage.run(
        conversationId,

        role,

        content,

        status || null,

        createdAt,
      );

      touchConversation.run(createdAt, conversationId, req.authUser.id);

      database.exec("COMMIT");

      message = {
        id: Number(result.lastInsertRowid),

        role,

        content,

        status: status || null,

        createdAt,
      };
    } catch (error) {
      database.exec("ROLLBACK");

      throw error;
    }

    return res.status(201).json({
      conversation: {
        id: conversation.id,

        title: conversation.title,

        createdAt: conversation.createdAt,

        updatedAt: createdAt,
      },

      message,
    });
  },
);

app.delete(
  "/api/conversations/:id",
  rejectCrossOrigin,
  authenticate,
  (req, res) => {
    const conversationId = Number(req.params.id);

    if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
      return res.status(404).json({ error: "Sohbet bulunamadı." });
    }

    const result = deleteConversation.run(conversationId, req.authUser.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: "Sohbet bulunamadı." });
    }

    return res.status(204).end();
  },
);

app.post(
  "/api/auth/register",
  rejectCrossOrigin,
  limitAuthAttempts,
  async (req, res, next) => {
    const username = normalizeUsername(req.body && req.body.username);

    const password = req.body && req.body.password;

    const validationError = validateCredentials(username, password);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    try {
      const salt = crypto.randomBytes(16);

      const passwordHash = await hashPassword(password, salt);

      const rememberMe = req.body && req.body.rememberMe === true;

      database.exec("BEGIN IMMEDIATE");

      let user;

      let token;

      try {
        const result = insertUser.run(
          username,

          Buffer.concat([salt, passwordHash]),

          Date.now(),
        );

        user = { id: Number(result.lastInsertRowid), username };

        token = createSession(user.id, rememberMe);

        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");

        throw error;
      }

      setSessionCookie(res, token, rememberMe);

      return res.status(201).json({ user: publicUser(user) });
    } catch (error) {
      if (error.errcode === sqliteUniqueConstraintCode) {
        return res
          .status(409)
          .json({ error: "Bu kullanıcı adı kullanılamıyor." });
      }

      return next(error);
    }
  },
);

app.post(
  "/api/auth/login",
  rejectCrossOrigin,
  limitAuthAttempts,
  async (req, res, next) => {
    const username = normalizeUsername(req.body && req.body.username);

    const password = req.body && req.body.password;

    if (
      !/^[a-zA-Z0-9._-]{3,32}$/.test(username) ||
      typeof password !== "string" ||
      password.length === 0 ||
      Buffer.byteLength(password, "utf8") > 128
    ) {
      return res
        .status(401)
        .json({ error: "Kullanıcı adı veya parola hatalı." });
    }

    try {
      const user = findUserByName.get(username);

      const storedHash = user ? Buffer.from(user.password_hash) : null;

      const salt = storedHash
        ? storedHash.subarray(0, 16)
        : Buffer.alloc(16, 0x5a);

      const expectedHash = storedHash
        ? storedHash.subarray(16)
        : await hashPassword("not-a-real-password", salt);

      const suppliedHash = await hashPassword(password, salt);

      const valid =
        suppliedHash.length === expectedHash.length &&
        crypto.timingSafeEqual(suppliedHash, expectedHash);

      if (!user || !valid) {
        return res
          .status(401)
          .json({ error: "Kullanıcı adı veya parola hatalı." });
      }

      const rememberMe = req.body && req.body.rememberMe === true;

      const token = createSession(user.id, rememberMe);

      setSessionCookie(res, token, rememberMe);

      return res.json({ user: publicUser(user) });
    } catch (error) {
      return next(error);
    }
  },
);

app.post("/api/auth/logout", rejectCrossOrigin, (req, res) => {
  const token = getCookie(req, sessionCookie);

  if (token && /^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    deleteSession.run(hashSessionToken(token));
  }

  clearSessionCookie(res);

  return res.status(204).end();
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API uç noktası bulunamadı." });
});

app.use((error, req, res, next) => {
  console.error("[PrismX Server] Beklenmeyen hata:", {
    name: error.name,
    code: error.code || "SERVER_UNEXPECTED_ERROR",
    message: error.message,
    stack: error.stack,
  });

  if (res.headersSent) {
    return next(error);
  }

  const status =
    Number.isInteger(error.status) && error.status >= 400 && error.status < 500
      ? error.status
      : 500;

  return res.status(status).json({
    error:
      status === 500
        ? "Sunucuda beklenmeyen bir hata oluştu."
        : "İstek işlenemedi.",
  });
});

const cleanupTimer = setInterval(
  () => {
    database
      .prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .run(Date.now());

    for (const [key, timestamps] of authAttempts) {
      const active = timestamps.filter(
        (timestamp) => Date.now() - timestamp < authWindowMs,
      );

      if (active.length) {
        authAttempts.set(key, active);
      } else {
        authAttempts.delete(key);
      }
    }
  },
  60 * 60 * 1000,
);

cleanupTimer.unref();

const server = app.listen(port, host, () => {
  console.log(`Prism X sunucusu http\://${host}:${port} adresinde çalışıyor.`);

  console.log(`AliDB veritabanı: ${databasePath}`);
});

function shutdown() {
  clearInterval(cleanupTimer);

  server.close(() => {
    database.close();

    process.exit(0);
  });
}

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);
