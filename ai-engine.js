
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ==========================================
// PRISMX AI ENGINE
// Gemini Primary / Groq Fallback
// BY PRISM CREW
// ==========================================

// System instructions
const instructionsPath = path.join(__dirname, "instructions.txt");

if (!fs.existsSync(instructionsPath)) {
    throw new Error(
        "[PrismX AI] INSTRUCTIONS_FILE_NOT_FOUND: instructions.txt bulunamadı."
    );
}

const instructions = fs.readFileSync(instructionsPath, "utf8").trim();

if (!instructions) {
    throw new Error(
        "[PrismX AI] INSTRUCTIONS_FILE_EMPTY: instructions.txt boş."
    );
}

// Models
const geminiModel =
    process.env.GEMINI_MODEL || "gemini-3.8-flash";

const groqModel =
    process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Independent timeouts
function getTimeout(name) {
    const value = Number(process.env[name]);

    return Number.isFinite(value) && value >= 1000
        ? value
        : 20000;
}

const geminiTimeoutMs = getTimeout("GEMINI_TIMEOUT_MS");
const groqTimeoutMs = getTimeout("GROQ_TIMEOUT_MS");

// ==========================================
// ERROR HANDLING
// ==========================================

function providerError(
    provider,
    code,
    message,
    status,
    details = null
) {
    const error = new Error(message);

    error.provider = provider;
    error.code = code;
    error.status = status;
    error.details = details;

    return error;
}

// ==========================================
// HTTP REQUEST
// ==========================================

async function postJson(
    provider,
    url,
    headers,
    body,
    timeoutMs
) {
    let response;

    try {
        response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (cause) {
        const timedOut =
            cause.name === "TimeoutError" ||
            cause.name === "AbortError";

        throw providerError(
            provider,
            `${provider.toUpperCase()}_${
                timedOut ? "TIMEOUT" : "UNAVAILABLE"
            }`,
            timedOut
                ? `${provider} isteği zaman aşımına uğradı (${timeoutMs / 1000} sn).`
                : `${provider} servisine bağlanılamadı: ${cause.message}`,
            timedOut ? 504 : 502,
            cause.message
        );
    }

    const rawBody = await response.text();

    let data = null;

    try {
        data = rawBody ? JSON.parse(rawBody) : null;
    } catch {
        // JSON parse error is handled below.
    }

    if (!response.ok) {
        const suffix =
            response.status === 401 || response.status === 403
                ? "AUTH_FAILED"
                : response.status === 429
                    ? "RATE_LIMITED"
                    : response.status >= 500
                        ? "UPSTREAM_ERROR"
                        : "REQUEST_REJECTED";

        const detail =
            data?.error?.message ||
            data?.message ||
            rawBody.slice(0, 1000) ||
            response.statusText;

        throw providerError(
            provider,
            `${provider.toUpperCase()}_${suffix}`,
            `${provider} HTTP ${response.status}: ${detail}`,
            response.status,
            detail
        );
    }

    if (!data || typeof data !== "object") {
        throw providerError(
            provider,
            `${provider.toUpperCase()}_INVALID_RESPONSE`,
            `${provider} geçerli JSON yanıtı döndürmedi.`,
            502,
            rawBody.slice(0, 1000)
        );
    }

    return data;
}

// ==========================================
// GEMINI PRIMARY ENGINE
// ==========================================

async function requestGemini(messages) {
    if (!process.env.GEMINI_API_KEY) {
        throw providerError(
            "Gemini",
            "GEMINI_KEY_MISSING",
            "GEMINI_API_KEY tanımlanmamış.",
            503
        );
    }

    const data = await postJson(
        "Gemini",
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
        {
            "x-goog-api-key": process.env.GEMINI_API_KEY,
            "Content-Type": "application/json"
        },
        {
            systemInstruction: {
                parts: [{ text: instructions }]
            },

            contents: messages.map(message => ({
                role: message.role === "assistant"
                    ? "model"
                    : "user",

                parts: [{ text: message.content }]
            })),

            generationConfig: {
                maxOutputTokens: 1200
            }
        },
        geminiTimeoutMs
    );

    const candidate = data.candidates?.[0];

    const answer = candidate?.content?.parts
        ?.filter(part =>
            part &&
            typeof part.text === "string" &&
            part.thought !== true
        )
        .map(part => part.text)
        .join("");

    if (typeof answer !== "string" || !answer.trim()) {
        const reason =
            candidate?.finishReason ||
            data.promptFeedback?.blockReason ||
            "EMPTY";

        throw providerError(
            "Gemini",
            "GEMINI_EMPTY_RESPONSE",
            `Gemini boş yanıt döndürdü. Neden: ${reason}`,
            502,
            {
                finishReason: candidate?.finishReason || null,
                promptFeedback: data.promptFeedback || null
            }
        );
    }

    return {
        answer: answer.trim(),
        model: data.modelVersion || geminiModel
    };
}

// ==========================================
// GROQ FALLBACK ENGINE
// ==========================================

async function requestGroq(messages) {
    if (!process.env.GROQ_API_KEY) {
        throw providerError(
            "Groq",
            "GROQ_KEY_MISSING",
            "GROQ_API_KEY tanımlanmamış.",
            503
        );
    }

    const data = await postJson(
        "Groq",
        "https://api.groq.com/openai/v1/chat/completions",
        {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        {
            model: groqModel,

            messages: [
                {
                    role: "system",
                    content: instructions
                },
                ...messages
            ],

            max_completion_tokens: 1200
        },
        groqTimeoutMs
    );

    const answer = data.choices?.[0]?.message?.content;

    if (typeof answer !== "string" || !answer.trim()) {
        throw providerError(
            "Groq",
            "GROQ_EMPTY_RESPONSE",
            "Groq boş yanıt döndürdü.",
            502,
            {
                finishReason:
                    data.choices?.[0]?.finish_reason || null
            }
        );
    }

    return {
        answer: answer.trim(),
        model: data.model || groqModel
    };
}

// ==========================================
// MAIN CHAT FUNCTION
// ==========================================

async function chat(messages) {
    let primaryError;

    // Always try Gemini first.
    try {
        const result = await requestGemini(messages);

        return {
            ...result,
            provider: "Gemini",
            fallback: false
        };
    } catch (error) {
        primaryError = error;

        console.error(
            "[PrismX AI] Gemini ana motor başarısız:",
            {
                code: error.code,
                status: error.status,
                message: error.message,
                details: error.details
            }
        );
    }

    // Gemini failed. Try Groq.
    try {
        const result = await requestGroq(messages);

        return {
            ...result,
            provider: "Groq",
            fallback: true,
            primaryError
        };
    } catch (fallbackError) {
        console.error(
            "[PrismX AI] Groq yedek motor başarısız:",
            {
                code: fallbackError.code,
                status: fallbackError.status,
                message: fallbackError.message,
                details: fallbackError.details
            }
        );

        const error = providerError(
            "PrismX AI",
            "AI_ALL_PROVIDERS_FAILED",
            "Gemini ana motoru ve Groq yedek motoru başarısız oldu.",
            fallbackError.status ||
                primaryError.status ||
                502
        );

        error.primaryError = primaryError;
        error.fallbackError = fallbackError;

        error.userMessage =
            `Gemini [${primaryError.code}]: ${primaryError.message} | ` +
            `Groq [${fallbackError.code}]: ${fallbackError.message}`;

        throw error;
    }
}

module.exports = {
    chat
};
