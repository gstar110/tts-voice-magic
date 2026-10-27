const TOKEN_REFRESH_BEFORE_EXPIRY = 3 * 60;
let tokenInfo = {
    endpoint: null,
    token: null,
    expiredAt: null
};

// ===================== Edge TTS WebSocket 常量 =====================
const EDGE_TTS_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_TTS_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

// ★ 方案一：新主机接受 v1 token，版本号用 1- 前缀
const EDGE_TTS_SEC_MS_GEC_VERSION = "1-143.0.3650.75";

// 新主机：api.msedgeservices.com
const EDGE_TTS_NEW_HOST = "api.msedgeservices.com";
const EDGE_TTS_NEW_PATH = "/tts/cognitiveservices/websocket/v1";

// HTML 页面模板（内容未改动，此处省略以保持简洁，实际部署时保留你原有的 HTML_PAGE 即可）
// ★ 如果你本地文件里 HTML_PAGE 完整存在，保持原样不动，不要替换。

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request);
    }
};

async function handleRequest(request) {
    if (request.method === "OPTIONS") {
        return handleOptions(request);
    }

    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;

    if (path === "/" || path === "/index.html") {
        return new Response(HTML_PAGE, {
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                ...makeCORSHeaders()
            }
        });
    }

    if (path === "/v1/audio/transcriptions") {
        try {
            return await handleAudioTranscription(request);
        } catch (error) {
            console.error("Audio transcription error:", error);
            return new Response(JSON.stringify({
                error: {
                    message: error.message,
                    type: "api_error",
                    param: null,
                    code: "transcription_error"
                }
            }), {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }
    }

    if (path === "/v1/audio/speech-with-timings") {
        try {
            return await handleSpeechWithTimings(request);
        } catch (error) {
            console.error("Speech with timings error:", error);
            return new Response(JSON.stringify({
                error: {
                    message: error.message || String(error),
                    type: "api_error",
                    param: null,
                    code: "edge_tts_timings_error"
                }
            }), {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }
    }

    if (path === "/v1/audio/speech") {
        try {
            const contentType = request.headers.get("content-type") || "";
            
            if (contentType.includes("multipart/form-data")) {
                return await handleFileUpload(request);
            }
            
            const requestBody = await request.json();
            const {
                input,
                voice = "zh-CN-XiaoxiaoNeural",
                speed = '1.0',
                volume = '0',
                pitch = '0',
                style = "general"
            } = requestBody;

            let rate = parseInt(String((parseFloat(speed) - 1.0) * 100));
            let numVolume = parseInt(String(parseFloat(volume) * 100));
            let numPitch = parseInt(pitch);
            const response = await getVoice(
                input,
                voice,
                rate >= 0 ? `+${rate}%` : `${rate}%`,
                numPitch >= 0 ? `+${numPitch}Hz` : `${numPitch}Hz`,
                numVolume >= 0 ? `+${numVolume}%` : `${numVolume}%`,
                style,
                "audio-24khz-48kbitrate-mono-mp3"
            );

            return response;

        } catch (error) {
            console.error("Error:", error);
            return new Response(JSON.stringify({
                error: {
                    message: error.message,
                    type: "api_error",
                    param: null,
                    code: "edge_tts_error"
                }
            }), {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }
    }

    return new Response("Not Found", { status: 404 });
}

async function handleOptions(request) {
    return new Response(null, {
        status: 204,
        headers: {
            ...makeCORSHeaders(),
            "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
            "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "Authorization"
        }
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function optimizedTextSplit(text, maxChunkSize = 1500) {
    const chunks = [];
    const sentences = text.split(/[。！？\n]/);
    let currentChunk = '';
    
    for (const sentence of sentences) {
        const trimmedSentence = sentence.trim();
        if (!trimmedSentence) continue;
        
        if (trimmedSentence.length > maxChunkSize) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            for (let i = 0; i < trimmedSentence.length; i += maxChunkSize) {
                chunks.push(trimmedSentence.slice(i, i + maxChunkSize));
            }
        } else if ((currentChunk + trimmedSentence).length > maxChunkSize) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = trimmedSentence;
        } else {
            currentChunk += (currentChunk ? '。' : '') + trimmedSentence;
        }
    }
    
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    return chunks.filter(chunk => chunk.length > 0);
}

async function processBatchedAudioChunks(chunks, voiceName, rate, pitch, volume, style, outputFormat, batchSize = 3, delayMs = 1000) {
    const audioChunks = [];
    
    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const batchPromises = batch.map(async (chunk, index) => {
            try {
                if (index > 0) await delay(index * 200);
                return await getAudioChunk(chunk, voiceName, rate, pitch, volume, style, outputFormat);
            } catch (error) {
                console.error(`处理音频块失败 (批次 ${Math.floor(i/batchSize) + 1}, 块 ${index + 1}):`, error);
                throw error;
            }
        });
        
        try {
            const batchResults = await Promise.all(batchPromises);
            audioChunks.push(...batchResults);
            if (i + batchSize < chunks.length) await delay(delayMs);
        } catch (error) {
            console.error(`批次处理失败:`, error);
            throw error;
        }
    }
    
    return audioChunks;
}

async function getVoice(text, voiceName = "zh-CN-XiaoxiaoNeural", rate = '+0%', pitch = '+0Hz', volume = '+0%', style = "general", outputFormat = "audio-24khz-48kbitrate-mono-mp3") {
    try {
        const cleanText = text.trim();
        if (!cleanText) throw new Error("文本内容为空");
        
        if (cleanText.length <= 1500) {
            const audioBlob = await getAudioChunk(cleanText, voiceName, rate, pitch, volume, style, outputFormat);
            return new Response(audioBlob, {
                headers: { "Content-Type": "audio/mpeg", ...makeCORSHeaders() }
            });
        }

        const chunks = optimizedTextSplit(cleanText, 1500);
        
        if (chunks.length > 40) {
            throw new Error(`文本过长，分块数量(${chunks.length})超过限制。请缩短文本或分批处理。`);
        }
        
        console.log(`文本已分为 ${chunks.length} 个块进行处理`);

        const audioChunks = await processBatchedAudioChunks(
            chunks, voiceName, rate, pitch, volume, style, outputFormat, 3, 800
        );

        const concatenatedAudio = new Blob(audioChunks, { type: 'audio/mpeg' });
        return new Response(concatenatedAudio, {
            headers: { "Content-Type": "audio/mpeg", ...makeCORSHeaders() }
        });

    } catch (error) {
        console.error("语音合成失败:", error);
        return new Response(JSON.stringify({
            error: {
                message: error.message || String(error),
                type: "api_error",
                param: `${voiceName}, ${rate}, ${pitch}, ${volume}, ${style}, ${outputFormat}`,
                code: "edge_tts_error"
            }
        }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
        });
    }
}

async function getAudioChunk(text, voiceName, rate, pitch, volume, style, outputFormat = 'audio-24khz-48kbitrate-mono-mp3', maxRetries = 3) {
    const retryDelay = 500;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const endpoint = await getEndpoint();
            const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
            
            let m = text.match(/\[(\d+)\]\s*?$/);
            let slien = 0;
            if (m && m.length == 2) {
                slien = parseInt(m[1]);
                text = text.replace(m[0], '');
            }
            
            if (!text.trim()) throw new Error("文本块为空");
            if (text.length > 2000) throw new Error(`文本块过长: ${text.length} 字符，最大支持2000字符`);
            
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": endpoint.t,
                    "Content-Type": "application/ssml+xml",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                    "X-Microsoft-OutputFormat": outputFormat
                },
                body: getSsml(text, voiceName, rate, pitch, volume, style, slien)
            });

            if (!response.ok) {
                const errorText = await response.text();
                
                if (response.status === 429) {
                    if (attempt < maxRetries) {
                        console.log(`频率限制，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error(`请求频率过高，已重试${maxRetries}次仍失败`);
                } else if (response.status >= 500) {
                    if (attempt < maxRetries) {
                        console.log(`服务器错误，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error(`Edge TTS服务器错误: ${response.status} ${errorText}`);
                } else {
                    throw new Error(`Edge TTS API错误: ${response.status} ${errorText}`);
                }
            }

            return await response.blob();
            
        } catch (error) {
            if (attempt === maxRetries) {
                throw new Error(`音频生成失败（已重试${maxRetries}次）: ${error.message}`);
            }
            if (error.message.includes('fetch') || error.message.includes('network')) {
                console.log(`网络错误，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                await delay(retryDelay * (attempt + 1));
                continue;
            }
            throw error;
        }
    }
}

function escapeXmlText(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildEdgeSSML(text, voice, rate, pitch, volume, style) {
    const escapedText = escapeXmlText(text);

    const parts = String(voice || '').split('-');
    const lang = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'en-US';

    let inner = escapedText;

    if (style && style !== 'general' && style !== 'default' && style.trim() !== '') {
        inner = `<mstts:express-as style="${style}" styledegree="2.0">${inner}</mstts:express-as>`;
    }

    return `<speak xmlns="http://www.w3.org/2001/10/synthesis" ` +
           `xmlns:mstts="http://www.w3.org/2001/mstts" ` +
           `version="1.0" xml:lang="${lang}">` +
           `<voice name="${voice}">` +
           `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">` +
           inner +
           `</prosody>` +
           `</voice>` +
           `</speak>`;
}

function getSsml(text, voiceName, rate, pitch, volume, style, slien = 0) {
    const escapedText = escapeXmlText(text);

    let slien_str = '';
    if (slien > 0) {
        slien_str = `<break time="${slien}ms" />`;
    }

    let inner = escapedText;
    if (style && style !== 'general' && style !== 'default' && style.trim() !== '') {
        inner = `<mstts:express-as style="${style}" styledegree="2.0">${inner}</mstts:express-as>`;
    }

    return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN">` +
           `<voice name="${voiceName}">` +
           `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">` +
           inner +
           `</prosody>` +
           slien_str +
           `</voice>` +
           `</speak>`;
}

async function getEndpoint() {
    const now = Date.now() / 1000;

    if (tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
        return tokenInfo.endpoint;
    }

    const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
    const clientId = crypto.randomUUID().replace(/-/g, "");

    try {
        const response = await fetch(endpointUrl, {
            method: "POST",
            headers: {
                "Accept-Language": "zh-Hans",
                "X-ClientVersion": "4.0.530a 5fe1dc6c",
                "X-UserId": "0f04d16a175c411e",
                "X-HomeGeographicRegion": "zh-Hans-CN",
                "X-ClientTraceId": clientId,
                "X-MT-Signature": await sign(endpointUrl),
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": "0",
                "Accept-Encoding": "gzip"
            }
        });

        if (!response.ok) {
            throw new Error(`获取endpoint失败: ${response.status}`);
        }

        const data = await response.json();
        const jwt = data.t.split(".")[1];
        const decodedJwt = JSON.parse(atob(jwt));

        tokenInfo = {
            endpoint: data,
            token: data.t,
            expiredAt: decodedJwt.exp
        };

        return data;

    } catch (error) {
        console.error("获取endpoint失败:", error);
        if (tokenInfo.token) {
            console.log("使用过期的缓存token");
            return tokenInfo.endpoint;
        }
        throw error;
    }
}

function makeCORSHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-api-key",
        "Access-Control-Max-Age": "86400"
    };
}

async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: { name: "SHA-256" } },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
    return new Uint8Array(signature);
}

async function base64ToBytes(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

async function bytesToBase64(bytes) {
    return btoa(String.fromCharCode.apply(null, bytes));
}

function uuid() {
    return crypto.randomUUID().replace(/-/g, "");
}

async function sign(urlStr) {
    const url = urlStr.split("://")[1];
    const encodedUrl = encodeURIComponent(url);
    const uuidStr = uuid();
    const formattedDate = dateFormat();
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
    const decode = await base64ToBytes("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
    const signData = await hmacSha256(decode, bytesToSign);
    const signBase64 = await bytesToBase64(signData);
    return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

function dateFormat() {
    const formattedDate = (new Date()).toUTCString().replace(/GMT/, "").trim() + " GMT";
    return formattedDate.toLowerCase();
}

async function handleFileUpload(request) {
    try {
        const formData = await request.formData();
        const file = formData.get('file');
        const voice = formData.get('voice') || 'zh-CN-XiaoxiaoNeural';
        const speed = formData.get('speed') || '1.0';
        const volume = formData.get('volume') || '0';
        const pitch = formData.get('pitch') || '0';
        const style = formData.get('style') || 'general';

        if (!file) {
            return new Response(JSON.stringify({
                error: { message: "未找到上传的文件", type: "invalid_request_error", param: "file", code: "missing_file" }
            }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        if (!file.type.includes('text/') && !file.name.toLowerCase().endsWith('.txt')) {
            return new Response(JSON.stringify({
                error: { message: "不支持的文件类型，请上传txt文件", type: "invalid_request_error", param: "file", code: "invalid_file_type" }
            }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        if (file.size > 500 * 1024) {
            return new Response(JSON.stringify({
                error: { message: "文件大小超过限制（最大500KB）", type: "invalid_request_error", param: "file", code: "file_too_large" }
            }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        const text = await file.text();
        
        if (!text.trim()) {
            return new Response(JSON.stringify({
                error: { message: "文件内容为空", type: "invalid_request_error", param: "file", code: "empty_file" }
            }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        if (text.length > 10000) {
            return new Response(JSON.stringify({
                error: { message: "文本内容过长（最大10000字符）", type: "invalid_request_error", param: "file", code: "text_too_long" }
            }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        let rate = parseInt(String((parseFloat(speed) - 1.0) * 100));
        let numVolume = parseInt(String(parseFloat(volume) * 100));
        let numPitch = parseInt(pitch);

        return await getVoice(
            text,
            voice,
            rate >= 0 ? `+${rate}%` : `${rate}%`,
            numPitch >= 0 ? `+${numPitch}Hz` : `${numPitch}Hz`,
            numVolume >= 0 ? `+${numVolume}%` : `${numVolume}%`,
            style,
            "audio-24khz-48kbitrate-mono-mp3"
        );

    } catch (error) {
        console.error("文件上传处理失败:", error);
        return new Response(JSON.stringify({
            error: { message: "文件处理失败", type: "api_error", param: null, code: "file_processing_error" }
        }), { status: 500, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
    }
}

async function handleAudioTranscription(request) {
    try {
        if (request.method !== 'POST') {
            return new Response(JSON.stringify({
                error: { message: "只支持POST方法", type: "invalid_request_error", param: "method", code: "method_not_allowed" }
            }), { status: 405, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        const contentType = request.headers.get("content-type") || "";
        
        if (!contentType.includes("multipart/form-data")) {
            return new Response(JSON.stringify({
                error: { message: "请求必须使用multipart/form-data格式", type: "invalid_request_error", param: "content-type", code: "invalid_content_type" }
            }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        const formData = await request.formData();
        const audioFile = formData.get('file');
        const customToken = formData.get('token');

        if (!audioFile) {
            return new Response(JSON.stringify({
                error: { message: "未找到音频文件", type: "invalid_request_error", param: "file", code: "missing_file" }
            }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        if (audioFile.size > 10 * 1024 * 1024) {
            return new Response(JSON.stringify({
                error: { message: "音频文件大小不能超过10MB", type: "invalid_request_error", param: "file", code: "file_too_large" }
            }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        const allowedTypes = ['audio/mpeg','audio/mp3','audio/wav','audio/m4a','audio/flac','audio/aac','audio/ogg','audio/webm','audio/amr','audio/3gpp'];
        const isValidType = allowedTypes.some(type => 
            audioFile.type.includes(type) || 
            audioFile.name.toLowerCase().match(/\.(mp3|wav|m4a|flac|aac|ogg|webm|amr|3gp)$/i)
        );

        if (!isValidType) {
            return new Response(JSON.stringify({
                error: { message: "不支持的音频文件格式", type: "invalid_request_error", param: "file", code: "invalid_file_type" }
            }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        const token = customToken || 'sk-wtldsvuprmwltxpbspbmawtolbacghzawnjhtlzlnujjkfhh';

        const apiFormData = new FormData();
        apiFormData.append('file', audioFile);
        apiFormData.append('model', 'FunAudioLLM/SenseVoiceSmall');

        const apiResponse = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: apiFormData
        });

        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            console.error('硅基流动API错误:', apiResponse.status, errorText);
            let errorMessage = '语音转录服务暂时不可用';
            if (apiResponse.status === 401) errorMessage = 'API Token无效，请检查您的配置';
            else if (apiResponse.status === 429) errorMessage = '请求过于频繁，请稍后再试';
            else if (apiResponse.status === 413) errorMessage = '音频文件太大，请选择较小的文件';

            return new Response(JSON.stringify({
                error: { message: errorMessage, type: "api_error", param: null, code: "transcription_api_error" }
            }), { status: apiResponse.status, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
        }

        const transcriptionResult = await apiResponse.json();

        return new Response(JSON.stringify(transcriptionResult), {
            headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
        });

    } catch (error) {
        console.error("语音转录处理失败:", error);
        return new Response(JSON.stringify({
            error: { message: "语音转录处理失败", type: "api_error", param: null, code: "transcription_processing_error" }
        }), { status: 500, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
    }
}

// ============================================================================
// ===================== Edge TTS WebSocket（带 WordBoundary） =====================
// ============================================================================

/**
 * ★ 方案一：回退到 v1 Sec-MS-GEC token
 * 只做 SHA-256，返回 64 位 hex。
 * 新主机 api.msedgeservices.com 接受这个格式（配合 1-143.0.3650.75 版本号）。
 */
async function generateSecMsGecToken() {
    const WIN_EPOCH = 11644473600n;
    const S_TO_NS = 10000000n;

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    let ticks = (nowSec + WIN_EPOCH) * S_TO_NS;

    // 取整到最近的 5 分钟
    const roundTo = 300n * 10000000n;
    ticks = (ticks / roundTo) * roundTo;

    const input = `${ticks}${EDGE_TTS_TRUSTED_CLIENT_TOKEN}`;
    const data = new TextEncoder().encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function generateConnectionId() {
    return crypto.randomUUID().replace(/-/g, '');
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
        let s = '';
        for (let j = 0; j < sub.length; j++) s += String.fromCharCode(sub[j]);
        chunks.push(s);
    }
    return btoa(chunks.join(''));
}

async function synthesizeWithWordBoundaries(text, voice, rate, pitch, volume, style) {
    const secMsGec = await generateSecMsGecToken();
    const connectionId = generateConnectionId();
    const requestId = generateConnectionId();

    // ★ 方案一：切换到 api.msedgeservices.com
    // token 必须作为 Ocp-Apim-Subscription-Key 传递，而非 TrustedClientToken
    const url =
        `https://${EDGE_TTS_NEW_HOST}${EDGE_TTS_NEW_PATH}` +
        `?Ocp-Apim-Subscription-Key=${EDGE_TTS_TRUSTED_CLIENT_TOKEN}` +
        `&Sec-MS-GEC=${secMsGec}` +
        `&Sec-MS-GEC-Version=${EDGE_TTS_SEC_MS_GEC_VERSION}` +
        `&ConnectionId=${connectionId}`;

    const resp = await fetch(url, {
        headers: {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Version': '13',
            'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
    });

    if (resp.status !== 101) {
        let detail = '';
        try { detail = await resp.text(); } catch (e) {}
        throw new Error(`WebSocket 升级失败 (HTTP ${resp.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }

    const ws = resp.webSocket;
    if (!ws) {
        throw new Error('WebSocket 升级失败：response.webSocket 为空');
    }

    try {
        ws.accept();
    } catch (e) {
        // 出站 WebSocket 可能已经 accepted，忽略
    }

    return new Promise((resolve, reject) => {
        const audioChunks = [];
        const wordBoundaries = [];
        let resolved = false;
        let pendingBinary = Promise.resolve();

        const cleanup = () => {
            try { ws.close(); } catch (e) {}
        };

        const fail = (err) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            reject(err);
        };

        const timeout = setTimeout(() => fail(new Error('Edge TTS 连接超时')), 25000);

        ws.addEventListener('message', (event) => {
            const data = event.data;

            // —— 文本帧：metadata / turn.end ——
            if (typeof data === 'string') {
                if (data.indexOf('Path:audio.metadata') !== -1) {
                    const jsonStart = data.indexOf('{');
                    if (jsonStart !== -1) {
                        try {
                            const meta = JSON.parse(data.slice(jsonStart));
                            if (meta && Array.isArray(meta.Metadata)) {
                                for (const item of meta.Metadata) {
                                    if (item.Type === 'WordBoundary' && item.Data) {
                                        wordBoundaries.push({
                                            text: item.Data.text && item.Data.text.Text ? item.Data.text.Text : '',
                                            offsetSec: item.Data.Offset / 10000000,
                                            durationSec: item.Data.Duration / 10000000
                                        });
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                }
                if (data.indexOf('Path:turn.end') !== -1) {
                    clearTimeout(timeout);
                    pendingBinary.then(() => {
                        if (resolved) return;
                        resolved = true;
                        cleanup();
                        resolve({ audioChunks, wordBoundaries });
                    });
                }
                return;
            }

            // —— 二进制帧：兼容 ArrayBuffer / TypedArray / Blob ——
            let bufferPromise;
            if (data instanceof ArrayBuffer) {
                bufferPromise = Promise.resolve(data);
            } else if (ArrayBuffer.isView(data)) {
                bufferPromise = Promise.resolve(
                    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                );
            } else if (data && typeof data.arrayBuffer === 'function') {
                bufferPromise = data.arrayBuffer();
            } else {
                return;
            }

            pendingBinary = pendingBinary.then(() => {
                return bufferPromise.then((buffer) => {
                    if (!buffer || buffer.byteLength < 2) return;
                    const view = new DataView(buffer);
                    const headerLength = view.getUint16(0, false);
                    if (buffer.byteLength < 2 + headerLength) return;
                    const headerText = new TextDecoder().decode(
                        new Uint8Array(buffer, 2, headerLength)
                    );
                    if (headerText.indexOf('Path:audio') !== -1) {
                        const audioData = buffer.slice(2 + headerLength);
                        if (audioData.byteLength > 0) {
                            audioChunks.push(audioData);
                        }
                    }
                });
            });
        });

        ws.addEventListener('close', (e) => {
            clearTimeout(timeout);
            if (!resolved) {
                pendingBinary.then(() => {
                    if (!resolved) {
                        if (audioChunks.length > 0) {
                            resolved = true;
                            resolve({ audioChunks, wordBoundaries });
                        } else {
                            fail(new Error(`Edge TTS 连接关闭 (code ${e.code}, reason: ${e.reason || 'unknown'})`));
                        }
                    }
                });
            }
        });

        ws.addEventListener('error', () => {
            clearTimeout(timeout);
            fail(new Error('Edge TTS WebSocket 错误事件'));
        });

        try {
            const configMsg = {
                context: {
                    synthesis: {
                        audio: {
                            metadataoptions: {
                                sentenceBoundaryEnabled: false,
                                wordBoundaryEnabled: true
                            },
                            outputFormat: EDGE_TTS_OUTPUT_FORMAT
                        }
                    }
                }
            };
            ws.send(
                `X-Timestamp:${Date.now() / 1000}\r\n` +
                `Content-Type:application/json; charset=utf-8\r\n` +
                `Path:speech.config\r\n\r\n` +
                JSON.stringify(configMsg)
            );

            const ssml = buildEdgeSSML(text, voice, rate, pitch, volume, style);

            ws.send(
                `X-RequestId:${requestId}\r\n` +
                `Content-Type:application/ssml+xml\r\n` +
                `X-Timestamp:${new Date().toISOString()}\r\n` +
                `Path:ssml\r\n\r\n` +
                ssml
            );
        } catch (e) {
            clearTimeout(timeout);
            fail(new Error('发送 SSML 失败: ' + e.message));
        }
    });
}

async function handleSpeechWithTimings(request) {
    try {
        const requestBody = await request.json();
        console.log('[speech-with-timings] input length:', requestBody.input?.length, 'voice:', requestBody.voice);
        const {
            input,
            voice = "zh-CN-XiaoxiaoNeural",
            speed = '1.0',
            volume = '0',
            pitch = '0',
            style = "general"
        } = requestBody;

        if (!input || !input.trim()) {
            return new Response(JSON.stringify({
                error: { message: "输入文本不能为空" }
            }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
            });
        }

        if (input.length > 2000) {
            return new Response(JSON.stringify({
                error: {
                    message: "文本过长（超过 2000 字符），请缩短文本或使用 /v1/audio/speech 普通模式"
                }
            }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
            });
        }

        const parsedSpeed = parseFloat(speed);
        const rate = isNaN(parsedSpeed) ? 0 : parseInt(String((parsedSpeed - 1.0) * 100));
        const parsedVolume = parseFloat(volume);
        const numVolume = isNaN(parsedVolume) ? 0 : parseInt(String(parsedVolume * 100));
        const parsedPitch = parseInt(pitch);
        const numPitch = isNaN(parsedPitch) ? 0 : parsedPitch;

        const rateStr = rate >= 0 ? `+${rate}%` : `${rate}%`;
        const pitchStr = numPitch >= 0 ? `+${numPitch}Hz` : `${numPitch}Hz`;
        const volumeStr = numVolume >= 0 ? `+${numVolume}%` : `${numVolume}%`;

        const { audioChunks, wordBoundaries } = await synthesizeWithWordBoundaries(
            input.trim(), voice, rateStr, pitchStr, volumeStr, style
        );

        if (!audioChunks.length) {
            throw new Error('Edge TTS 未返回任何音频数据');
        }

        let totalLength = 0;
        for (const chunk of audioChunks) totalLength += chunk.byteLength;
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of audioChunks) {
            merged.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
        }

        const base64Audio = arrayBufferToBase64(merged.buffer);

        return new Response(JSON.stringify({
            audio: base64Audio,
            format: 'audio/mpeg',
            wordBoundaries
        }), {
            headers: {
                "Content-Type": "application/json",
                ...makeCORSHeaders()
            }
        });

    } catch (error) {
        console.error("Speech with timings error:", error);
        console.error("Stack:", error.stack);
        return new Response(JSON.stringify({
            error: {
                message: error.message || String(error),
                type: "api_error",
                code: "edge_tts_timings_error"
            }
        }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
        });
    }
}
