require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { OpenAI } = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para servir archivos estáticos (index.html) y parsear JSON
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Configuración de Groq usando el SDK de OpenAI
const openai = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY
});

// Función auxiliar: intenta obtener metadata Y determina si la cuenta existe
// Retorna: { image, description, profileUrl, exists, blocked }
// - exists: true = cuenta confirmada, false = cuenta NO existe (404 real)
// - blocked: true = la plataforma nos bloqueó (no podemos confirmar existencia)
async function fetchMetadata(username, platform) {
    let image = null;
    let description = null;
    let profileUrl = '';
    let exists = false;   // por defecto asumimos que no existe hasta confirmarlo
    let blocked = false;  // indica que la plataforma nos bloqueó (no es 404)

    try {
        // ── YOUTUBE ──────────────────────────────────────────────────────────
        if (platform === 'youtube') {
            profileUrl = `https://www.youtube.com/@${username}`;
            // Un canal inexistente devuelve HTTP 404; uno existente devuelve 200
            const { data, status } = await axios.get(profileUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' },
                timeout: 6000,
                validateStatus: (s) => true // No lanzar error, capturar el status
            });

            if (status === 404) {
                // Canal inexistente confirmado
                exists = false;
            } else if (status === 200) {
                const $ = cheerio.load(data);
                image = $('meta[property="og:image"]').attr('content') || null;
                description = $('meta[property="og:description"]').attr('content') || null;
                // YouTube siempre tiene og:image si el canal existe
                exists = !!image;
            } else {
                // Bloqueado (429, 503, etc.) — no podemos confirmar, asumimos que existe
                blocked = true;
                exists = true;
            }
        }

        // ── TIKTOK ───────────────────────────────────────────────────────────
        else if (platform === 'tiktok') {
            profileUrl = `https://www.tiktok.com/@${username}`;

            // Intento 1: API de tikwm (más rápida y con más datos)
            try {
                const { data } = await axios.get(
                    `https://www.tikwm.com/api/user/info?unique_id=${username}`,
                    { timeout: 6000 }
                );

                if (data && data.code === 0 && data.data && data.data.user) {
                    image = data.data.user.avatarThumb || data.data.user.avatarMedium || null;
                    description = data.data.user.signature || null;
                    exists = true; // Confirmado por tikwm
                } else {
                    // tikwm respondió pero dice que el usuario no existe
                    exists = false;
                }
            } catch (tikwmError) {
                // tikwm falló (timeout, red, etc.) → verificar directamente en TikTok
                console.log(`tikwm falló para @${username}, verificando en tiktok.com...`);
                try {
                    const { status } = await axios.get(profileUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' },
                        timeout: 7000,
                        validateStatus: (s) => true
                    });

                    if (status === 404) {
                        exists = false; // TikTok confirmó que no existe
                    } else if (status === 200) {
                        // La página cargó — el usuario existe aunque no tengamos datos extra
                        exists = true;
                        blocked = true; // Sin datos de descripción/imagen
                    } else {
                        // Bloqueados por TikTok (redirect, captcha, etc.)
                        blocked = true;
                        exists = true;
                    }
                } catch (tiktokPageError) {
                    console.log(`También falló tiktok.com: ${tiktokPageError.message}`);
                    blocked = true;
                    exists = true; // En caso de total duda, no bloqueamos
                }
            }
        }

        // ── INSTAGRAM ────────────────────────────────────────────────────────
        else if (platform === 'instagram') {
            profileUrl = `https://www.instagram.com/${username}/`;
            const { data, status } = await axios.get(
                `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
                {
                    headers: {
                        'X-IG-App-ID': '936619743392459',
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
                        'Accept': 'application/json'
                    },
                    timeout: 6000,
                    validateStatus: (s) => true // Capturar todos los status
                }
            );

            if (status === 200 && data && data.data && data.data.user) {
                // Usuario encontrado y la API respondió con datos
                image = data.data.user.profile_pic_url_hd || data.data.user.profile_pic_url || null;
                description = data.data.user.biography || null;
                exists = true; // Confirmado
            } else if (status === 404) {
                // La API devuelve 404 explícito cuando el username no existe
                exists = false;
            } else {
                // 401 / 403 / 429 = Instagram nos bloqueó, pero el usuario PUEDE existir
                // En este caso, asumimos que existe para no dar falsos negativos
                console.log(`Instagram bloqueó la solicitud (HTTP ${status}), asumiendo que existe.`);
                blocked = true;
                exists = true;
            }
        }

    } catch (error) {
        // Error de red (timeout, ECONNREFUSED, etc.) — no podemos confirmar
        console.log(`Error de red para ${platform}/@${username}: ${error.message}`);
        blocked = true;
        exists = true; // En caso de duda, no bloqueamos al usuario
    }

    // Fallback de imagen solo si la cuenta existe pero no obtuvimos foto
    if (exists && !image) {
        if (platform === 'youtube')   image = `https://unavatar.io/youtube/${username}`;
        if (platform === 'instagram') image = `https://unavatar.io/instagram/${username}`;
    }

    return { image, description, profileUrl, exists, blocked };
}

// Ruta principal para el análisis
app.post('/api/analyze', async (req, res) => {
    const { username, platform } = req.body;

    if (!username || !platform) {
        return res.status(400).json({ error: 'Falta el nombre de usuario o la plataforma' });
    }

    // Limpiar el username (remover '@' si lo escriben)
    const cleanUsername = username.replace(/^@/, '');

    console.log(`Analizando ${platform}: ${cleanUsername}`);

    // Extraer imagen, descripción y flag de existencia
    const { image, description, profileUrl, exists, blocked } = await fetchMetadata(cleanUsername, platform);

    // Si la plataforma confirmó con certeza que el usuario NO existe → 404
    // Si "blocked" es true, pasamos de largo (no sabemos con certeza si existe o no)
    if (!exists && !blocked) {
        console.log(`Cuenta no encontrada (confirmado): ${platform} @${cleanUsername}`);
        return res.status(404).json({
            error: '❌ No se encontró esa cuenta. Por favor, revisa el nombre e inténtalo de nuevo.'
        });
    }

    // Prompt estricto con rol de Juez/Auditor de redes sociales
    const systemPrompt = `Eres el "Juez Cínico de Perfiles", una IA auditora especializada EXCLUSIVAMENTE en analizar perfiles de redes sociales.

PERFIL A ANALIZAR:
- Plataforma: ${platform}
- Nombre de usuario EXACTO: @${cleanUsername}
${description ? `- Biografía del perfil: "${description}"` : `- Sin biografía disponible.`}

REGLAS ABSOLUTAS SIN EXCEPCIÓN:
1. El usuario que estás analizando se llama EXACTAMENTE "@${cleanUsername}". JAMÁS menciones ni inventes otro nombre de usuario diferente.
2. Lánzate DIRECTAMENTE a la crítica. NO hagas preguntas. NO pidas más información. NO digas que "no tienes acceso" a datos. Ya tienes toda la información que necesitas.
3. Si no hay biografía, basa tu crítica en el nombre de usuario "${cleanUsername}" — analiza qué dice ese nombre sobre la persona, qué tipo de persona pondría ese nombre, etc. Sé sarcástico y creativo.
4. NO uses asteriscos (**). Texto plano únicamente.
5. Escribe exactamente 2 o 3 párrafos de crítica y luego termina.
6. En el chat posterior, si alguien habla de un tema que NO sea analizar perfiles de redes sociales, responde SIEMPRE: "No puedo ayudarte con eso. Soy el Juez Cínico de Perfiles, una auditora de Instagram, TikTok y YouTube. ¿Tienes alguna queja sobre mi veredicto?"`;

    try {
        const completion = await openai.chat.completions.create({
            messages: [{ role: 'system', content: systemPrompt }],
            model: 'llama-3.1-8b-instant',
            max_tokens: 3000,
            temperature: 0.8
        });

        const roastText = completion.choices[0].message.content;

        // Responder al frontend
        res.json({
            imageUrl: image,
            roast: roastText,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'assistant', content: roastText }
            ]
        });
    } catch (error) {
        console.error('Error con IA:', error);
        res.status(500).json({ error: 'Fallo al conectar con la red neuronal de Groq.' });
    }
});

// Ruta para continuar el chat
app.post('/api/chat', async (req, res) => {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Formato de mensajes inválido.' });
    }

    // Reforzar el rol del Juez en cada mensaje del chat para evitar desvíos de tema
    const reinforcedMessages = messages.map((msg, index) => {
        if (index === 0 && msg.role === 'system') {
            // Asegurarse de que el system prompt siempre tenga la restricción de tema
            const restriction = `\n\nREGLA ABSOLUTA E INQUEBRANTABLE: Solo puedes hablar sobre análisis de perfiles de redes sociales (Instagram, TikTok, YouTube). Si el usuario habla de CUALQUIER otro tema (política, comida, tecnología, filosofía, código, etc.), DEBES responder EXACTAMENTE con: "No puedo ayudarte con eso. Soy el Juez Cínico de Perfiles, una auditora especializada en Instagram, TikTok y YouTube. ¿Tienes alguna queja sobre mi veredicto o quieres analizar otro perfil?" Sin excepciones.`;
            return { ...msg, content: msg.content + restriction };
        }
        return msg;
    });

    try {
        const completion = await openai.chat.completions.create({
            messages: reinforcedMessages,
            model: 'llama-3.1-8b-instant',
            max_tokens: 3000,
            temperature: 0.8
        });

        res.json({
            reply: completion.choices[0].message.content
        });
    } catch (error) {
        console.error('Error en Chat:', error);
        res.status(500).json({ error: 'Error procesando tu respuesta en la IA.' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
